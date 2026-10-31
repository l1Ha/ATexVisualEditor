/**
 * ATexVisualEditor — document model.
 *
 * One source string is authoritative.  The CST is *derived* from it, and every
 * view (visual, source, PDF, outline) is a projection:
 *
 *     source  --parse-->  CST  --render-->  visual DOM
 *        ^                                     |
 *        +----------- print <-- mutate <-------+
 *
 * Visual edits mutate the CST and reprint the whole document; because clean
 * subtrees reprint from their cached raw slice, only the part that actually
 * changed moves — the file stays byte-identical everywhere else.
 *
 * Undo/redo is a stack of source snapshots with a caret hint.  That is
 * deliberately boring: one stack covers both views, and restoring a snapshot is
 * a reparse, so there is no way for the two views to drift apart.
 */

import { parseLatexUncached } from './parser.js';
import { printNode } from './printer.js';
import * as ast from './ast.js';
import { Kind } from './ast.js';
import { MATH_ENVS, SECTION_LEVELS, environmentInfo } from './latex-knowledge.js';

const HISTORY_LIMIT = 300;
const COALESCE_MS = 700;

/** A section of the document outline, with nested children. */
function makeSection(level, title, node, index) {
  return { level, title, node, index, children: [], id: `s${index}` };
}

export class Doc {
  constructor(source = '', { path = 'main.tex', name = '' } = {}) {
    this.path = path;
    this.name = name;
    this._source = source;
    this._root = parseLatexUncached(source);
    this._history = [];
    this._future = [];
    this._lastCommitAt = 0;
    this._lastCommitKind = '';
    this._listeners = new Map();
    this._revision = 0;
    this._caches = new Map();
    /** label -> {number, page} resolved from the last build's .aux file. */
    this.refs = new Map();
    /** citation key -> number resolved from .aux. */
    this.citeNumbers = new Map();
    /** label -> {key, kind, node} discovered in the source. */
    this.labels = new Map();
    /** files pulled in with \input/\include, for the file tree/outline. */
    this.includes = [];
    this._scan();
  }

  // -- events ---------------------------------------------------------------

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload, this);
      } catch (err) {
        console.error(`[doc] listener for "${event}" failed`, err);
      }
    }
  }

  // -- basic accessors ------------------------------------------------------

  get source() {
    return this._source;
  }

  get root() {
    return this._root;
  }

  get revision() {
    return this._revision;
  }

  /** Bump the revision so views know the tree changed. */
  touch() {
    this._revision++;
    this._caches.clear();
  }

  // -- mutation -------------------------------------------------------------

  /**
   * Replace the whole document text (used by the source editor).
   * Returns true when the text actually changed.
   */
  setSource(text, { commit = true, kind = 'source', silent = false } = {}) {
    if (text === this._source) return false;
    if (commit) this.pushHistory(kind);
    this._source = text;
    this._root = parseLatexUncached(text);
    this.touch();
    this._scan();
    if (!silent) this.emit('change', { origin: 'source' });
    return true;
  }

  /**
   * Apply a mutation to the CST, reprint and broadcast.
   *
   * @param {(root: object, doc: Doc) => void} mutate
   */
  mutate(mutate, { kind = 'visual', commit = true, node = null } = {}) {
    if (commit) this.pushHistory(kind);
    mutate(this._root, this);
    this._root._dirty = true;
    const printed = printNode(this._root);
    this._source = printed;
    this.touch();
    this._scan();
    this.emit('change', { origin: 'visual', node });
    return printed;
  }

  /** Convenience: mutate and keep the text but skip history bookkeeping. */
  mutateSilent(mutate) {
    return this.mutate(mutate, { commit: false });
  }

  // -- history --------------------------------------------------------------

  /**
   * Push an undo checkpoint.
   *
   * Consecutive edits of the same kind within `COALESCE_MS` collapse into one
   * step, so typing a sentence is a single undo rather than forty.
   */
  pushHistory(kind = 'edit', hint = null) {
    const now = Date.now();
    const coalesce =
      this._history.length > 0 &&
      kind === this._lastCommitKind &&
      now - this._lastCommitAt < COALESCE_MS &&
      kind !== 'structural';
    this._lastCommitAt = now;
    this._lastCommitKind = kind;
    if (coalesce) {
      // Keep the older snapshot; just extend the window.
      this._future.length = 0;
      return;
    }
    this._history.push({ source: this._source, kind, hint, at: now });
    if (this._history.length > HISTORY_LIMIT) this._history.shift();
    this._future.length = 0;
    this.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
  }

  get canUndo() {
    return this._history.length > 0;
  }

  get canRedo() {
    return this._future.length > 0;
  }

  undo() {
    const entry = this._history.pop();
    if (!entry) return null;
    this._future.push({ source: this._source, kind: this._lastCommitKind, hint: null, at: Date.now() });
    this._source = entry.source;
    this._root = parseLatexUncached(this._source);
    this.touch();
    this._scan();
    this._lastCommitAt = 0;
    this.emit('change', { origin: 'undo', hint: entry.hint });
    this.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
    return entry;
  }

  redo() {
    const entry = this._future.pop();
    if (!entry) return null;
    this._history.push({ source: this._source, kind: entry.kind, hint: null, at: Date.now() });
    this._source = entry.source;
    this._root = parseLatexUncached(this._source);
    this.touch();
    this._scan();
    this.emit('change', { origin: 'redo' });
    this.emit('history', { canUndo: this.canUndo, canRedo: this.canRedo });
    return entry;
  }

  clearHistory() {
    this._history.length = 0;
    this._future.length = 0;
    this.emit('history', { canUndo: false, canRedo: false });
  }

  // -- analysis -------------------------------------------------------------

  /** Refresh derived data (labels, include list, statistics). */
  _scan() {
    this.labels = new Map();
    this.includes = [];
    const sectionStack = [];
    this.outline = [];

    // Label kinds need the enclosing structure, so track a small context stack.
    const walkWithContext = (nodes, ctx) => {
      for (const node of nodes) {
        if (!ast.isNode(node)) continue;
        if (node.kind === Kind.Command && node.name === 'label') {
          const key = ast.plainText(node.args[0]?.children || []).trim();
          if (key) {
            this.labels.set(key, { key, kind: ctx.kind, node, line: 0, caption: ctx.caption });
          }
        }
        if (node.kind === Kind.Command && ['input', 'include', 'subfile', 'import'].includes(node.name)) {
          const target = ast.plainText(node.args[node.args.length - 1]?.children || []).trim();
          if (target) this.includes.push({ command: node.name, target, node });
        }
        let nextCtx = ctx;
        if (node.kind === Kind.Environment) {
          const info = environmentInfo(node.name);
          let kind = 'section';
          if (MATH_ENVS.has(node.name)) kind = 'equation';
          else if (info?.list) kind = 'item';
          else if (info?.kind === 'figure') kind = 'figure';
          else if (info?.kind === 'tabular') kind = 'table';
          if (node.name === 'table' || node.name === 'table*') kind = 'table';
          nextCtx = { ...ctx, kind, caption: ctx.caption };
        }
        if (node.kind === Kind.Command && node.name === 'caption') {
          nextCtx = { ...nextCtx, caption: ast.plainText(node.args[node.args.length - 1]?.children || []).trim() };
        }
        if (node.kind === Kind.Command && node.name === 'section') {
          const title = ast.plainText(node.args[node.args.length - 1]?.children || []).trim();
          nextCtx = { ...nextCtx, kind: 'section', caption: title };
        }
        const kids = ast.childrenOf(node);
        if (kids) walkWithContext(kids, nextCtx);
      }
    };
    walkWithContext(this._root.children, { kind: 'section', caption: '' });

    // Sectioning outline (also used by the structure panel and Ctrl+K).
    let counter = 1;
    const collect = (nodes) => {
      for (const node of nodes) {
        if (node.kind === Kind.Command && SECTION_LEVELS[node.name] !== undefined && !node.star) {
          const level = SECTION_LEVELS[node.name];
          const title = ast.plainText(node.args[node.args.length - 1]?.children || []).trim() || '(untitled)';
          const entry = makeSection(level, title, node, this.outline.length);
          while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= level) {
            sectionStack.pop();
          }
          if (sectionStack.length) {
            sectionStack[sectionStack.length - 1].children.push(entry);
            entry.parent = sectionStack[sectionStack.length - 1].id;
          } else {
            this.outline.push(entry);
          }
          entry.id = `sec-${counter++}`;
          sectionStack.push(entry);
        }
        const kids = ast.childrenOf(node);
        if (kids) collect(kids);
      }
    };
    collect(this._root.children);
    this.stats = this._computeStats();
    return this;
  }

  _computeStats() {
    const text = ast.plainText(this._root.children, { max: 4_000_000 });
    const words = text.split(/\s+/).filter(Boolean).length;
    let commands = 0;
    let envs = 0;
    let maths = 0;
    ast.walkAllOf(this._root.children, (n) => {
      if (n.kind === Kind.Command) commands++;
      else if (n.kind === Kind.Environment) envs++;
      else if (n.kind === Kind.Math) maths++;
    });
    return {
      words,
      characters: this._source.length,
      commands,
      environments: envs,
      maths,
      lines: this._source.split('\n').length,
    };
  }

  /** Flat list of headings for the structure/outline panel. */
  sectionList() {
    const out = [];
    const walk = (list) => {
      for (const entry of list) {
        out.push(entry);
        walk(entry.children);
      }
    };
    walk(this.outline);
    return out;
  }

  /**
   * Feed label and citation numbering from a build's .aux file.
   *
   * The shapes are `\newlabel{key}{{number}{page}{title}{anchor}{}}` (hyperref
   * adds the extra groups) and `\bibcite{key}{{label}{year}...}` with natbib —
   * a plain regex cannot handle the nesting, so the groups are scanned.
   */
  applyAux(auxText) {
    this.refs = new Map();
    this.citeNumbers = new Map();
    if (!auxText) return;
    const text = String(auxText);
    const re = /\\(newlabel|bibcite)\{/g;
    let match;
    while ((match = re.exec(text))) {
      const kind = match[1];
      const keyGroup = readBraceGroup(text, match.index + match[0].length - 1);
      if (!keyGroup) continue;
      const valueGroup = readBraceGroup(text, keyGroup.end);
      if (!valueGroup) continue;
      re.lastIndex = valueGroup.end;
      const parts = splitTopLevelGroups(valueGroup.text);
      const first = parts[0] || '';
      if (!first) continue;
      if (kind === 'newlabel') {
        this.refs.set(keyGroup.text, {
          number: first,
          page: parts[1] || '',
          title: parts[2] || '',
          anchor: parts[3] || '',
        });
      } else {
        this.citeNumbers.set(keyGroup.text, {
          label: first,
          year: parts[1] || '',
          author: stripBraces(parts[2] || ''),
        });
      }
    }
    this.touch();
    this.emit('aux', { refs: this.refs, citeNumbers: this.citeNumbers });
  }

  /** Display text for a \ref-like command. */
  resolveRef(key) {
    const hit = this.refs.get(key);
    return hit ? hit.number : null;
  }

  /** Display numbering for a \cite. */
  resolveCite(key) {
    const first = String(key).split(',')[0].trim();
    const hit = this.citeNumbers.get(first);
    if (!hit) return null;
    const label = typeof hit === 'string' ? hit : hit.label;
    return String(key).includes(',') ? `${label}+` : label;
  }

  /** A citation's full entry, including the year, for tooltips. */
  citeInfo(key) {
    const first = String(key).split(',')[0].trim();
    const hit = this.citeNumbers.get(first);
    if (!hit || typeof hit === 'string') return null;
    return hit;
  }

  // -- helpers used by the editors -----------------------------------------

  /** Byte offset -> 1-based line/column. */
  offsetToPosition(offset) {
    const before = this._source.slice(0, Math.max(0, offset));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  /** 1-based line -> offset of that line's start. */
  positionToOffset(line, column = 1) {
    const lines = this._source.split('\n');
    const index = Math.max(0, Math.min(lines.length - 1, line - 1));
    let offset = 0;
    for (let i = 0; i < index; i++) offset += lines[i].length + 1;
    return offset + Math.max(0, column - 1);
  }

  /** The line text for a 1-based line number. */
  lineText(line) {
    return (this._source.split('\n')[line - 1] ?? '');
  }

  /** All user-defined macros (\newcommand etc.) for previews and autocomplete. */
  userMacros() {
    if (this._caches.has('macros')) return this._caches.get('macros');
    const macros = new Map();
    ast.walkAllOf(this._root.children, (n) => {
      if (n.kind !== Kind.Command) return;
      if (!['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand'].includes(n.name)) return;
      const nameArg = ast.plainText(n.args[0]?.children || []).trim();
      const m = /^\\?([A-Za-z@]+)$/.exec(nameArg);
      if (!m) return;
      // args: [name?, argcount?, default?, body]
      const bodies = n.args.slice(1).filter((a) => !a.optional);
      const body = bodies[bodies.length - 1];
      if (!body) return;
      macros.set(m[1], {
        name: m[1],
        argCount: Number(ast.plainText((n.args.find((a) => a.optional) || { children: [] }).children).trim()) || 0,
        body: ast.plainText(body.children, { max: 2000 }),
        node: n,
      });
    });
    this._caches.set('macros', macros);
    return macros;
  }

  /** Preamble text (everything before \begin{document}), for math previews. */
  preamble() {
    if (this._caches.has('preamble')) return this._caches.get('preamble');
    const docStart = this._source.indexOf('\\begin{document}');
    let result = docStart > 0 ? this._source.slice(0, docStart) : '';
    // Strip the class line and anything that breaks `standalone`.
    result = result
      .split('\n')
      .filter((line) => !/^\s*\\(documentclass|title|author|date|maketitle)/.test(line))
      .join('\n');
    this._caches.set('preamble', result);
    return result;
  }

  /** Environment stack at a source offset — used for "insert inside table?" logic. */
  envAt(offset) {
    let best = null;
    ast.walkAllOf(this._root.children, (n) => {
      if (n.kind !== Kind.Environment) return;
      if (offset >= n.start && offset <= n.end) {
        if (!best || n.end - n.start < best.end - best.start) best = n;
      }
    });
    return best;
  }

  /** The innermost node containing an offset. */
  nodeAt(offset) {
    let best = null;
    const visit = (n) => {
      if (offset < n.start || offset > n.end) return;
      best = n;
      const kids = ast.childrenOf(n);
      if (kids) kids.forEach(visit);
    };
    this._root.children.forEach(visit);
    return best;
  }
}


// ---------------------------------------------------------------------------
// .aux scanning helpers
// ---------------------------------------------------------------------------

/** Read a `{...}` group starting at `index`; returns its text and end offset. */
function readBraceGroup(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  let depth = 0;
  const start = i + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { text: text.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/** Split `{a}{b}{c}` into ['a','b','c']; plain text comes back as one item. */
function splitTopLevelGroups(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const group = readBraceGroup(text, i);
    if (!group) {
      const rest = text.slice(i).trim();
      if (rest) out.push(rest);
      break;
    }
    out.push(group.text);
    i = group.end;
  }
  return out;
}

function stripBraces(text) {
  return String(text).replace(/[{}]/g, '').trim();
}
