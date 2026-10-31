/**
 * ATexVisualEditor — node model for the LaTeX concrete syntax tree (CST).
 *
 * Design notes
 * ------------
 * The CST is the single source of truth for the whole application.  Both the
 * visual (rich text) view and the source view are *projections* of it.
 *
 * Two properties make that work:
 *
 *  1. Every node caches `raw` — the exact source slice it was parsed from.
 *     A node that the user has not touched is reprinted from `raw`, so
 *     untouched LaTeX survives a visual-editing session byte for byte
 *     (comments, odd spacing, exotic macros, ...).
 *  2. Text nodes carry `escaped`: `false` means "value is literal LaTeX,
 *     print verbatim", `true` means "value is plain user text, LaTeX-escape
 *     it on the way out".  Nodes created by the rich text editor are escaped;
 *     nodes produced by the parser are literal.
 *
 * Node shapes
 * -----------
 *   root        { children }
 *   text        { value, escaped }
 *   comment     { value }                       // includes leading '%'
 *   command     { name, star, args[], textArg? }// \name*[opt]{req}...
 *   environment { name, endName, args[], children[], verbatim }
 *   group       { children }                    // a bare {...} not an argument
 *   argument    { optional, children, hasDelims }
 *   math        { mode: 'inline'|'display', delim, value }
 *   raw         { value }                       // unparseable, preserved as-is
 *
 * All nodes also carry `start`/`end` (source offsets, refreshed on every
 * print) and `_dirty` (needs re-serialisation).
 */

export const Kind = {
  Root: 'root',
  Text: 'text',
  Comment: 'comment',
  Command: 'command',
  Environment: 'environment',
  Group: 'group',
  Argument: 'argument',
  Math: 'math',
  Raw: 'raw',
};

let _nextId = 1;

/** Attach identity/bookkeeping fields shared by every node. */
function init(node) {
  node.id = _nextId++;
  node.raw = '';
  node.start = 0;
  node.end = 0;
  node._dirty = true;
  return node;
}

export function root(children = []) {
  return init({ kind: Kind.Root, children });
}

export function text(value, { escaped = true, raw = null } = {}) {
  const n = init({ kind: Kind.Text, value, escaped });
  if (raw !== null) {
    n.raw = raw;
    n._dirty = false;
  }
  return n;
}

export function comment(value) {
  return init({ kind: Kind.Comment, value });
}

export function raw(value) {
  return init({ kind: Kind.Raw, value });
}

export function group(children = []) {
  return init({ kind: Kind.Group, children });
}

export function argument(children = [], { optional = false, hasDelims = true } = {}) {
  return init({ kind: Kind.Argument, optional, children, hasDelims });
}

export function command(name, args = [], { star = false } = {}) {
  return init({ kind: Kind.Command, name, star, args });
}

export function environment(name, children = [], { args = [], endName = null, verbatim = false } = {}) {
  return init({
    kind: Kind.Environment,
    name,
    endName: endName === null ? name : endName,
    args,
    children,
    verbatim,
  });
}

export function math(value, { mode = 'inline', delim = '$' } = {}) {
  const n = init({ kind: Kind.Math, value, mode, delim });
  n.raw = delim + value + (delim === '\\(' ? '\\)' : delim === '\\[' ? '\\]' : delim);
  n._dirty = false;
  return n;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export const isNode = (n) => n && typeof n === 'object' && typeof n.kind === 'string';

/** Children of any container node (arguments included). */
export function childrenOf(node) {
  switch (node.kind) {
    case Kind.Root:
    case Kind.Group:
    case Kind.Environment:
    case Kind.Argument:
      return node.children;
    case Kind.Command:
      return node.args;
    default:
      return null;
  }
}

/** Walk the tree depth-first, calling `visit(node, parent, list, index)`. */
export function walk(node, visit, parent = null, list = null, index = -1) {
  if (!isNode(node)) return;
  const stop = visit(node, parent, list, index);
  if (stop === false) return;
  const kids = childrenOf(node);
  if (kids) for (let i = 0; i < kids.length; i++) walk(kids[i], visit, node, kids, i);
}

/** Mark a node (and every ancestor) as needing re-serialisation. */
export function markDirty(node) {
  let n = node;
  while (n && n._dirty !== true) {
    n._dirty = true;
    n = n.parent || null;
  }
  if (node) node._dirty = true;
}

/**
 * Re-establish `parent` links over a subtree.  The parser and the editors
 * maintain these; `markDirty` relies on them to invalidate ancestors.
 */
export function link(parent, kids) {
  if (!kids) return;
  // A list remembers its owner, which is how the reconciler finds the node to
  // invalidate after it rewrites the list's contents.
  kids.__parent = parent;
  for (const k of kids) {
    if (isNode(k)) {
      k.parent = parent;
      const sub = childrenOf(k);
      if (sub) link(k, sub);
    }
  }
}

/** Rebuild every parent pointer in the tree. */
export function relink(node) {
  const kids = childrenOf(node);
  if (!kids) return;
  for (const k of kids) {
    if (isNode(k)) k.parent = node;
  }
  for (const k of kids) {
    if (isNode(k)) relink(k);
  }
}

// ---------------------------------------------------------------------------
// Flattening / text extraction
// ---------------------------------------------------------------------------

/** Concatenate the literal source of a node list (clean nodes use `raw`). */
export function flatten(nodes) {
  let out = '';
  for (const n of nodes) {
    if (!isNode(n)) continue;
    out += n.raw ?? '';
  }
  return out;
}

/**
 * Plain-text content of a node list, used for tooltips, outline labels,
 * word counts and search.  Markup is dropped, math is kept as-is.
 */
export function plainText(nodes, { mathAs = 'tex', max = Infinity } = {}) {
  let out = '';
  const push = (s) => {
    if (out.length < max) out += s;
  };
  walkAllOf(nodes, (n) => {
    switch (n.kind) {
      case Kind.Text:
        push(n.escaped ? n.value : unescapeTex(n.value));
        break;
      case Kind.Math:
        push(mathAs === 'tex' ? `$${n.value}$` : ` ${n.value} `);
        break;
      case Kind.Command: {
        if (n.name === 'item') push('\n');
        else if (n.name === '\\' || n.name === 'newline' || n.name === 'linebreak') push('\n');
        else if (n.name === 'quad' || n.name === 'qquad') push(' ');
        break;
      }
      case Kind.Comment:
        break;
      case Kind.Raw:
        push(unescapeTex(n.value));
        break;
    }
  });
  return out.replace(/[ \t]*\n[ \t]*/g, '\n');
}

/** Depth-first walk over a *list* of nodes. */
export function walkAllOf(nodes, visit) {
  for (const n of nodes) {
    if (!isNode(n)) continue;
    visit(n);
    const kids = childrenOf(n);
    if (kids) walkAllOf(kids, visit);
  }
}

/** True when a node list contains no printable content (only whitespace/comments). */
export function isBlank(nodes) {
  for (const n of nodes) {
    if (!isNode(n)) continue;
    if (n.kind === Kind.Text && !n.value.trim()) continue;
    if (n.kind === Kind.Comment) continue;
    if (n.kind === Kind.Command && ZERO_WIDTH_COMMANDS.has(n.name)) continue;
    return false;
  }
  return true;
}

const ZERO_WIDTH_COMMANDS = new Set(['label', 'index', 'hypertarget', 'protect', 'relax', 'noindent', 'smallskip', 'medskip', 'bigskip', 'vspace', 'hspace', 'par']);

/** Split a text value into leading whitespace, body and trailing whitespace. */
export function splitOuterWhitespace(value) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
  if (!m) return { lead: '', body: value, trail: '' };
  return { lead: m[1], body: m[2], trail: m[3] };
}

/**
 * Replace the visible content of a text node while keeping the whitespace
 * around it (line breaks, indentation, paragraph gaps).
 *
 * This is the sanctioned way to edit text in the CST: the visual editor
 * always goes through it, because dropping a paragraph break by accident is
 * the single easiest way to corrupt a document from a rich-text view.
 */
export function setTextContent(node, newText, { keepOuter = true } = {}) {
  if (keepOuter) {
    const { lead, trail } = splitOuterWhitespace(node.value);
    node.value = lead + newText + trail;
  } else {
    node.value = newText;
  }
  node.escaped = true;
  markDirty(node);
  return node;
}

/** The visible content of a text node, without surrounding whitespace. */
export function textContent(node) {
  const value = node.escaped ? node.value : unescapeTex(node.value);
  return splitOuterWhitespace(value).body;
}

/** Deep clone a node subtree (ids are regenerated). */
export function cloneNode(node) {
  const copy = { ...node };
  copy.id = _nextId++;
  if (copy.args) copy.args = node.args.map(cloneNode);
  if (copy.children) copy.children = node.children.map(cloneNode);
  delete copy.parent;
  if (copy.children) link(copy, copy.children);
  if (copy.args) link(copy, copy.args);
  return copy;
}

// ---------------------------------------------------------------------------
// LaTeX text escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '$': '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  '_': '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/** Plain text -> literal LaTeX. */
export function escapeTex(value) {
  return String(value).replace(/[\\{}$&#%_~^]/g, (c) => ESCAPE_MAP[c]);
}

/** Literal LaTeX -> best-effort plain text (for display). */
export function unescapeTex(value) {
  return String(value)
    .replace(/\\textbackslash\{\}/g, '\\')
    .replace(/\\textasciitilde\{\}/g, '~')
    .replace(/\\textasciicircum\{\}/g, '^')
    .replace(/\\([\\{}$&#%_~^])/g, '$1')
    .replace(/\\\\/g, '\n')
    .replace(/\\[a-zA-Z]+\s?/g, '');
}
