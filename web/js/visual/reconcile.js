/**
 * ATexVisualEditor — reading edits back out of the DOM.
 *
 * The rich text view is a projection of the CST, so after the browser has
 * touched the DOM we work out what changed and write it back.  The unit of
 * bookkeeping is a *piece*: every text node the renderer shows is registered
 * against the CST text node it came from (its "original").  Usually a piece and
 * its original are the same object; when a text node spans a paragraph break it
 * is sliced, and one original owns several pieces (the paragraph's leading
 * whitespace, its content, its trailing whitespace).
 *
 * Editing then becomes uniform: an edit is "piece P now reads X" (or, for a
 * deletion, "piece P now reads nothing").  Committing walks the pieces of every
 * touched original in order, flushing verbatim text unchanged and emitting new
 * escaped text where the user typed — so a comment at the end of the paragraph
 * the user edited stays exactly where it was.
 *
 * Conservative by design:
 *   * Elements the renderer created carry `data-nid`; they are recognised by
 *     identity and reused, so the LaTeX inside them is never rewritten.
 *   * Text equal to what the CST would render is kept byte for byte.
 *   * Browser-inserted formatting (`<strong>`, `<em>`, pasted markup) becomes
 *     new CST commands; user text is marked as plain text so the printer
 *     escapes it.
 *   * Deleting a rendered element deletes its node.  Nothing is inferred that
 *     the user did not visibly do.
 */

import * as ast from '../core/ast.js';
import { Kind } from '../core/ast.js';
import { escapeTex } from '../core/ast.js';
import { displayText, normalizeText, textFromDom, patchTextValue } from './text-util.js';

/** DOM tag -> LaTeX command for formatting the browser inserts by itself. */
const TAG_TO_COMMAND = {
  B: 'textbf',
  STRONG: 'textbf',
  I: 'emph',
  EM: 'emph',
  U: 'underline',
  INS: 'underline',
  S: 'sout',
  STRIKE: 'sout',
  DEL: 'sout',
  CODE: 'texttt',
  KBD: 'texttt',
  SAMP: 'texttt',
  MARK: 'emph',
  SUP: 'textsuperscript',
  SUB: 'textsubscript',
  SMALL: 'textsc',
  VAR: 'texttt',
};

/** Elements with no LaTeX meaning: transparent to the reader. */
const TRANSPARENT_TAGS = new Set([
  'SPAN', 'FONT', 'ABBR', 'TIME', 'BDI', 'RUBY', 'RT', 'WBR', 'NOBR', 'ACRONYM', 'LABEL',
]);

export class ReconcileContext {
  constructor(doc) {
    this.doc = doc;
    /** node id -> CST node, refreshed on every render. */
    this.byId = new Map();
    /** CST node -> the DOM element representing it. */
    this.elements = new Map();
    /** original CST text node -> [piece] */
    this.pieces = new Map();
    /** piece -> {text} replacement requested by an edit */
    this.pieceEdits = new Map();
    /** anchor node -> nodes to insert before/after it */
    this.insertions = new Map();
    /** nodes removed from the tree by an edit */
    this.deletions = new Set();
    /** node -> true, for non-text nodes whose inner content changed */
    this.innerChanged = new Set();
    /** lists that need rebuilding: list -> owning node */
    this.touchedLists = new Map();
  }

  reset() {
    this.byId.clear();
    this.elements.clear();
    this.pieces.clear();
    this.pieceEdits.clear();
    this.insertions.clear();
    this.deletions.clear();
    this.innerChanged.clear();
    this.touchedLists.clear();
  }

  register(node, element) {
    this.byId.set(node.id, node);
    if (element) this.elements.set(node, element);
  }

  elementFor(node) {
    return this.elements.get(node) || null;
  }

  /** Register a rendered text node as a piece of its original. */
  registerPiece(rendered, original, order = 0) {
    const piece = { node: rendered, original, order };
    if (!this.pieces.has(original)) this.pieces.set(original, []);
    this.pieces.get(original).push(piece);
    return piece;
  }

  /** The piece that renders `rendered` (a text node in the CST). */
  pieceFor(rendered) {
    const original = rendered.sliceOf || rendered;
    const pieces = this.pieces.get(original);
    if (!pieces || !pieces.length) return null;
    return pieces.find((piece) => piece.node === rendered) || null;
  }

  /** The piece for `rendered`, registering it if the renderer did not. */
  ensurePiece(rendered) {
    const existing = this.pieceFor(rendered);
    if (existing) return existing;
    const original = rendered.sliceOf || rendered;
    return this.registerPiece(rendered, original, rendered.order || 0);
  }

  /**
   * Record that a piece now reads `text` (an empty string means deleted).
   * `raw: true` means the text is literal LaTeX; otherwise it is plain text and
   * will be escaped when the node is printed.
   */
  noteText(piece, text, { raw = false } = {}) {
    this.pieceEdits.set(piece, { text, raw });
    this.touch(piece.original);
  }

  noteDeleted(node, list) {
    this.deletions.add(node);
    this.touch(node, list);
  }

  noteInsertion(anchor, nodes, { before = false } = {}) {
    const key = anchor;
    if (!this.insertions.has(key)) this.insertions.set(key, { before: [], after: [] });
    const bucket = this.insertions.get(key);
    if (before) bucket.before.push(...nodes);
    else bucket.after.push(...nodes);
    this.touch(anchor.node || anchor);
  }

  noteInnerChanged(node) {
    this.innerChanged.add(node);
    this.touch(node);
  }

  touch(node, list = null) {
    const target = list || (node && node.parent ? ast.childrenOf(node.parent) : null);
    if (target) this.touchedLists.set(target, this.ownerOf(target));
  }

  /** The node that owns a child list (for invalidation after a rebuild). */
  ownerOf(list) {
    if (list.__parent) return list.__parent;
    for (const node of list) {
      if (node && node.parent) return node.parent;
    }
    return null;
  }

  get hasEdits() {
    return (
      this.pieceEdits.size > 0 ||
      this.insertions.size > 0 ||
      this.deletions.size > 0
    );
  }

  /**
   * Write every recorded edit back into the CST.
   * @returns {number} the number of lists that changed
   */
  commit() {
    let rebuilt = 0;
    for (const [list, recordedOwner] of this.touchedLists) {
      const next = [];
      let listChanged = false;

      for (const node of list) {
        if (this.deletions.has(node)) {
          listChanged = true;
          continue;
        }
        const emitted = this.emitNode(node, (changed) => {
          if (changed) listChanged = true;
        });
        if (emitted) next.push(...emitted);
      }

      if (listChanged) {
        const parent = this.ownerOf(list) || recordedOwner || null;
        list.length = 0;
        list.__parent = parent || undefined;
        for (const node of next) {
          if (parent) node.parent = parent;
          list.push(node);
        }
        if (parent) {
          ast.link(parent, list);
          // Invalidating the owner is what carries the edit up to the root, and
          // therefore into the printed source.  Without it the printer would
          // emit the ancestor's cached raw slice and the edit would vanish.
          ast.markDirty(parent);
        }
        rebuilt++;
      }
    }
    this.pieceEdits.clear();
    this.insertions.clear();
    this.deletions.clear();
    this.touchedLists.clear();
    return rebuilt;
  }

  /** Emit the CST node(s) that replace `node` after the recorded edits. */
  emitNode(node, onChange) {
    const out = [];
    const push = (item) => out.push(item);

    const insertion = this.insertions.get(node);
    if (insertion) {
      for (const extra of insertion.before) push(extra);
    }

    if (node.kind === Kind.Text && this.pieces.has(node) && this.hasPieceEdits(node)) {
      const pieces = this.rebuildPieces(node);
      const changed = pieces.length !== 1 || pieces[0] !== node;
      if (changed) onChange(true);
      for (const piece of pieces) push(piece);
    } else {
      if (this.innerChanged.has(node)) onChange(true);
      push(node);
    }

    if (insertion) {
      for (const extra of insertion.after) push(extra);
    }
    return out;
  }

  hasPieceEdits(original) {
    const pieces = this.pieces.get(original) || [];
    return pieces.some((piece) => this.pieceEdits.has(piece));
  }

  /**
   * Rebuild an original text node from its pieces.
   * Unchanged pieces are reproduced verbatim; edited pieces become new,
   * escaped text; a piece can also carry insertions (new formatting).
   */
  rebuildPieces(original) {
    const pieces = (this.pieces.get(original) || []).slice().sort((a, b) => a.order - b.order);
    /** @type {Array<{text:string, escaped:boolean}|object>} */
    const runs = [];
    let acc = '';
    let accEscaped = original.escaped;

    const flush = () => {
      if (!acc) return;
      runs.push({ text: acc, escaped: accEscaped });
      acc = '';
    };

    for (const piece of pieces) {
      const edit = this.pieceEdits.get(piece);
      const insertion = this.insertions.get(piece);
      const value = edit ? edit.text : piece.node.value;
      // A raw edit is already valid LaTeX; a plain edit must be escaped on the
      // way out (and may join the neighbouring raw text in the same run).
      const escaped = edit ? !edit.raw : piece.node.escaped;
      if (edit) {
        if (edit.raw && escaped === accEscaped) {
          // Raw edit: concatenate with the surrounding verbatim text.
          acc += value;
        } else {
          flush();
          if (value) runs.push({ text: value, escaped: escaped });
        }
      } else {
        if (escaped !== accEscaped) {
          flush();
          accEscaped = escaped;
        }
        acc += value;
      }
      if (insertion) {
        flush();
        for (const node of insertion.before) runs.push(node);
        for (const node of insertion.after) runs.push(node);
      }
    }
    flush();

    // Merge adjacent text runs and turn them into CST nodes.
    const out = [];
    for (const run of runs) {
      if (run.text !== undefined) {
        const last = out[out.length - 1];
        if (last && last.kind === Kind.Text && last.escaped === run.escaped && !last.__slice) {
          last.value += run.text;
          ast.markDirty(last);
          continue;
        }
        const node = ast.text(run.text, { escaped: run.escaped });
        out.push(node);
      } else {
        out.push(run);
      }
    }
    if (!out.length) return [];
    return out;
  }
}

// ---------------------------------------------------------------------------
// Reading a container
// ---------------------------------------------------------------------------

/**
 * Reconcile the direct children of `containerEl` against `slots`.
 *
 * @param {Element} containerEl contenteditable element holding the content
 * @param {object[]} slots `[{node, visible, order?}]` in source order
 * @param {ReconcileContext} ctx
 * @param {Array} list the CST list these nodes live in
 * @returns {{changed: boolean}}
 */
export function reconcileSlots(containerEl, slots, ctx, list) {
  const expected = [];
  for (const entry of slots) {
    const node = entry.node;
    if (!entry.visible) continue;
    if (node.kind === Kind.Text) {
      const last = expected[expected.length - 1];
      if (last && last.type === 'text') last.entries.push(node);
      else expected.push({ type: 'text', entries: [node] });
    } else {
      expected.push({ type: 'node', node });
    }
  }

  const domItems = [];
  for (const child of Array.from(containerEl.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const last = domItems[domItems.length - 1];
      if (last && last.type === 'text') last.text += child.data;
      else domItems.push({ type: 'text', text: child.data });
      continue;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      if (child.__atexSkip) continue;
      domItems.push({ type: 'element', el: child });
    }
  }

  let changed = false;
  let ei = 0;
  /** Where new content produced by this reconcile should be anchored. */
  let lastAnchor = null;

  const anchorFor = (slotEntries) => {
    const first = slotEntries[0];
    if (!first) return null;
    if (first.kind !== Kind.Text) return first;
    return ctx.pieceFor(first) || ctx.ensurePiece(first);
  };

  const creationAnchor = () => {
    // New content typed at the end of a container attaches to the last
    // recognised piece/node so it lands in the right place in the CST.
    if (lastAnchor) return lastAnchor;
    for (let i = expected.length - 1; i >= 0; i--) {
      const slot = expected[i];
      const entry = slot.type === 'text' ? slot.entries[slot.entries.length - 1] : slot.node;
      const anchor = anchorFor([entry]);
      if (anchor) return anchor;
    }
    return null;
  };

  const consumeText = (domText) => {
    const slot = expected[ei];
    if (!slot || slot.type !== 'text') {
      const created = textFromDom(domText);
      if (created) insertNew([ast.text(created, { escaped: true })]);
      return;
    }
    ei++;
    const rendered = slot.entries.map(displayText).join('');
    if (normalizeText(domText) === normalizeText(rendered)) {
      lastAnchor = anchorFor(slot.entries);
      return;
    }
    // The text really changed.  Patch the first piece in place (keeping the
    // untouched part of the raw LaTeX, including its line breaks) and blank the
    // rest so nothing is duplicated.
    const newText = textFromDom(domText);
    slot.entries.forEach((entry, index) => {
      const piece = ctx.ensurePiece(entry);
      if (index === 0) {
        const value = piece.node && typeof piece.node.value === 'string' ? piece.node.value : '';
        ctx.noteText(piece, patchTextValue(value, newText, escapeTex), { raw: true });
      } else {
        ctx.noteText(piece, '');
      }
    });
    lastAnchor = anchorFor(slot.entries);
    changed = true;
  };

  const insertNew = (nodes) => {
    if (!nodes.length) return;
    const anchor = creationAnchor();
    if (anchor) ctx.noteInsertion(anchor, nodes);
    else {
      // Nothing to anchor to: put the content at the head of the list.
      const sentinel = list.find((n) => ast.isNode(n));
      if (sentinel) ctx.noteInsertion(sentinel, nodes, { before: true });
      else for (const node of nodes) list.push(node);
    }
    changed = true;
  };

  for (const item of domItems) {
    if (item.type === 'text') {
      consumeText(item.text);
      continue;
    }
    const el = item.el;
    const nid = Number(el.dataset ? el.dataset.nid : 0);
    const known = nid ? ctx.byId.get(nid) : null;

    if (known) {
      // Skip over expected entries the user deleted before this one.
      while (ei < expected.length && expected[ei].type === 'node' && expected[ei].node !== known) {
        ctx.noteDeleted(expected[ei].node, list);
        changed = true;
        ei++;
      }
      if (expected[ei] && expected[ei].type === 'node' && expected[ei].node === known) ei++;
      if (reconcileInside(known, el, ctx)) changed = true;
      lastAnchor = known;
      continue;
    }

    const mapped = mapForeignElement(el, ctx, list);
    if (mapped && mapped.length) insertNew(mapped);
  }

  // Anything left in `expected` is gone from the DOM.
  for (; ei < expected.length; ei++) {
    const slot = expected[ei];
    if (slot.type === 'node') {
      ctx.noteDeleted(slot.node, list);
    } else {
      for (const entry of slot.entries) {
        const piece = ctx.pieceFor(entry);
        if (piece) ctx.noteText(piece, '');
        else ctx.noteDeleted(entry, list);
      }
    }
    changed = true;
  }

  return { changed };
}

/**
 * Reconcile the inside of a rendered element: a command's argument, a heading
 * title, a list item.  Returns true when something changed.
 */
export function reconcileInside(node, element, ctx) {
  const inner = element.querySelector(':scope > [data-inner]');
  if (!inner || !inner.__atexSlots) return false;
  const { slots, list } = inner.__atexSlots;
  if (!slots) return false;
  const result = reconcileSlots(inner, slots, ctx, list);
  if (result.changed) {
    ctx.noteInnerChanged(node);
    return true;
  }
  return false;
}

/**
 * Turn a DOM element the renderer did not create into CST nodes.
 * Returns null when the element should be skipped.
 */
function mapForeignElement(el, ctx, list) {
  const tag = el.tagName;
  if (tag === 'BR') return [ast.text('\n', { escaped: true })];

  const inner = [];
  const collect = (parent) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = textFromDom(child.data);
        if (text) inner.push(ast.text(text, { escaped: true }));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const nid = Number(child.dataset ? child.dataset.nid : 0);
      const known = nid ? ctx.byId.get(nid) : null;
      if (known) {
        reconcileInside(known, child, ctx);
        inner.push(known);
        continue;
      }
      const nested = mapForeignElement(child, ctx, list);
      if (nested) inner.push(...nested);
    }
  };
  collect(el);

  const command = TAG_TO_COMMAND[tag];
  if (command && inner.length) {
    const arg = ast.argument(inner);
    ast.link(arg, inner);
    const node = ast.command(command, [arg]);
    ast.link(node, [arg]);
    return [node];
  }
  if (TRANSPARENT_TAGS.has(tag) || command) return inner.length ? inner : null;
  // Unknown tag (pasted <table>, <img>, ...): keep the text, drop the tag.
  return inner.length ? inner : null;
}

/**
 * The nearest block element containing `node`.
 *
 * Blocks are tagged with `data-block-type` (and their source range); this is
 * what every structural command uses to find out where the caret is, so the
 * attribute name has to match what the renderer writes.
 */
export function blockElementOf(node, root) {
  if (!node) return null;
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== root) {
    if (el.dataset && el.dataset.blockType) return el;
    el = el.parentElement;
  }
  return null;
}
