/**
 * ATexVisualEditor — LaTeX printer.
 *
 * The printer walks the CST left to right.  A node that is not dirty is
 * emitted from its cached `raw` slice without looking inside, which is what
 * keeps untouched LaTeX byte-identical across a visual-editing session (and
 * makes printing O(changed) rather than O(document)).
 *
 * While walking, every node's `start`/`end` offsets are recomputed, so the
 * tree stays valid for source↔visual position mapping after each edit.
 */

import * as ast from './ast.js';
import { Kind } from './ast.js';

/** Only these commands are printed back with a `*` after their name. */
const STARRED = new Set([
  'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
  'chapter', 'part', 'newcommand', 'renewcommand', 'providecommand',
]);

class Printer {
  constructor() {
    this.out = '';
  }

  emit(str) {
    this.out += str;
  }

  /** Serialise a node, updating `raw`/`start`/`end` as it goes. */
  node(node) {
    if (!ast.isNode(node)) return;
    if (!node._dirty && node.raw) {
      const at = this.out.length;
      this.emit(node.raw);
      node.start = at;
      node.end = at + node.raw.length;
      return;
    }
    const start = this.out.length;
    node.start = start;
    switch (node.kind) {
      case Kind.Root:
        this.list(node.children);
        break;
      case Kind.Group:
        this.emit('{');
        this.list(node.children);
        this.emit('}');
        break;
      case Kind.Argument:
        this.argument(node);
        break;
      case Kind.Command:
        this.command(node);
        break;
      case Kind.Environment:
        this.environment(node);
        break;
      case Kind.Text:
        this.emit(node.escaped ? ast.escapeTex(node.value) : node.value);
        break;
      case Kind.Comment:
        this.emit(node.value);
        break;
      case Kind.Math:
        this.math(node);
        break;
      case Kind.Raw:
        this.emit(node.value);
        break;
      default:
        this.emit(node.raw || '');
        break;
    }
    node.end = this.out.length;
    node.raw = this.out.slice(start, node.end);
    node._dirty = false;
  }

  list(nodes) {
    if (!nodes) return;
    for (const n of nodes) this.node(n);
  }

  math(node) {
    const { delim, value } = node;
    switch (delim) {
      case '$$':
        this.emit(`$$${value}$$`);
        break;
      case '\\(':
        this.emit(`\\(${value}\\)`);
        break;
      case '\\[':
        this.emit(`\\[${value}\\]`);
        break;
      case 'env':
        this.emit(value);
        break;
      default:
        this.emit(`$${value}$`);
        break;
    }
  }

  argument(node) {
    if (node.lead) this.emit(node.lead);
    if (node.verbDelim) {
      const body = node.children && node.children.length ? literalOf(node.children) : '';
      this.emit(`${node.verbDelim}${body}${node.verbDelim}`);
      return;
    }
    const open = node.optional ? '[' : '{';
    const close = node.optional ? ']' : '}';
    this.emit(open);
    this.list(node.children);
    this.emit(close);
  }

  command(node) {
    // Letter commands print as `\name`; punctuation commands as `\x`.
    this.emit(`\\${node.name}`);
    if (node.star) this.emit('*');
    this.list(node.args);
  }

  environment(node) {
    this.emit('\\begin');
    this.emit(node.nameRaw || `{${node.name}}`);
    this.list(node.args);
    this.list(node.children);
    // `closed === false` marks an environment whose \end belonged to an outer
    // environment (recovered from malformed input) — do not invent one.
    if (node.closed !== false) {
      this.emit(`\\end{${node.endName || node.name}}`);
    }
  }
}

/** The literal LaTeX held by a verbatim text node. */
function literalOf(children) {
  let out = '';
  for (const c of children) {
    if (c.kind === Kind.Text) out += c.escaped ? ast.escapeTex(c.value) : c.value;
    else out += c.raw || '';
  }
  return out;
}

/**
 * Serialise a node, returning the LaTeX text and refreshing offsets.
 * @param {object} node
 * @returns {string}
 */
export function printNode(node) {
  const p = new Printer();
  p.node(node);
  return p.out;
}

/** Convenience: print a list of nodes. */
export function printNodes(nodes) {
  const p = new Printer();
  p.list(nodes);
  return p.out;
}

/**
 * Serialise a whole document and keep `root` as the live tree.
 * @returns {string} the full LaTeX source
 */
export function printDocument(root) {
  return printNode(root);
}
