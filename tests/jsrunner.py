#!/usr/bin/env python3
"""
Headless test runner for ATexVisualEditor's browser modules.

The app itself has no build step (plain ES modules loaded straight from
`web/`).  This runner gives us the same modules under QuickJS so the LaTeX
core can be tested without a browser:

  * `bundle()` resolves relative `import` statements by concatenating modules
    in dependency order (the app keeps every local import on a single line,
    which is what makes this simple rewrite safe),
  * `export` keywords are stripped (everything shares one scope),
  * a tiny harness (`test`/`assert*`) is injected, then the results are read
    back as JSON.

Usage:
    python3 tests/jsrunner.py                 # run every tests/*.test.js
    python3 tests/jsrunner.py tests/x.test.js # run one file
    python3 tests/jsrunner.py -v              # show passing assertions too
"""

from __future__ import annotations

import json
import os
import re
import sys

try:
    import quickjs
except ImportError:  # pragma: no cover
    print("quickjs is required:  pip3 install quickjs", file=sys.stderr)
    raise SystemExit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")

# `import ... from "..."` — the clause may span lines.
IMPORT_STMT_RE = re.compile(
    r"""^[ \t]*import\s+(?P<clause>.*?)\s*from\s*['"](?P<spec>[^'"]+)['"]\s*;?[ \t]*$""",
    re.MULTILINE | re.DOTALL,
)
EXPORT_LIST_RE = re.compile(r"^[ \t]*export\s*\{(?P<names>[^}]*)\}\s*;?[ \t]*$", re.MULTILINE)
EXPORT_DECL_RE = re.compile(
    r"^[ \t]*export\s+(?:default\s+)?(?=(?:const|let|var|function|async|class|new)\b)",
    re.MULTILINE,
)
EXPORTED_NAME_RE = re.compile(
    r"^[ \t]*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


class BundleError(RuntimeError):
    pass


def resolve(spec: str, importer: str) -> str:
    """Resolve a relative import specifier to an absolute path."""
    if not spec.startswith("."):
        raise BundleError(
            f"bare import {spec!r} in {os.path.relpath(importer, ROOT)} — "
            "the test runner can only resolve relative paths"
        )
    path = os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    if not os.path.exists(path):
        raise BundleError(f"cannot resolve {spec!r} from {os.path.relpath(importer, ROOT)}")
    return path


def parse_clause(clause: str) -> list[tuple[str, str]]:
    """
    Parse the part between `import` and `from`.
    Returns [(kind, payload)] where kind is 'ns', 'default', or ('named', ...).
    """
    clause = clause.strip()
    out: list[tuple[str, str]] = []
    if not clause:
        return out
    if clause.startswith("*"):
        m = re.match(r"\*\s*as\s+([\w$]+)", clause)
        if not m:
            raise BundleError(f"cannot parse import clause {clause!r}")
        out.append(("ns", m.group(1)))
        return out
    if clause.startswith("{"):
        pass
    else:
        # default import, possibly followed by named bindings
        head, sep, rest = clause.partition(",")
        out.append(("default", head.strip()))
        clause = rest.strip() if sep else ""
    if clause.startswith("{"):
        names = clause.strip().lstrip("{").rstrip("}").strip()
        for item in names.split(","):
            item = item.strip()
            if not item:
                continue
            if " as " in item:
                src, dst = [p.strip() for p in item.split(" as ", 1)]
                out.append(("named", f"{src}:{dst}"))
            else:
                out.append(("named", f"{item}:{item}"))
    return out


IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
EXPORT_FORMS = [
    re.compile(r"\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)"),
    re.compile(r"\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"),
    re.compile(r"\s*class\s+([A-Za-z_$][\w$]*)"),
]


def _skip_string(source: str, i: int) -> int:
    """Index just past the string literal starting at `i`."""
    quote = source[i]
    i += 1
    n = len(source)
    while i < n:
        c = source[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        if c == "\n" and quote != "`":
            return i
        i += 1
    return n


def _skip_regex(source: str, i: int) -> int:
    """Index just past a regex literal starting at `/` (which is not a division)."""
    n = len(source)
    i += 1
    in_class = False
    while i < n:
        c = source[i]
        if c == "\\":
            i += 2
            continue
        if c == "\n":
            return i
        if in_class:
            if c == "]":
                in_class = False
        elif c == "[":
            in_class = True
        elif c == "/":
            return i + 1
        i += 1
    return n


# A `/` starts a regex literal unless the preceding token cannot end an
# expression.  This is the standard heuristic used by JS lexers for the
# division/regex ambiguity.
REGEX_ALLOWED_AFTER = set("(,=:[!&|?{};+-*%~^<>")


def _last_significant(source: str, i: int) -> str:
    j = i - 1
    while j >= 0 and source[j] in " \t\r\n":
        j -= 1
    return source[j] if j >= 0 else ""


def _top_level_export_positions(source: str) -> list[int]:
    """
    Offsets of `export` keywords that are *not* nested inside a function or
    object literal.  Brace depth alone is not enough (object literals look the
    same), but combined with the earlier `export` prefix of the declaration
    form it is accurate for our code style.
    """
    positions: list[int] = []
    depth = 0
    i = 0
    n = len(source)
    while i < n:
        c = source[i]
        if c in "'\"`":
            i = _skip_string(source, i)
            continue
        if c == "/" and i + 1 < n and source[i + 1] == "/":
            j = source.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c == "/" and i + 1 < n and source[i + 1] == "*":
            j = source.find("*/", i)
            i = n if j < 0 else j + 2
            continue
        if c == "/" and _last_significant(source, i) in REGEX_ALLOWED_AFTER | {""}:
            i = _skip_regex(source, i)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        elif (
            depth == 0
            and source.startswith("export", i)
            and not (i > 0 and IDENT_RE.fullmatch(source[i - 1]))
            and not IDENT_RE.match(source[i + 6 : i + 7] or "")
        ):
            positions.append(i)
            i += 6
            continue
        i += 1
    return positions


def collect_exports(source: str) -> list[tuple[str, str]]:
    """Return [(exported_name, local_expression)] for one module body."""
    exports: list[tuple[str, str]] = []
    for pos in _top_level_export_positions(source):
        rest = source[pos + 6 :]
        rest = re.sub(r"^\s*default\s+", "", rest)
        stripped = rest.lstrip()
        if stripped.startswith("{"):
            close = stripped.find("}")
            if close < 0:
                continue
            body = stripped[1:close]
            for item in body.split(","):
                item = item.strip()
                if not item:
                    continue
                if " as " in item:
                    local, exported = [p.strip() for p in item.split(" as ", 1)]
                    exports.append((exported, local))
                else:
                    exports.append((item, item))
            continue
        for form in EXPORT_FORMS:
            m = form.match(rest)
            if m:
                exports.append((m.group(1), m.group(1)))
                break
    return exports


def module_body(source: str, var: str, path: str) -> str:
    """Rewrite one module into an IIFE that returns its namespace object."""
    stmts: list[str] = []

    def repl(match: re.Match) -> str:
        dep_var = module_var(resolve(match.group("spec"), path))
        for kind, payload in parse_clause(match.group("clause")):
            if kind == "ns":
                stmts.append(f"const {payload} = {dep_var};")
            elif kind == "default":
                stmts.append(f"const {payload} = {dep_var}.default;")
            else:
                local, imported = payload.split(":")
                stmts.append(f"const {imported} = {dep_var}.{local};")
        return ""

    rewritten = IMPORT_STMT_RE.sub(repl, source)
    rewritten = EXPORT_LIST_RE.sub("", rewritten)
    rewritten = EXPORT_DECL_RE.sub("", rewritten)
    exports = collect_exports(source)
    ret = ""
    if exports:
        pairs = ", ".join(f"{exported}: {local}" for exported, local in exports)
        ret = f"\nreturn {{ {pairs} }};\n"
    prelude = "\n".join(stmts)
    header = f"\n// ==== {os.path.relpath(path, ROOT)} ====\n"
    return f"{header}const {var} = (() => {{\n{prelude}\n{rewritten}\n{ret}}})();\n"


def module_var(path: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]", "_", os.path.relpath(path, ROOT))
    return "__mod_" + safe


def bundle(entries: list[str]) -> str:
    """
    Concatenate `entries` and their relative dependencies into one script.

    Modules are emitted in dependency order (post-order DFS) and wrapped in an
    IIFE, so a module's namespace object is always initialised before the
    modules that import it.
    """
    order: list[str] = []
    state: dict[str, int] = {}  # realpath -> 1 visiting, 2 done

    def include(path: str) -> None:
        real = os.path.realpath(path)
        if state.get(real) == 2:
            return
        if state.get(real) == 1:
            raise BundleError(
                f"import cycle through {os.path.relpath(path, ROOT)} — "
                "the test bundler requires an acyclic import graph"
            )
        state[real] = 1
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        for match in IMPORT_STMT_RE.finditer(source):
            include(resolve(match.group("spec"), path))
        state[real] = 2
        order.append(path)

    for entry in entries:
        include(os.path.abspath(entry))

    chunks: list[str] = []
    for path in order:
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        chunks.append(module_body(source, module_var(path), path))
    return "\n".join(chunks)


HARNESS = r"""
'use strict';
const __TESTS__ = [];
const __STATE__ = { current: null, failures: [], passed: 0 };

function test(name, fn) { __TESTS__.push({ name, fn }); }

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v && typeof v === 'object') {
    try { return JSON.stringify(v).slice(0, 400); } catch (e) { return String(v); }
  }
  return String(v);
}

function fail(msg) {
  const err = new Error(msg);
  err.__assert = true;
  throw err;
}

function ok(cond, msg) { if (!cond) fail(msg || 'expected truthy, got ' + fmt(cond)); }

function eq(actual, expected, msg) {
  if (actual !== expected) {
    fail((msg ? msg + ': ' : '') + 'expected ' + fmt(expected) + ' but got ' + fmt(actual));
  }
}

function deepEq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) fail((msg ? msg + ': ' : '') + 'expected ' + b + ' but got ' + a);
}

function near(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) {
    fail((msg ? msg + ': ' : '') + 'expected ' + expected + '+/-' + tol + ' but got ' + actual);
  }
}

function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  if (!threw) fail(msg || 'expected function to throw');
}

function runAll() {
  const results = [];
  for (const t of __TESTS__) {
    const started = Date.now();
    try {
      t.fn({ test, ok, eq, deepEq, near, throws, fail, fmt });
      results.push({ name: t.name, ok: true, ms: Date.now() - started });
    } catch (e) {
      results.push({
        name: t.name,
        ok: false,
        ms: Date.now() - started,
        error: (e && e.message) ? e.message : String(e),
        stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : '',
      });
    }
  }
  return results;
}
"""

DRIVER = r"""
globalThis.__RESULTS__ = JSON.stringify(runAll());
"""


def run(entries: list[str], verbose: bool = False) -> int:
    script = HARNESS + bundle(entries) + DRIVER
    ctx = quickjs.Context()
    ctx.add_callable("__print", lambda s: print(s))
    ctx.eval("globalThis.console = globalThis.console || { log: __print, warn: __print, error: __print };")
    try:
        ctx.eval(script)
    except Exception as exc:  # syntax/runtime error while loading modules
        print("!! failed to evaluate the bundle:", file=sys.stderr)
        print(exc, file=sys.stderr)
        line = None
        match = re.search(r"<input>:(\d+)", str(exc))
        if match:
            line = int(match.group(1))
        if line:
            lines = script.split("\n")
            for n in range(max(0, line - 6), min(len(lines), line + 3)):
                marker = ">>" if n == line - 1 else "  "
                print(f"{marker} {n + 1:5d} {lines[n]}", file=sys.stderr)
        return 2

    results = json.loads(ctx.eval("globalThis.__RESULTS__"))
    passed = sum(1 for r in results if r["ok"])
    failed = [r for r in results if not r["ok"]]
    for r in results:
        if r["ok"] and verbose:
            print(f"  \033[32mPASS\033[0m {r['name']} ({r['ms']}ms)")
        elif not r["ok"]:
            print(f"  \033[31mFAIL\033[0m {r['name']}")
            print(f"       {r['error']}")
            if r.get("stack"):
                for sline in r["stack"].split("\n")[1:]:
                    print(f"       {sline.strip()}")
    print()
    total = len(results)
    colour = "\033[32m" if not failed else "\033[31m"
    print(f"{colour}{passed}/{total} passed\033[0m" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv[1:]
    if args:
        entries = args
    else:
        entries = sorted(
            os.path.join(HERE, f)
            for f in os.listdir(HERE)
            if f.endswith(".test.js")
        )
    if not entries:
        print("no test files found", file=sys.stderr)
        return 2
    print(f"Running {len(entries)} test file(s) under QuickJS\n")
    return run(entries, verbose)


if __name__ == "__main__":
    raise SystemExit(main())
