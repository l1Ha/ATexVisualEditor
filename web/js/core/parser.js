/**
 * ATexVisualEditor — LaTeX parser.
 *
 * Produces a lossless concrete syntax tree: the concatenation of every node's
 * `raw` slice reproduces the input byte for byte (`verifyTiling` proves it,
 * and the test suite runs that check over a corpus).
 *
 * The parser never throws on malformed input.  Unmatched braces, stray
 * `\end`, unterminated math and unknown commands all degrade into nodes that
 * reprint exactly, so a round trip through the visual editor cannot corrupt a
 * document even if we do not understand parts of it.
 */

import * as ast from './ast.js';
import { printNode } from './printer.js';
import {
  commandSig,
  environmentInfo,
  UNKNOWN_COMMAND_MAX_ARGS,
} from './latex-knowledge.js';

/** Characters that end a run of ordinary text. */
const TEXT_STOP = new Set(['\\', '{', '}', '$', '%', '~']);

/** Argument kinds whose content is an opaque string rather than prose. */
const RAW_ARG_KINDS = new Set(['textarg', 'filearg', 'ref', 'cite', 'image', 'tabular', 'zeroish']);

/** Commands whose argument is a delimited verbatim run (`\verb|...|`). */
const VERB_DELIM_COMMANDS = new Set(['verb', 'lstinline', 'mintinline', 'verb*']);

export class Parser {
  constructor(source) {
    this.s = source;
    this.n = source.length;
    this.i = 0;
    /** Names of currently open environments, innermost last. */
    this.envStack = [];
    this.warnings = [];
    /** True while parsing the body of a tabular-like environment. */
    this.tabular = false;
    this.macroDepth = 0;
  }

  // -- low level ------------------------------------------------------------

  finish(node, start) {
    node.start = start;
    node.end = this.i;
    node.raw = this.s.slice(start, this.i);
    node._dirty = false;
    return node;
  }

  /**
   * Look for `open` after optional whitespace without consuming anything.
   *
   * Returns `{found, lead, at}`: `lead` is the whitespace that the caller must
   * keep (it is stored on the argument node so reprinting an edited argument
   * does not silently delete a line break), `at` is the delimiter's offset.
   * A blank line ends the search — arguments never reach across paragraphs.
   */
  peekDelim(open) {
    let j = this.i;
    while (j < this.n) {
      const c = this.s[j];
      if (c === ' ' || c === '\t' || c === '\r') {
        j++;
        continue;
      }
      if (c === '\n') {
        // Reject when this newline is followed by (only whitespace and) another
        // newline: that is a paragraph break, not an argument separator.
        let k = j + 1;
        while (k < this.n && (this.s[k] === ' ' || this.s[k] === '\t' || this.s[k] === '\r')) k++;
        if (k >= this.n || this.s[k] === '\n') return { found: false };
        j = k;
        continue;
      }
      break;
    }
    if (j < this.n && this.s[j] === open) {
      return { lead: this.s.slice(this.i, j), found: true, at: j };
    }
    return { found: false };
  }

  warn(message, at = this.i) {
    this.warnings.push({ message, index: at });
  }

  // -- entry ----------------------------------------------------------------

  parseDocument() {
    const start = this.i;
    const children = this.parseNodes(() => this.i >= this.n);
    const root = ast.root(children);
    ast.link(root, children);
    root.start = start;
    root.end = this.i;
    root.raw = this.s.slice(start, this.i);
    root._dirty = false;
    root.warnings = this.warnings;
    return root;
  }

  parseNodes(stop) {
    const out = [];
    while (this.i < this.n) {
      if (stop && stop(this)) break;
      const before = this.i;
      const node = this.parseOne();
      if (node) out.push(node);
      if (this.i === before) {
        // Safety net: never loop forever.
        out.push(this.finish(ast.raw(this.s[this.i]), before));
        this.i++;
      }
    }
    return out;
  }

  parseOne() {
    const c = this.s[this.i];
    switch (c) {
      case '\\':
        return this.parseBackslash();
      case '{':
        return this.parseBracedGroup();
      case '$':
        return this.parseDollarMath();
      case '%':
        return this.parseComment();
      case '~':
        return this.parseTilde();
      case '}':
        // Stray closing brace: keep it verbatim.
        return this.parseRawChar();
      case '&':
        if (this.tabular) return this.parseRawChar();
        return this.parseText();
      default:
        return this.parseText();
    }
  }

  parseRawChar() {
    const start = this.i;
    this.i++;
    return this.finish(ast.raw(this.s[start]), start);
  }

  parseText() {
    const start = this.i;
    let j = this.i;
    while (j < this.n) {
      const c = this.s[j];
      if (TEXT_STOP.has(c)) break;
      if (c === '&' && this.tabular) break;
      if (c === '\n') {
        // Stop a run at a blank line so paragraph breaks stay separable.
        let k = j + 1;
        while (k < this.n && (this.s[k] === ' ' || this.s[k] === '\t')) k++;
        if (k < this.n && this.s[k] === '\n') {
          this.i = j;
          if (this.i === start) {
            // Emit the whole newline run as its own text node.
            this.i = k;
            return this.finish(ast.text(this.s.slice(start, k), { escaped: false }), start);
          }
          return this.finish(ast.text(this.s.slice(start, j), { escaped: false }), start);
        }
      }
      j++;
    }
    this.i = j;
    if (this.i === start) this.i = Math.min(start + 1, this.n);
    return this.finish(ast.text(this.s.slice(start, this.i), { escaped: false }), start);
  }

  parseComment() {
    const start = this.i;
    while (this.i < this.n && this.s[this.i] !== '\n') this.i++;
    // A comment consumes the newline too, so it does not look like a paragraph break.
    if (this.i < this.n) this.i++;
    return this.finish(ast.comment(this.s.slice(start, this.i)), start);
  }

  parseTilde() {
    const start = this.i;
    this.i++;
    return this.finish(ast.command('~', []), start);
  }

  parseBracedGroup() {
    const start = this.i;
    this.i++; // '{'
    const children = this.parseNodes((p) => p.i < p.n && p.s[p.i] === '}');
    if (this.i < this.n && this.s[this.i] === '}') {
      this.i++;
    } else {
      this.warn('unbalanced "{" — group left unterminated', start);
    }
    const node = ast.group(children);
    ast.link(node, children);
    return this.finish(node, start);
  }

  // -- math -----------------------------------------------------------------

  parseDollarMath() {
    const start = this.i;
    const isDouble = this.s[this.i + 1] === '$';
    const delim = isDouble ? '$$' : '$';
    const bodyStart = this.i + delim.length;
    let j = bodyStart;
    let closed = -1;
    while (j < this.n) {
      const c = this.s[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (!isDouble && c === '\n') {
        // A blank line cannot appear inside inline math; bail out.
        let k = j + 1;
        while (k < this.n && (this.s[k] === ' ' || this.s[k] === '\t')) k++;
        if (k < this.n && this.s[k] === '\n') break;
        j++;
        continue;
      }
      if (c === '$') {
        if (isDouble) {
          if (this.s[j + 1] === '$') {
            closed = j;
            break;
          }
          j++;
          continue;
        }
        closed = j;
        break;
      }
      j++;
    }
    if (closed < 0) {
      this.warn(`unterminated ${delim} math — kept as text`, start);
      this.i = start + 1;
      return this.finish(ast.raw('$'), start);
    }
    const value = this.s.slice(bodyStart, closed);
    this.i = closed + delim.length;
    const node = ast.math(value, { mode: isDouble ? 'display' : 'inline', delim });
    node.start = start;
    node.end = this.i;
    node.raw = this.s.slice(start, this.i);
    node._dirty = false;
    return node;
  }

  parseDelimitedMath(open, close, mode) {
    const start = this.i;
    const bodyStart = this.i + open.length;
    let j = bodyStart;
    let closed = -1;
    while (j < this.n) {
      const c = this.s[j];
      if (c === '\\') {
        // `\)` / `\]` close the math; any other backslash is an escape.
        if (this.s.startsWith(close, j)) {
          closed = j;
          break;
        }
        j += 2;
        continue;
      }
      j++;
    }
    if (closed < 0) {
      this.warn(`unterminated ${open} math — kept as text`, start);
      this.i = start + open.length;
      return this.finish(ast.raw(open), start);
    }
    const value = this.s.slice(bodyStart, closed);
    this.i = closed + close.length;
    const node = ast.math(value, { mode, delim: open });
    node.start = start;
    node.end = this.i;
    node.raw = this.s.slice(start, this.i);
    node._dirty = false;
    return node;
  }

  // -- commands -------------------------------------------------------------

  parseBackslash() {
    const start = this.i;
    const next = this.s[this.i + 1];
    if (next === undefined) {
      this.i++;
      return this.finish(ast.raw('\\'), start);
    }

    // Delimited math: \( \) \[ \]
    if (next === '(') return this.parseDelimitedMath('\\(', '\\)', 'inline');
    if (next === '[') return this.parseDelimitedMath('\\[', '\\]', 'display');

    if (/[a-zA-Z]/.test(next)) {
      let j = this.i + 1;
      while (j < this.n && /[a-zA-Z]/.test(this.s[j])) j++;
      const name = this.s.slice(this.i + 1, j);
      this.i = j;
      if (name === 'begin') return this.parseEnvironment(start);
      if (name === 'end') return this.parseStrayEnd(start);
      return this.parseCommandTail(name, start);
    }

    // Backslash followed by a single non-letter character.
    this.i += 2;
    const name = next;
    if (name === '\\') {
      // `\\` — a line break, which may carry a vertical-space argument.
      const node = ast.command('\\', []);
      const node0 = this.parseOptionalArgsOnly(node, start);
      return node0;
    }
    return this.finish(ast.command(name, []), start);
  }

  parseOptionalArgsOnly(node, start) {
    const args = [];
    for (let k = 0; k < 2; k++) {
      const peek = this.peekDelim('[');
      if (!peek.found) break;
      this.i = peek.at;
      const arg = this.parseArg(true, peek.lead);
      if (!arg) break;
      args.push(arg);
    }
    node.args = args;
    ast.link(node, args);
    return this.finish(node, start);
  }

  /** Parse a command's arguments after its name has been consumed. */
  parseCommandTail(name, start) {
    // Starred form (`\section*`, `\\*`): only when a `*` is followed by an
    // argument, whitespace or end of input — never when it belongs to text.
    let star = false;
    if (this.s[this.i] === '*') {
      const after = this.s[this.i + 1];
      if (after === undefined || after === '{' || after === '[' || /[\s}%]/.test(after)) {
        star = true;
        this.i++;
      }
    }

    const sig = commandSig(name);
    const args = [];

    if (VERB_DELIM_COMMANDS.has(name)) {
      const node = ast.command(name, [], { star });
      const delim = this.s[this.i];
      if (delim && !/\s/.test(delim)) {
        const bodyStart = this.i + 1;
        const found = this.s.indexOf(delim, bodyStart);
        const stop = found < 0 ? this.n : found;
        const argStart = this.i;
        // Keep both delimiters inside the argument's own source span.
        this.i = Math.min(stop + 1, this.n);
        const arg = ast.argument([mkLiteralText(this.s.slice(bodyStart, stop), bodyStart)], { optional: false });
        arg.lead = '';
        arg.verbDelim = delim;
        ast.link(arg, arg.children);
        args.push(this.finish(arg, argStart));
      } else {
        this.warn('\\verb without a delimiter character', start);
      }
      node.args = args;
      ast.link(node, args);
      return this.finish(node, start);
    }

    if (sig) {
      for (let k = 0; k < (sig.opt || 0); k++) {
        const peek = this.peekDelim('[');
        if (!peek.found) break;
        this.i = peek.at;
        const arg = this.parseArg(true, peek.lead);
        if (!arg) break;
        args.push(arg);
      }
      for (let k = 0; k < (sig.req || 0); k++) {
        const peek = this.peekDelim('{');
        if (!peek.found) {
          this.warn(`\\${name} is missing required argument ${k + 1}`, this.i);
          break;
        }
        this.i = peek.at;
        const arg = this.parseArg(false, peek.lead, isRawTextArg(name, k, sig));
        if (!arg) break;
        args.push(arg);
      }
    } else {
      // Unknown command: greedily absorb adjacent bracketed/braced groups,
      // mirroring how TeX itself picks up arguments.
      let absorbed = 0;
      while (absorbed < UNKNOWN_COMMAND_MAX_ARGS) {
        const peekOpt = this.peekDelim('[');
        const peekReq = peekOpt.found ? { found: false } : this.peekDelim('{');
        const peek = peekOpt.found ? peekOpt : peekReq;
        if (!peek.found) break;
        this.i = peek.at;
        const arg = this.parseArg(peekOpt.found, peek.lead, false);
        if (!arg) break;
        args.push(arg);
        absorbed++;
      }
    }

    const node = ast.command(name, args, { star });
    ast.link(node, args);
    return this.finish(node, start);
  }

  /**
   * Parse one `{...}` or `[...]` argument.  `lead` is whitespace between the
   * command and the opening delimiter; it is stored on the node so that
   * reprinting a modified argument does not lose it.
   */
  parseArg(optional, lead, rawText = false) {
    const open = optional ? '[' : '{';
    const close = optional ? ']' : '}';
    if (this.s[this.i] !== open) return null;
    const contentStart = this.i + 1;
    /** Offset of the argument node itself, including any skipped whitespace. */
    const argStart = contentStart - 1 - lead.length;
    let i = contentStart;
    let depth = 0;
    let end = -1;
    while (i < this.n) {
      const c = this.s[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '%') {
        while (i < this.n && this.s[i] !== '\n') i++;
        continue;
      }
      if (optional) {
        if (c === ']') {
          end = i;
          break;
        }
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        if (depth === 0) {
          end = i;
          break;
        }
        depth--;
      }
      i++;
    }
    if (end < 0) {
      this.warn(`unbalanced "${open}" in argument`, this.i);
      end = this.n;
      const value = this.s.slice(contentStart, end);
      this.i = end;
      const arg = ast.argument([mkLiteralText(value, contentStart)], { optional });
      arg.lead = lead;
      arg.unterminated = true;
      ast.link(arg, arg.children);
      return this.finish(arg, argStart);
    }

    const raw = this.s.slice(contentStart, end);
    let children;
    if (rawText) {
      children = raw.length ? [mkLiteralText(raw, contentStart)] : [];
    } else {
      const sub = new Parser(raw);
      // Arguments are self-contained: an `\end{...}` inside them may only
      // close an environment that also started inside them.
      sub.envStack = [];
      sub.tabular = this.tabular;
      const subRoot = sub.parseDocument();
      children = subRoot.children;
      for (const w of sub.warnings) {
        this.warnings.push({ ...w, index: w.index + contentStart });
      }
      shiftOffsets(children, contentStart);
    }
    this.i = end + 1;
    const arg = ast.argument(children, { optional });
    arg.lead = lead;
    ast.link(arg, children);
    return this.finish(arg, argStart);
  }

  // -- environments ---------------------------------------------------------

  parseEnvironment(start) {
    const namePeek = this.peekDelim('{');
    if (!namePeek.found) {
      this.warn('\\begin without an environment name', start);
      return this.finish(ast.command('begin', []), start);
    }
    const nameStart = namePeek.at + 1;
    const nameEnd = this.s.indexOf('}', nameStart);
    if (nameEnd < 0) {
      this.warn('\\begin{ without a closing brace', start);
      return this.finish(ast.command('begin', []), start);
    }
    const name = this.s.slice(nameStart, nameEnd).trim();
    const nameRaw = this.s.slice(this.i, nameEnd + 1);
    this.i = nameEnd + 1;

    const info = environmentInfo(name);
    const args = [];
    if (info && info.args) {
      for (let k = 0; k < (info.args.opt || 0); k++) {
        const peek = this.peekDelim('[');
        if (!peek.found) break;
        this.i = peek.at;
        const arg = this.parseArg(true, peek.lead, true);
        if (arg) args.push(arg);
      }
      for (let k = 0; k < (info.args.req || 0); k++) {
        const peek = this.peekDelim('{');
        if (!peek.found) break;
        this.i = peek.at;
        const arg = this.parseArg(false, peek.lead, true);
        if (arg) args.push(arg);
      }
    } else {
      let absorbed = 0;
      while (absorbed < 2) {
        const peekOpt = this.peekDelim('[');
        if (!peekOpt.found) break;
        this.i = peekOpt.at;
        const arg = this.parseArg(true, peekOpt.lead, true);
        if (!arg) break;
        args.push(arg);
        absorbed++;
      }
    }

    this.envStack.push(name);
    const verbatim = !!(info && info.verbatim);
    let children = [];
    let endNode = null;

    if (verbatim) {
      const closeTag = `\\end{${name}}`;
      let at = this.s.indexOf(closeTag, this.i);
      if (at < 0) {
        at = this.n;
        this.warn(`\\begin{${name}} without \\end{${name}}`, start);
      }
      const body = this.s.slice(this.i, at);
      if (body.length) children = [mkLiteralText(body, this.i)];
      this.i = at;
    } else {
      const prevTabular = this.tabular;
      if (info && info.kind === 'tabular') this.tabular = true;
      children = this.parseNodes((p) => p.atEnd(name));
      this.tabular = prevTabular;
    }

    const wasOpen = this.envStack.length && this.envStack[this.envStack.length - 1] === name;
    if (wasOpen) this.envStack.pop();

    // Consume \end{name} when present.
    const endStart = this.i;
    const peekEnd = this.peekEndTag();
    let endName = name;
    let closed = false;
    if (peekEnd && peekEnd.name === name) {
      endName = peekEnd.name;
      this.i = peekEnd.end;
      closed = true;
    } else if (peekEnd && this.envStack.includes(peekEnd.name)) {
      // The \end belongs to an outer environment: leave it for the caller.
      this.warn(`\\begin{${name}} closed by \\end{${peekEnd.name}}`, start);
      this.warn(`\\begin{${name}} is missing its \\end`, start);
    } else {
      if (this.i >= this.n) this.warn(`\\begin{${name}} without \\end{${name}}`, start);
    }

    const node = ast.environment(name, children, { args, endName, verbatim });
    node.nameRaw = nameRaw;
    node.closed = closed;
    node.endStart = endStart;
    ast.link(node, children);
    ast.link(node, args);
    return this.finish(node, start);
  }

  atEnd(name) {
    if (this.s[this.i] !== '\\') return false;
    const peek = this.peekEndTag();
    if (!peek) return false;
    if (peek.name === name) return true;
    // An \end of an enclosing environment also terminates us (recovery).
    return this.envStack.slice(0, -1).includes(peek.name);
  }

  /** Look for `\end{name}` at the cursor without consuming it. */
  peekEndTag() {
    if (!this.s.startsWith('\\end', this.i)) return null;
    let j = this.i + 4;
    if (/[a-zA-Z]/.test(this.s[j] || '')) return null;
    while (j < this.n && /\s/.test(this.s[j])) j++;
    if (this.s[j] !== '{') return null;
    const close = this.s.indexOf('}', j + 1);
    if (close < 0) return null;
    return { name: this.s.slice(j + 1, close).trim(), end: close + 1 };
  }

  parseStrayEnd(start) {
    // `\end{...}` with no matching \begin: keep it as a command node so it
    // reprints verbatim instead of derailing the rest of the parse.
    this.i = start + 4;
    const argPeek = this.peekDelim('{');
    const args = [];
    if (argPeek.found) {
      this.i = argPeek.at;
      const arg = this.parseArg(false, argPeek.lead, true);
      if (arg) args.push(arg);
    }
    this.warn('\\end without a matching \\begin', start);
    const node = ast.command('end', args);
    ast.link(node, args);
    return this.finish(node, start);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mkLiteralText(value, at) {
  const t = ast.text(value, { escaped: false });
  t.raw = value;
  t.start = at;
  t.end = at + value.length;
  t._dirty = false;
  return t;
}

/** Shift start/end offsets of a freshly parsed subtree into a parent source. */
export function shiftOffsets(nodes, delta) {
  if (!delta) return nodes;
  ast.walkAllOf(nodes, (n) => {
    n.start += delta;
    n.end += delta;
  });
  return nodes;
}

function isRawTextArg(name, index, sig) {
  if (!sig) return false;
  if (sig.kind === 'macrodef') return index === 0;
  if (sig.kind === 'url' || sig.kind === 'href') return index === 0;
  if (sig.kind === 'textcolor') return index === 0;
  if (sig.kind === 'fcolorbox') return index <= 1;
  if (RAW_ARG_KINDS.has(sig.kind)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

const cache = new Map();

/**
 * Parse LaTeX source into a CST.
 * Cached by source string — documents are re-parsed often after edits.
 */
export function parseLatex(source) {
  const hit = cache.get(source);
  if (hit) return hit;
  const root = new Parser(source).parseDocument();
  if (cache.size > 24) cache.clear();
  cache.set(source, root);
  return root;
}

export function parseLatexUncached(source) {
  return new Parser(source).parseDocument();
}

/**
 * Verify the structural invariant that makes round-tripping safe: within every
 * node list, sibling spans must join up exactly (no gaps, no overlaps), and
 * the top-level list must cover the whole source.
 *
 * A gap between siblings means characters that no node owns — printing would
 * silently drop them, so this check is the real guard behind "editing one word
 * cannot disturb the rest of the file".
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function verifyTiling(source, root = parseLatexUncached(source)) {
  const problems = [];
  const seen = new Set();

  const checkList = (nodes, where) => {
    if (!nodes || !nodes.length) return;
    let prev = null;
    for (const n of nodes) {
      if (!ast.isNode(n)) {
        problems.push(`${where}: non-node in list`);
        continue;
      }
      if (prev && n.start !== prev.end) {
        problems.push(
          `${where}: gap/overlap between ${prev.kind}@${prev.end} and ${n.kind}@${n.start}` +
            ` (${JSON.stringify(source.slice(prev.end, n.start)).slice(0, 60)})`
        );
      }
      if (n.end < n.start) problems.push(`${where}: ${n.kind} has inverted span`);
      prev = n;
      if (seen.has(n)) {
        problems.push(`${where}: node ${n.kind}@${n.start} appears twice`);
        continue;
      }
      seen.add(n);
      const kids = ast.childrenOf(n);
      if (kids && kids.length) checkList(kids, `${where}/${n.kind}`);
    }
  };

  checkList(root.children, 'root');
  const first = root.children[0];
  const last = root.children[root.children.length - 1];
  if (first && first.start !== 0) {
    problems.push(`root: does not start at 0 (${JSON.stringify(source.slice(0, first.start))})`);
  }
  if (last && last.end !== source.length) {
    problems.push(`root: does not reach the end (${JSON.stringify(source.slice(last.end))})`);
  }
  if (printNode(root) !== source) {
    problems.push('reprinting the tree does not reproduce the source');
  }
  return { ok: problems.length === 0, problems, tree: root };
}
