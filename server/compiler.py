"""
ATexVisualEditor — LaTeX compilation and PDF rasterisation.

Everything here shells out to the TeX distribution that is already installed on
the machine (TeX Live / MiKTeX / MacTeX): no bundled TeX, no network.  The
module is deliberately dependency-free (Python standard library only) so the
whole application runs from a checkout on any of the three desktop platforms.

Responsibilities:
  * detect which engines, drivers and PDF tools are available,
  * run a build inside the project directory with artifacts in `.atex/build/<id>`,
  * turn a TeX log into structured diagnostics that the editor can click on,
  * rasterise PDF pages to SVG (crisp at any zoom) and PNG,
  * answer SyncTeX forward/inverse queries so source, visual and PDF views can
    follow each other.

Security note: `-shell-escape` is off unless the project explicitly opts in,
because it lets a document execute arbitrary commands.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

BUILD_DIRNAME = ".atex"
DEFAULT_TIMEOUT = 180


# ---------------------------------------------------------------------------
# Tool detection
# ---------------------------------------------------------------------------


def _which(name: str) -> str | None:
    return shutil.which(name)


def _version_of(cmd: list[str]) -> str:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return ""
    text = (proc.stdout or "") + (proc.stderr or "")
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:160]
    return ""


@dataclass
class Engine:
    id: str
    label: str
    program: str
    description: str = ""
    available: bool = False
    version: str = ""
    path: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "program": self.program,
            "description": self.description,
            "available": self.available,
            "version": self.version,
        }


ENGINE_SPECS = [
    ("pdflatex", "pdfLaTeX", "pdflatex", "Fastest; classic fonts, no Unicode input"),
    ("xelatex", "XeLaTeX", "xelatex", "Unicode input and system fonts"),
    ("lualatex", "LuaLaTeX", "lualatex", "Unicode plus Lua scripting"),
]


class Toolchain:
    """What this machine can actually do — computed once at start-up."""

    def __init__(self) -> None:
        self.engines: list[Engine] = []
        for eid, label, program, desc in ENGINE_SPECS:
            path = _which(program)
            engine = Engine(id=eid, label=label, program=program, description=desc)
            if path:
                engine.available = True
                engine.path = path
                engine.version = _version_of([program, "--version"])
            self.engines.append(engine)

        self.latexmk = _which("latexmk")
        self.latexmk_version = _version_of(["latexmk", "-v"]) if self.latexmk else ""
        self.bibtex = _which("bibtex")
        self.biber = _which("biber")
        self.pdfinfo = _which("pdfinfo")
        self.pdftoppm = _which("pdftoppm")
        self.pdftocairo = _which("pdftocairo")
        self.dvisvgm = _which("dvisvgm")
        self.synctex = _which("synctex")
        self.chktex = _which("chktex")
        self.kpsewhich = _which("kpsewhich")
        self.texmf = _version_of(["kpsewhich", "-var-value", "TEXMFDIST"]) if self.kpsewhich else ""

    @property
    def available_engines(self) -> list[Engine]:
        return [e for e in self.engines if e.available]

    @property
    def default_engine(self) -> str:
        for e in self.available_engines:
            if e.id == "pdflatex":
                return e.id
        return self.available_engines[0].id if self.available_engines else "pdflatex"

    def engine(self, engine_id: str) -> Engine | None:
        for e in self.engines:
            if e.id == engine_id:
                return e
        return None

    def has_tex(self) -> bool:
        return bool(self.available_engines)

    def to_json(self) -> dict[str, Any]:
        return {
            "engines": [e.to_json() for e in self.engines],
            "defaultEngine": self.default_engine,
            "hasTex": self.has_tex(),
            "latexmk": bool(self.latexmk),
            "bibtex": bool(self.bibtex),
            "biber": bool(self.biber),
            "pdfinfo": bool(self.pdfinfo),
            "pdftoppm": bool(self.pdftoppm),
            "pdftocairo": bool(self.pdftocairo),
            "dvisvgm": bool(self.dvisvgm),
            "synctex": bool(self.synctex),
            "chktex": bool(self.chktex),
            "texmf": self.texmf,
            "latexmkVersion": self.latexmk_version,
            # SVG pages are the nicest preview: vector, crisp at every zoom.
            "svgPreview": bool(self.pdftocairo),
            "pngPreview": bool(self.pdftoppm),
        }


TOOLCHAIN = Toolchain()


# ---------------------------------------------------------------------------
# Log parsing
# ---------------------------------------------------------------------------

# With `-file-line-error`, TeX emits:  ./chapter.tex:42: Undefined control sequence.
FILE_LINE_RE = re.compile(r"^(?P<file>[^:\n]+?):(?P<line>\d+):\s*(?P<message>.*)$")
# Classic form: "! LaTeX Error: Something bad." followed by "l.42 \badcmd"
BANG_RE = re.compile(r"^!\s*(?P<message>.*)$")
LINE_CONTEXT_RE = re.compile(r"^l\.(?P<line>\d+)\s*(?P<context>.*)$")
WARNING_RE = re.compile(
    r"^(?P<kind>LaTeX|Package|Class|pdfTeX|Font)\s+(?:(?P<package>[\w@.\-]+)\s+)?Warning:\s*(?P<message>.*)$"
)
BADBOX_RE = re.compile(r"^(?P<kind>Overfull|Underfull)\s+\\[hv]box\s*(?:\((?P<severity>[^)]*)\))?\s*(?:.*?at lines?\s*(?P<lines>[\d\-–]+))?")
MISSING_FILE_RE = re.compile(r"File [`'\"](?P<file>[^'\"]+)['\"] not found")
RERUN_RE = re.compile(r"Rerun to get|Rerun LaTeX|Please rerun", re.IGNORECASE)
UNDEFINED_REF_RE = re.compile(r"Reference [`'\"](?P<name>[^'\"]+)['\"] on page (?P<page>\d+) undefined")
UNDEFINED_CITE_RE = re.compile(r"Citation [`'\"](?P<name>[^'\"]+)['\"] on page (?P<page>\d+) undefined")


@dataclass
class Diagnostic:
    severity: str  # 'error' | 'warning' | 'info'
    message: str
    file: str = ""
    line: int = 0
    context: str = ""
    kind: str = ""  # 'latex' | 'badbox' | 'missing-file' | ...
    log_index: int = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "severity": self.severity,
            "message": self.message,
            "file": self.file,
            "line": self.line,
            "context": self.context,
            "kind": self.kind,
            "logIndex": self.log_index,
        }


def parse_log(log: str, main_file: str) -> list[Diagnostic]:
    """
    Turn a TeX log into a list of diagnostics.

    TeX logs are famously irregular, so several strategies run in parallel and
    the results are deduplicated.  Anything unrecognised is left in the raw log
    for the user to read.
    """
    diags: list[Diagnostic] = []
    lines = log.splitlines()

    for index, raw in enumerate(lines):
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            continue

        # 1. file:line: message   (from -file-line-error)
        m = FILE_LINE_RE.match(stripped)
        if m and not stripped.startswith("!"):
            message = m.group("message").strip()
            if message and not message.startswith(("Overfull", "Underfull", "(")):
                diags.append(
                    Diagnostic(
                        severity="error",
                        message=message,
                        file=_normalise_file(m.group("file"), main_file),
                        line=int(m.group("line")),
                        kind="latex",
                        log_index=index,
                    )
                )
                continue

        # 2. ! message  (+ optional l.NN context on a following line)
        m = BANG_RE.match(stripped)
        if m:
            message = m.group("message").strip()
            file_name, line_no, context = "", 0, ""
            for probe in range(index + 1, min(index + 6, len(lines))):
                follow = lines[probe]
                fm = FILE_LINE_RE.match(follow.strip())
                if fm and fm.group("file").endswith((".tex", ".sty", ".cls")):
                    file_name = _normalise_file(fm.group("file"), main_file)
                    line_no = int(fm.group("line"))
                    break
                lm = LINE_CONTEXT_RE.match(follow)
                if lm:
                    line_no = int(lm.group("line"))
                    context = lm.group("context").strip()
                    break
            diags.append(
                Diagnostic(
                    severity="error",
                    message=message or "LaTeX error",
                    file=file_name or main_file,
                    line=line_no,
                    context=context,
                    kind="latex",
                    log_index=index,
                )
            )
            continue

        # 3. Warnings
        m = WARNING_RE.match(stripped)
        if m:
            message = m.group("message").strip()
            file_name, line_no = _find_source_position(lines, index, main_file)
            um = UNDEFINED_REF_RE.search(message)
            cm = UNDEFINED_CITE_RE.search(message)
            kind = "latex"
            if um:
                kind = "undefined-reference"
                message = f"Reference “{um.group('name')}” is undefined"
            elif cm:
                kind = "undefined-citation"
                message = f"Citation “{cm.group('name')}” is undefined"
            elif "there were undefined references" in message.lower():
                continue
            diags.append(
                Diagnostic(
                    severity="warning",
                    message=message,
                    file=file_name,
                    line=line_no,
                    kind=kind,
                    log_index=index,
                )
            )
            continue

        # 4. Missing files — by far the most common real-world breakage.
        m = MISSING_FILE_RE.search(stripped)
        if m:
            diags.append(
                Diagnostic(
                    severity="error" if "not found" in stripped else "warning",
                    message=f"File “{m.group('file')}” not found",
                    file=main_file,
                    kind="missing-file",
                    log_index=index,
                )
            )
            continue

        # 5. Bad boxes, folded into a single summary later on.
        m = BADBOX_RE.match(stripped)
        if m:
            where = ""
            if m.group("lines"):
                where = f" at line {m.group('lines').split('-')[0].split('–')[0]}"
            line_no = 0
            if m.group("lines"):
                try:
                    line_no = int(re.split(r"[-–]", m.group("lines"))[0])
                except ValueError:
                    line_no = 0
            diags.append(
                Diagnostic(
                    severity="info",
                    message=f"{m.group('kind')} box{where}",
                    file=main_file,
                    line=line_no,
                    kind="badbox",
                    log_index=index,
                )
            )

    return _dedupe(diags)


def _normalise_file(name: str, main_file: str) -> str:
    name = name.strip().strip("()")
    for prefix in ("./", ".\\"):
        if name.startswith(prefix):
            name = name[len(prefix) :]
    if not name:
        return main_file
    if os.path.isabs(name):
        return os.path.basename(name)
    return name


def _find_source_position(lines: list[str], index: int, main_file: str) -> tuple[str, int]:
    """Look backwards/forwards for the file:line that a warning belongs to."""
    for probe in range(index - 1, max(-1, index - 12), -1):
        m = FILE_LINE_RE.match(lines[probe].strip())
        if m and not m.group("message").strip():
            return _normalise_file(m.group("file"), main_file), int(m.group("line"))
    for probe in range(index + 1, min(len(lines), index + 6)):
        m = LINE_CONTEXT_RE.match(lines[probe])
        if m:
            return main_file, int(m.group("line"))
    return main_file, 0


def _dedupe(diags: Iterable[Diagnostic]) -> list[Diagnostic]:
    seen: set[tuple[str, str, int]] = set()
    out: list[Diagnostic] = []
    for d in diags:
        key = (d.severity, d.message, d.line)
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    # Errors first, then warnings; bad boxes stay last and are capped.
    order = {"error": 0, "warning": 1, "info": 2}
    out.sort(key=lambda d: (order.get(d.severity, 3), d.line))
    badboxes = [d for d in out if d.kind == "badbox"]
    if len(badboxes) > 40:
        keep = set(id(d) for d in badboxes[:40])
        out = [d for d in out if d.kind != "badbox" or id(d) in keep]
    return out


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


@dataclass
class BuildResult:
    build_id: str
    ok: bool
    has_pdf: bool
    engine: str
    duration_ms: int
    diagnostics: list[Diagnostic] = field(default_factory=list)
    log: str = ""
    pages: int = 0
    page_sizes: list[dict[str, float]] = field(default_factory=list)
    return_code: int = 0
    timed_out: bool = False
    build_dir: str = ""

    def to_json(self, *, include_log: bool = True) -> dict[str, Any]:
        data = {
            "buildId": self.build_id,
            "ok": self.ok,
            "hasPdf": self.has_pdf,
            "engine": self.engine,
            "durationMs": self.duration_ms,
            "diagnostics": [d.to_json() for d in self.diagnostics],
            "pages": self.pages,
            "pageSizes": self.page_sizes,
            "returnCode": self.return_code,
            "timedOut": self.timed_out,
            "errorCount": sum(1 for d in self.diagnostics if d.severity == "error"),
            "warningCount": sum(1 for d in self.diagnostics if d.severity == "warning"),
        }
        if include_log:
            data["log"] = self.log
        return data


class CompileError(RuntimeError):
    pass


class Builder:
    """Runs one build at a time per project directory."""

    _locks: dict[str, threading.Lock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, project_dir: str, toolchain: Toolchain = TOOLCHAIN) -> None:
        self.project_dir = os.path.abspath(project_dir)
        self.tools = toolchain

    @classmethod
    def lock_for(cls, project_dir: str) -> threading.Lock:
        key = os.path.abspath(project_dir)
        with cls._locks_guard:
            if key not in cls._locks:
                cls._locks[key] = threading.Lock()
            return cls._locks[key]

    # -- paths ---------------------------------------------------------------

    @property
    def build_root(self) -> str:
        return os.path.join(self.project_dir, BUILD_DIRNAME, "build")

    def build_dir(self, build_id: str) -> str:
        return os.path.join(self.build_root, build_id)

    def latest_pointer(self) -> str:
        return os.path.join(self.project_dir, BUILD_DIRNAME, "latest.json")

    def latest_build_id(self) -> str | None:
        try:
            with open(self.latest_pointer(), "r", encoding="utf-8") as fh:
                return json.load(fh).get("buildId")
        except (OSError, ValueError):
            return None

    def _write_latest(self, build_id: str, main_file: str) -> None:
        path = self.latest_pointer()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"buildId": build_id, "mainFile": main_file, "at": time.time()}, fh)
        os.replace(tmp, path)

    def _mirror_source_dirs(self, out_dir: str) -> None:
        """
        Recreate every source subdirectory inside the build output directory.

        `\include{chapters/methods}` writes `chapters/methods.aux` *relative to
        the output directory*, and TeX refuses to create the folder itself —
        without this, any multi-file document fails with "I can't write on
        file `chapters/x.aux'".
        """
        for root, dirs, files in os.walk(self.project_dir):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            if not any(name.endswith(".tex") for name in files):
                continue
            rel = os.path.relpath(root, self.project_dir)
            if rel == ".":
                continue
            try:
                os.makedirs(os.path.join(out_dir, rel), exist_ok=True)
            except OSError:
                pass

    # -- running things ------------------------------------------------------

    def _run(self, cmd: list[str], timeout: int, cwd: str | None = None) -> tuple[int, str, bool]:
        """Run a command, returning (returncode, combined output, timed_out)."""
        env = dict(os.environ)
        # Keep TeX non-interactive, reproducible, and able to find project-local
        # .bib/.bst/.sty files even when the working directory is the build dir
        # (bibtex runs there; pdflatex runs in the project root).
        env.setdefault("TEXMFVAR", os.path.join(self.project_dir, BUILD_DIRNAME, "texmfvar"))
        env["SOURCE_DATE_EPOCH"] = "0"
        env["FORCE_SOURCE_DATE"] = "1"
        # Prepending the project directory lets `\input{chapters/x}` and
        # `\bibliography{references}` resolve relative to the document even when
        # a tool runs with the build directory as its working directory.  The
        # *trailing* empty element is essential: in kpathsea it means "and the
        # standard search path", without which article.cls would not be found.
        for var in ("BIBINPUTS", "BSTINPUTS", "TEXINPUTS"):
            env[var] = os.pathsep.join([self.project_dir, ".", env.get(var, "")])
        try:
            proc = subprocess.run(
                cmd,
                cwd=cwd or self.project_dir,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired as exc:
            partial = ""
            for stream in (exc.stdout, exc.stderr):
                if not stream:
                    continue
                partial += stream if isinstance(stream, str) else stream.decode("utf-8", "replace")
            return -1, partial, True
        except OSError as exc:
            raise CompileError(f"could not run {cmd[0]}: {exc}") from exc
        return proc.returncode, (proc.stdout or "") + (proc.stderr or ""), False

    # -- the build -----------------------------------------------------------

    def build(
        self,
        main_file: str,
        engine: str = "pdflatex",
        *,
        synctex: bool = True,
        timeout: int = DEFAULT_TIMEOUT,
        shell_escape: bool = False,
        extra_args: list[str] | None = None,
        build_id: str | None = None,
        keep_builds: int = 6,
    ) -> BuildResult:
        if not self.tools.has_tex():
            raise CompileError(
                "No TeX distribution found. Install TeX Live, MiKTeX or MacTeX, "
                "then reload this page."
            )
        engine_obj = self.tools.engine(engine)
        if engine_obj is None or not engine_obj.available:
            engine = self.tools.default_engine
            engine_obj = self.tools.engine(engine)
        if engine_obj is None:
            raise CompileError("No usable LaTeX engine is available.")

        main_abs = os.path.join(self.project_dir, main_file)
        if not os.path.isfile(main_abs):
            raise CompileError(f"main file “{main_file}” does not exist")

        build_id = build_id or time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        out_dir = self.build_dir(build_id)
        os.makedirs(out_dir, exist_ok=True)
        self._mirror_source_dirs(out_dir)

        started = time.time()
        with Builder.lock_for(self.project_dir):
            return_code, output, timed_out = self._invoke(
                engine_obj, main_file, out_dir, synctex, timeout, shell_escape, extra_args
            )
        duration_ms = int((time.time() - started) * 1000)

        log = self._read_output_text(main_file, out_dir, output)
        diagnostics = parse_log(log, main_file)
        pdf_path = self._find_output(main_file, out_dir, ".pdf")
        has_pdf = bool(pdf_path and os.path.isfile(pdf_path))

        result = BuildResult(
            build_id=build_id,
            ok=has_pdf and not any(d.severity == "error" for d in diagnostics),
            has_pdf=has_pdf,
            engine=engine,
            duration_ms=duration_ms,
            diagnostics=diagnostics,
            log=log,
            return_code=return_code,
            timed_out=timed_out,
            build_dir=out_dir,
        )
        if has_pdf:
            result.pages, result.page_sizes = self._pdf_info(pdf_path)
        if timed_out:
            result.diagnostics.insert(
                0,
                Diagnostic(
                    severity="error",
                    message=f"Compilation timed out after {timeout}s (possible infinite loop in the document)",
                    file=main_file,
                    kind="timeout",
                ),
            )
            result.ok = False
        if has_pdf:
            self._write_latest(build_id, main_file)
            self._prune_builds(keep=keep_builds)
        return result

    def _invoke(
        self,
        engine: Engine,
        main_file: str,
        out_dir: str,
        synctex: bool,
        timeout: int,
        shell_escape: bool,
        extra_args: list[str] | None,
    ) -> tuple[int, str, bool]:
        """Run the engine (via latexmk when present, else multi-pass manually)."""
        base = ["-interaction=nonstopmode", "-file-line-error"]
        if synctex:
            base.append("-synctex=1")
        if shell_escape:
            base.append("-shell-escape")
        else:
            base.append("-no-shell-escape")
        if extra_args:
            base.extend(extra_args)

        if self.tools.latexmk:
            # latexmk handles rerun detection, bibtex/biber and the .aux chain.
            driver = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}
            cmd = [
                "latexmk",
                driver.get(engine.id, "-pdf"),
                "-silent",
                "-norc",
                f"-outdir={out_dir}",
                *base,
                main_file,
            ]
            return self._run(cmd, timeout)

        # No latexmk: run the engine repeatedly until the log settles.
        cmd = [engine.program, *base, f"-output-directory={out_dir}", main_file]
        return_code, output, timed_out = self._run(cmd, timeout)
        combined = output
        for _ in range(3):
            if timed_out:
                break
            ran_bib = self._run_bibliography(main_file, out_dir, combined, timeout)
            if not RERUN_RE.search(combined) and not ran_bib:
                break
            return_code, output, timed_out = self._run(cmd, timeout)
            combined += output
        return return_code, combined, timed_out

    def _run_bibliography(self, main_file: str, out_dir: str, log: str, timeout: int) -> bool:
        """
        Run biber/bibtex when the document asks for it.
        Returns True when a tool actually ran, which means the main engine has
        to run again to pick up the bibliography.
        """
        stem = os.path.splitext(os.path.basename(main_file))[0]
        bcf = os.path.join(out_dir, stem + ".bcf")
        aux = os.path.join(out_dir, stem + ".aux")
        # A `.bcf` file means biblatex; otherwise check the .aux for \bibdata.
        if os.path.isfile(bcf) and self.tools.biber:
            self._run(
                ["biber", f"--input-directory={out_dir}", f"--output-directory={out_dir}", stem],
                timeout,
                cwd=out_dir,
            )
            return True
        if os.path.isfile(aux) and self.tools.bibtex:
            try:
                with open(aux, "r", encoding="utf-8", errors="replace") as fh:
                    aux_text = fh.read()
            except OSError:
                aux_text = ""
            if "\\bibdata" in aux_text:
                code, _, _ = self._run(["bibtex", stem], timeout, cwd=out_dir)
                return code == 0
        return False

    def _read_output_text(self, main_file: str, out_dir: str, output: str) -> str:
        """Prefer the real .log file; fall back to captured stdout."""
        stem = os.path.splitext(os.path.basename(main_file))[0]
        log_path = os.path.join(out_dir, stem + ".log")
        if os.path.isfile(log_path):
            try:
                with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
                    return fh.read()
            except OSError:
                pass
        return output

    def _find_output(self, main_file: str, out_dir: str, ext: str) -> str | None:
        stem = os.path.splitext(os.path.basename(main_file))[0]
        candidate = os.path.join(out_dir, stem + ext)
        if os.path.isfile(candidate):
            return candidate
        # latexmk sometimes names output after the jobname in the aux file.
        for name in sorted(os.listdir(out_dir)) if os.path.isdir(out_dir) else []:
            if name.endswith(ext) and not name.startswith("."):
                return os.path.join(out_dir, name)
        return None

    def _pdf_info(self, pdf_path: str) -> tuple[int, list[dict[str, float]]]:
        """Page count and page sizes (in PDF points)."""
        if not self.tools.pdfinfo:
            return 0, []
        code, out, _ = self._run(["pdfinfo", "-f", "1", "-l", "1", pdf_path], 30, cwd=os.path.dirname(pdf_path))
        if code != 0:
            return 0, []
        pages = 0
        sizes: list[dict[str, float]] = []
        for line in out.splitlines():
            if line.startswith("Pages:"):
                try:
                    pages = int(line.split(":", 1)[1].strip())
                except ValueError:
                    pages = 0
            if line.startswith("Page size:"):
                m = re.search(r"([\d.]+)\s*x\s*([\d.]+)", line)
                if m:
                    w, h = float(m.group(1)), float(m.group(2))
                    sizes = [{"width": w, "height": h} for _ in range(max(pages, 1))]
        # Mixed page sizes: query each page when there is more than one.
        if pages > 1:
            details = self._run(["pdfinfo", "-f", "1", f"-l", str(pages), pdf_path], 30, cwd=os.path.dirname(pdf_path))[1]
            per_page: list[dict[str, float]] = []
            for line in details.splitlines():
                m = re.match(r"Page\s+(\d+)\s+size:\s+([\d.]+)\s*x\s*([\d.]+)", line)
                if m:
                    idx = int(m.group(1)) - 1
                    while len(per_page) <= idx:
                        per_page.append({"width": 595.276, "height": 841.89})
                    per_page[idx] = {"width": float(m.group(2)), "height": float(m.group(3))}
            if per_page:
                sizes = per_page
        if not sizes and pages:
            sizes = [{"width": 595.276, "height": 841.89} for _ in range(pages)]
        return pages, sizes

    def _prune_builds(self, keep: int = 6) -> None:
        root = self.build_root
        if not os.path.isdir(root):
            return
        try:
            entries = [
                (os.path.getmtime(os.path.join(root, name)), name)
                for name in os.listdir(root)
                if os.path.isdir(os.path.join(root, name))
            ]
        except OSError:
            return
        entries.sort(reverse=True)
        latest = self.latest_build_id()
        for _, name in entries[keep:]:
            if name == latest:
                continue
            shutil.rmtree(os.path.join(root, name), ignore_errors=True)

    # -- page rendering ------------------------------------------------------

    def page_svg(self, build_id: str, page: int, main_file: str) -> bytes | None:
        """Vector rendering of one page — crisp at any zoom in the preview."""
        pdf = self._pdf_for(build_id, main_file)
        if not pdf or not self.tools.pdftocairo:
            return None
        out_dir = os.path.join(self.build_dir(build_id), "pages")
        os.makedirs(out_dir, exist_ok=True)
        target = os.path.join(out_dir, f"{page}.svg")
        if os.path.isfile(target):
            with open(target, "rb") as fh:
                return fh.read()
        code, _, _ = self._run(
            [
                "pdftocairo",
                "-svg",
                "-f",
                str(page),
                "-l",
                str(page),
                pdf,
                os.path.join(out_dir, f"{page}.svg"),
            ],
            90,
            cwd=out_dir,
        )
        if code == 0 and os.path.isfile(target):
            with open(target, "rb") as fh:
                return fh.read()
        return None

    def page_png(self, build_id: str, page: int, main_file: str, dpi: int = 110) -> bytes | None:
        """Raster rendering, used for thumbnails and as an SVG fallback."""
        pdf = self._pdf_for(build_id, main_file)
        if not pdf or not self.tools.pdftoppm:
            return None
        out_dir = os.path.join(self.build_dir(build_id), "png")
        os.makedirs(out_dir, exist_ok=True)
        target = os.path.join(out_dir, f"{page}-{dpi}.png")
        if os.path.isfile(target):
            with open(target, "rb") as fh:
                return fh.read()
        code, _, _ = self._run(
            [
                "pdftoppm",
                "-png",
                "-r",
                str(dpi),
                "-f",
                str(page),
                "-l",
                str(page),
                "-singlefile",
                pdf,
                os.path.join(out_dir, f"{page}-{dpi}"),
            ],
            90,
            cwd=out_dir,
        )
        if code == 0 and os.path.isfile(target):
            with open(target, "rb") as fh:
                return fh.read()
        return None

    def _pdf_for(self, build_id: str, main_file: str) -> str | None:
        return self._find_output(main_file, self.build_dir(build_id), ".pdf")

    # -- SyncTeX -------------------------------------------------------------

    def _synctex_path(self, build_id: str, main_file: str) -> str | None:
        stem = os.path.splitext(os.path.basename(main_file))[0]
        for name in (stem + ".synctex.gz", stem + ".synctex"):
            candidate = os.path.join(self.build_dir(build_id), name)
            if os.path.isfile(candidate):
                return candidate
        return None

    def synctex_forward(
        self, build_id: str, main_file: str, file: str, line: int, column: int = 0
    ) -> list[dict[str, Any]]:
        """Source position -> PDF rectangles."""
        if not self.tools.synctex or not self._synctex_path(build_id, main_file):
            return []
        pdf = self._pdf_for(build_id, main_file)
        if not pdf:
            return []
        out_dir = self.build_dir(build_id)
        # `synctex view` matches input files by their absolute path.
        source = file if os.path.isabs(file) else os.path.join(self.project_dir, file)
        code, out, _ = self._run(
            [
                "synctex",
                "view",
                "-i",
                f"{line}:{column}:{source}",
                "-o",
                os.path.basename(pdf),
                "-d",
                out_dir,
            ],
            30,
        )
        if code != 0 and not out.strip():
            return []
        return _parse_synctex_view(out)

    def synctex_inverse(
        self, build_id: str, main_file: str, page: int, x: float, y: float
    ) -> dict[str, Any] | None:
        """PDF position -> source position. `x`/`y` are PDF points."""
        if not self.tools.synctex or not self._synctex_path(build_id, main_file):
            return None
        pdf = self._pdf_for(build_id, main_file)
        if not pdf:
            return None
        out_dir = self.build_dir(build_id)
        # SyncTeX works in TeX points (72.27/inch), the PDF in big points (72/inch).
        scale = 72.27 / 72.0
        code, out, _ = self._run(
            [
                "synctex",
                "edit",
                "-o",
                f"{page}:{x * scale:.3f}:{y * scale:.3f}:{os.path.basename(pdf)}",
                "-d",
                out_dir,
            ],
            30,
        )
        if code != 0:
            return None
        source_path = ""
        line_no = 0
        column = 0
        for raw in out.splitlines():
            line = raw.strip()
            if line.startswith("Input:"):
                source_path = line.split(":", 1)[1].strip()
            elif line.startswith("Line:"):
                parts = line.split(":")
                try:
                    line_no = int(parts[1])
                    column = int(parts[2]) if len(parts) > 2 and parts[2].strip().isdigit() else 0
                except (IndexError, ValueError):
                    pass
        if not line_no:
            return None
        if source_path:
            try:
                source_path = os.path.relpath(os.path.abspath(source_path), self.project_dir)
            except ValueError:
                source_path = os.path.basename(source_path)
            if source_path.startswith(".."):
                source_path = os.path.basename(source_path)
        return {
            "file": (source_path or main_file).replace(os.sep, "/"),
            "line": line_no,
            "column": column,
        }


def _parse_synctex_view(output: str) -> list[dict[str, Any]]:
    """
    `synctex view` prints records like:

        SyncTeX result begin
        Output:foo.pdf
        Page:1
        x:133.768997
        y:134.764618
        h:133.768997
        v:134.764618
        W:343.711060
        H:6.918498
        ...
        SyncTeX result end
    """
    records: list[dict[str, Any]] = []
    current: dict[str, Any] = {}
    scale = 72.0 / 72.27  # TeX points -> PDF points
    for raw in output.splitlines():
        line = raw.strip()
        if line.startswith("Page:"):
            if current.get("page"):
                records.append(current)
            current = {"page": int(line.split(":", 1)[1])}
        elif line.startswith(("x:", "y:", "h:", "v:", "W:", "H:")) and current:
            key, _, value = line.partition(":")
            try:
                current[key] = float(value)
            except ValueError:
                pass
    if current.get("page"):
        records.append(current)
    out: list[dict[str, Any]] = []
    for rec in records:
        if "x" not in rec or "y" not in rec:
            continue
        out.append(
            {
                "page": rec["page"],
                "x": rec["x"] * scale,
                "y": rec["y"] * scale,
                "width": rec.get("W", 1.0) * scale,
                "height": rec.get("H", 1.0) * scale,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Standalone math rendering (for the visual editor's math chips)
# ---------------------------------------------------------------------------


# Environments that only exist at display level, mapped to the form that is
# valid inside `$...$`.  The standalone class in TeX Live refuses `\\[...\\]`,
# `displaymath` and `equation`, but a displaystyle inline formula is equivalent
# for a one-equation preview and keeps the bounding box exact.
MATH_ENV_ALIASES = {
    "align": "aligned",
    "align*": "aligned",
    "alignat": "aligned",
    "alignat*": "aligned",
    "flalign": "aligned",
    "flalign*": "aligned",
    "split": "aligned",
    "equation": "aligned",
    "equation*": "aligned",
    "subequations": "aligned",
    "gather": "gathered",
    "gather*": "gathered",
    "multline": "gathered",
    "multline*": "gathered",
    "displaymath": "aligned",
    "eqnarray": "aligned",
    "eqnarray*": "aligned",
}

# Commands that are meaningless (or illegal) outside a real document.
MATH_STRIP_RE = re.compile(
    r"\\label\s*\{[^{}]*\}|\\nonumber\b|\\notag\b|\\tag\s*\{[^{}]*\}|\\intertext\s*\{[^{}]*\}"
)


def normalise_math(latex: str, *, display: bool = False) -> str:
    """
    Turn a math fragment from a document into something `standalone` can build.

    `\\label{eq:x}` is dropped (there is nothing to reference in a preview),
    and display environments become their inline-compatible counterparts.
    """
    body = MATH_STRIP_RE.sub("", str(latex or ""))
    # Removing a `\\label` from its own line leaves a blank line behind, and a
    # blank line inside math mode is a paragraph break ("Missing $ inserted").
    body = re.sub(r"\n[ \t]*\n+", "\n", body).strip()
    env = re.match(r"\\begin\{([A-Za-z*]+)\}", body)
    if env:
        target = MATH_ENV_ALIASES.get(env.group(1))
        if target:
            body = re.sub(r"^\\begin\{[A-Za-z*]+\}", f"\\\\begin{{{target}}}", body, count=1)
            body = re.sub(r"\\end\{[A-Za-z*]+\}\s*$", f"\\\\end{{{target}}}", body)
    if not body:
        return ""
    return f"$\\displaystyle {body}$" if display else f"${body}$"


def render_math_svg(latex: str, *, display: bool = False, preamble: str = "", timeout: int = 25) -> str | None:
    """
    Render a LaTeX math fragment to SVG with the user's own preamble.

    This is what makes previews inside the visual editor honour custom macros,
    packages and fonts: it is the real TeX engine, not a JavaScript subset.
    Returns None when the snippet cannot be compiled, so the caller can fall
    back to its built-in renderer.
    """
    if not TOOLCHAIN.has_tex() or not TOOLCHAIN.dvisvgm:
        return None
    import tempfile

    body = normalise_math(latex, display=display)
    if not body.strip():
        return None
    header = "\\documentclass[12pt,border=2pt]{standalone}\n\\usepackage{amsmath,amssymb,amsfonts}\n"
    tail = "\\begin{document}\n" + body + "\n\\end{document}\n"
    # Try with the document's own preamble first (so custom macros work), then
    # without it: a package that fights `standalone` should cost fidelity, not
    # the whole preview.
    for use_preamble in ([True, False] if preamble.strip() else [False]):
        doc = header + (preamble + "\n" if use_preamble else "") + tail
        svg = _build_math_snippet(doc, timeout)
        if svg is not None:
            return svg
    return None


def _build_math_snippet(doc: str, timeout: int) -> str | None:
    """Compile one standalone math document and return its SVG."""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="atex-math-") as tmp:
        tex = os.path.join(tmp, "math.tex")
        with open(tex, "w", encoding="utf-8") as fh:
            fh.write(doc)
        env = dict(os.environ)
        env.setdefault("TEXMFVAR", os.path.join(tmp, "texmfvar"))
        try:
            proc = subprocess.run(
                ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "math.tex"],
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if proc.returncode != 0 or not os.path.isfile(os.path.join(tmp, "math.pdf")):
            return None
        try:
            dvisvg = subprocess.run(
                ["dvisvgm", "--pdf", "--no-fonts", "--exact-bbox", "-O", "-o", "math.svg", "math.pdf"],
                cwd=tmp,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        svg_path = os.path.join(tmp, "math.svg")
        if dvisvg.returncode != 0 or not os.path.isfile(svg_path):
            return None
        try:
            with open(svg_path, "r", encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return None
