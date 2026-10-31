/**
 * ATexVisualEditor — the visual (WYSIWYG) editor.
 *
 * How editing works
 * -----------------
 *  * **Typing and inline formatting** happen in the DOM.  On `input` the
 *    reconciler works out what changed and writes it back into the CST, then the
 *    printer refreshes the source.  The block is *not* re-rendered, so the caret
 *    and IME composition are never disturbed.
 *  * **Structural edits** (new paragraph, indent a list item, insert a figure,
 *    change a heading level, …) are done by splicing the *source text* at exact
 *    offsets and reparsing.  That sounds blunt, but it is the most reliable
 *    approach available: offsets come straight from the CST, the file stays
 *    valid, and there is exactly one code path instead of dozens of AST
 *    surgery routines.  Re-rendering afterwards is a few milliseconds.
 */

import * as ast from '../core/ast.js';
import { Kind } from '../core/ast.js';
import { SECTION_LEVELS } from '../core/latex-knowledge.js';
import { buildBlocks, BlockType, splitListItems, readTable, readColumnSpec } from './blocks.js';
import { ReconcileContext, reconcileSlots, blockElementOf } from './reconcile.js';
import {
  renderDocument,
  renderBlocks,
  renderInline,
  renderMathInto,
  computeNumbering,
  captureCaret,
  restoreCaret,
} from './render.js';
import { normalizeText, rawOffsetForDisplay } from './text-util.js';
import { popover, modal, formModal, promptModal, toast, closePopover } from '../ui/overlays.js';
import { icon } from '../ui/icons.js';
import { MATH_PALETTE } from '../core/latex-knowledge.js';

export class VisualEditor {
  constructor({ mount, doc, projectId = '', settings = {}, callbacks = {} }) {
    this.mount = mount;
    this.doc = doc;
    this.projectId = projectId;
    this.settings = {
      showRefKeys: false,
      serverMathPreview: true,
      ...settings,
    };
    this.callbacks = callbacks;
    this.rc = new ReconcileContext(doc);
    this.blocks = [];
    this.textMap = new Map();
    this.footnoteNumbers = new Map();
    this.figureNumbers = new Map();
    this.tableNumbers = new Map();
    this.selectionState = null;
    this.pendingFlush = null;
    this.mathPreviewCache = new Map();
    this.composing = false;
    this.editable = true;
    this.root = null;
    this._build();
  }

  // -- construction --------------------------------------------------------

  _build() {
    this.mount.replaceChildren();
    const root = document.createElement('div');
    root.className = 'atex-visual-root';
    root.setAttribute('contenteditable', 'true');
    root.setAttribute('spellcheck', this.settings.spellCheck === false ? 'false' : 'true');
    root.setAttribute('autocorrect', 'off');
    root.setAttribute('autocapitalize', 'off');
    root.dataset.placeholder = 'Start writing…';
    this.mount.appendChild(root);
    this.root = root;

    root.addEventListener('input', (event) => this._onInput(event));
    root.addEventListener('keydown', (event) => this._onKeyDown(event));
    root.addEventListener('keyup', () => this._reportSelection());
    root.addEventListener('mouseup', () => this._reportSelection());
    root.addEventListener('focus', () => this._reportSelection());
    root.addEventListener('blur', () => {
      this.flush();
      this.callbacks.onSelectionChange?.(null);
    });
    root.addEventListener('paste', (event) => this._onPaste(event));
    root.addEventListener('drop', (event) => this._onDrop(event));
    root.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    });
    root.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    root.addEventListener('compositionend', () => {
      this.composing = false;
      this._onInput({ target: root });
    });
    root.addEventListener('click', (event) => this._onClick(event));
    root.addEventListener('dblclick', (event) => this._onDoubleClick(event));
    root.addEventListener('beforeinput', (event) => this._onBeforeInput(event));
    this.render();
  }

  // -- rendering -----------------------------------------------------------

  /** Rebuild the whole visual view from the CST. */
  render({ preserveCaret = true, caret = null } = {}) {
    const snapshot = caret || (preserveCaret ? captureCaret(this.root) : null);
    const { footnoteNumbers, figureNumbers, tableNumbers } = computeNumbering(this.doc);
    this.footnoteNumbers = footnoteNumbers;
    this.figureNumbers = figureNumbers;
    this.tableNumbers = tableNumbers;

    this.rc.reset();
    this.textMap.clear();
    this.doc.root.children.__parent = this.doc.root;
    const { blocks } = buildBlocks(this.doc.root.children);
    this.blocks = blocks;

    const ctx = {
      doc: this.doc,
      rc: this.rc,
      settings: this.settings,
      projectId: this.projectId,
      footnoteNumbers,
      figureNumbers,
      tableNumbers,
      currentList: this.doc.root.children,
      textMap: this.textMap,
      blocks,
      onGotoSource: (offset) => this.callbacks.onRevealSource?.(offset),
    };
    this.ctx = ctx;
    renderDocument(this.root, this.doc, ctx);
    if (snapshot) restoreCaret(this.root, snapshot);
    this._applyMathPreviews();
    this.callbacks.onRendered?.(this);
    return this;
  }

  /** Upgrade display math to a real TeX rendering (honours user macros). */
  _applyMathPreviews() {
    if (!this.settings.serverMathPreview || !this.projectId) return;
    const nodes = [];
    for (const element of this.root.querySelectorAll('.atex-display-math[data-nid]')) {
      const node = this.rc.byId.get(Number(element.dataset.nid));
      if (node) nodes.push({ element, node });
    }
    for (const { element, node } of nodes.slice(0, 24)) {
      // The full environment source: the server maps display environments to
      // their inline-compatible counterparts (the standalone class refuses
      // `\\[...\\]`, so a displaystyle formula is used instead).
      const latex = node.kind === Kind.Math ? node.value : (node.raw || '').trim();
      if (!latex) continue;
      const key = latex;
      const cached = this.mathPreviewCache.get(key);
      if (cached) {
        if (cached !== null) this._swapMath(element, cached);
        continue;
      }
      fetch('/api/math/svg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latex, display: true, preamble: this.doc.preamble() }),
      })
        .then((response) => (response.ok ? response.json() : { svg: null }))
        .then((data) => {
          this.mathPreviewCache.set(key, data.svg || null);
          if (data.svg) this._swapMath(element, data.svg);
        })
        .catch(() => this.mathPreviewCache.set(key, null));
    }
  }

  _swapMath(element, svg) {
    const body = element.querySelector('.katex-display') || element;
    const holder = document.createElement('div');
    holder.className = 'atex-math-tex';
    holder.innerHTML = svg;
    const svgEl = holder.querySelector('svg');
    if (!svgEl) return;
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.style.maxWidth = '100%';
    svgEl.style.height = 'auto';
    body.replaceWith(holder);
    element.classList.add('atex-math-upgraded');
  }

  // -- writing back --------------------------------------------------------

  /** Push DOM edits into the CST and refresh the source text. */
  flush({ kind = 'typing' } = {}) {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    const changed = this._reconcile();
    if (!changed) return false;
    const source = this.printFromTree(kind);
    this.callbacks.onEdited?.({ origin: 'visual', source });
    return true;
  }

  _reconcile() {
    const current = captureCaret(this.root);
    let changed = false;
    // Every block with rendered content gets a pass; the reconciler compares
    // against the CST and only records real differences.
    const seen = new Set();
    for (const element of this.root.querySelectorAll('[data-inner]')) {
      const slots = element.__atexSlots;
      if (!slots || seen.has(element)) continue;
      seen.add(element);
      const result = reconcileSlots(element, slots.slots, this.rc, slots.list);
      if (result.changed) changed = true;
    }
    if (this.rc.hasEdits) {
      const rebuilt = this.rc.commit();
      if (rebuilt) changed = true;
    }
    void current;
    return changed;
  }

  /**
   * Reprint the document from the CST and return the new source.
   *
   * This goes through `doc.mutate` so the edit lands on the undo stack; the
   * history coalesces edits of the same kind within a moment, so a burst of
   * typing is a single undo step rather than one per keystroke.
   */
  printFromTree(kind = 'visual') {
    return this.doc.mutate(() => {}, { kind: kind === 'structural' ? 'structural' : 'typing' });
  }

  // -- source offsets ------------------------------------------------------

  /** The source offset corresponding to a DOM position. */
  sourceOffsetFor(domNode, domOffset, { preferEnd = false } = {}) {
    if (domNode.nodeType === Node.TEXT_NODE) {
      const node = this.textMap.get(domNode);
      if (node) {
        const raw = rawOffsetForDisplay(node.value, domOffset);
        return node.start + Math.min(raw, node.value.length);
      }
    }
    let element = domNode.nodeType === Node.ELEMENT_NODE ? domNode : domNode.parentElement;
    // A position between two rendered atoms: use the element boundary.
    if (domNode.nodeType === Node.ELEMENT_NODE) {
      const children = Array.from(domNode.childNodes);
      const before = children[domOffset - 1];
      const after = children[domOffset];
      if (after) {
        const offset = this._edgeOffset(after, false);
        if (offset !== null) return offset;
      }
      if (before) {
        const offset = this._edgeOffset(before, true);
        if (offset !== null) return offset;
      }
    }
    while (element && element !== this.root) {
      const nid = element.dataset ? element.dataset.nid : null;
      if (nid) {
        const node = this.rc.byId.get(Number(nid));
        if (node) return preferEnd ? node.end : node.start;
      }
      const srcStart = element.dataset ? element.dataset.srcStart : null;
      if (srcStart) return Number(srcStart);
      element = element.parentElement;
    }
    return this.doc.source.length;
  }

  _edgeOffset(domNode, atEnd) {
    if (domNode.nodeType === Node.TEXT_NODE) {
      const node = this.textMap.get(domNode);
      if (node) return atEnd ? node.end : node.start;
      return null;
    }
    if (domNode.nodeType === Node.ELEMENT_NODE && domNode.dataset?.nid) {
      const node = this.rc.byId.get(Number(domNode.dataset.nid));
      if (node) return atEnd ? node.end : node.start;
    }
    return null;
  }

  /** The source range covered by the current selection. */
  selectionRange() {
    const selection = globalThis.getSelection?.();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!this.root.contains(range.startContainer) || !this.root.contains(range.endContainer)) return null;
    const start = this.sourceOffsetFor(range.startContainer, range.startOffset);
    const end = this.selectionSourceEnd(range);
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      collapsed: range.collapsed,
      range,
      text: this.doc.source.slice(Math.min(start, end), Math.max(start, end)),
    };
  }

  selectionSourceEnd(range) {
    if (range.endContainer.nodeType === Node.TEXT_NODE) {
      const node = this.textMap.get(range.endContainer);
      if (node) return node.start + Math.min(rawOffsetForDisplay(node.value, range.endOffset), node.value.length);
    }
    return this.sourceOffsetFor(range.endContainer, range.endOffset, { preferEnd: true });
  }

  /** The block element (and its recorded source range) containing a DOM node. */
  blockInfo(domNode) {
    if (!domNode) return null;
    const element = blockElementOf(domNode, this.root);
    if (!element) return null;
    const start = Number(element.dataset.srcStart);
    const end = Number(element.dataset.srcEnd);
    return {
      element,
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      type: element.dataset.blockType,
    };
  }

  // -- structural editing --------------------------------------------------

  /**
   * Apply text edits to the source at exact offsets, reparse and re-render.
   *
   * @param {Array<{start:number, end:number, text:string}>} edits
   * @param {{caret?:number, atEnd?:boolean, kind?:string, node?:object}} opts
   */
  splice(edits, { caret = null, atEnd = false, kind = 'structural', preserveSelection = true } = {}) {
    // Make sure typed-but-uncommitted text is in the source first, so the
    // offsets we just computed still point at the right characters.
    this.flush({ kind: 'typing' });
    const sorted = edits.slice().sort((a, b) => b.start - a.start);
    let source = this.doc.source;
    let caretAt = caret;
    for (const edit of sorted) {
      const before = source.slice(0, edit.start);
      const after = source.slice(edit.end);
      source = before + edit.text + after;
      if (caretAt !== null && caretAt >= edit.end) caretAt += edit.text.length - (edit.end - edit.start);
    }
    this.doc.setSource(source, { commit: true, kind, silent: true });
    this.render({ preserveCaret: false });
    if (caretAt !== null) this.focusOffset(caretAt, { atEnd });
    else if (!preserveSelection && this.selectionState) this.focusOffset(this.selectionState.start);
    this.callbacks.onEdited?.({ origin: 'structural', source: this.doc.source });
    return source;
  }

  /** Put the caret at (or nearest) a source offset. */
  focusOffset(offset, { atEnd = false } = {}) {
    const blocks = Array.from(this.root.querySelectorAll('[data-block-type]'));
    let best = null;
    let bestDistance = Infinity;
    for (const element of blocks) {
      const start = Number(element.dataset.srcStart);
      const end = Number(element.dataset.srcEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (offset >= start && offset <= end) {
        const target = atEnd ? this._lastEditable(element) : this._firstEditable(element);
        if (target) return this._placeCaret(target.node, target.offset);
      }
      const distance = Math.min(Math.abs(offset - start), Math.abs(offset - end));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = element;
      }
    }
    if (best) {
      const target = atEnd ? this._lastEditable(best) : this._firstEditable(best);
      if (target) return this._placeCaret(target.node, target.offset);
    }
    return false;
  }

  _firstEditable(element) {
    const inner = element.querySelector('[data-inner]') || element;
    const position = this._edgePosition(inner, true);
    return position;
  }

  _lastEditable(element) {
    const inners = element.querySelectorAll('[data-inner]');
    const inner = inners.length ? inners[inners.length - 1] : element;
    return this._edgePosition(inner, false);
  }

  _edgePosition(element, atStart) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
    let first = null;
    let last = null;
    let current = walker.nextNode();
    while (current) {
      if (current.data.length) {
        if (!first) first = current;
        last = current;
      }
      current = walker.nextNode();
    }
    if (atStart) return first ? { node: first, offset: 0 } : { node: element, offset: 0 };
    return last ? { node: last, offset: last.data.length } : { node: element, offset: element.childNodes.length };
  }

  _placeCaret(node, offset) {
    try {
      const range = document.createRange();
      const limit = node.nodeType === Node.TEXT_NODE ? node.data.length : node.childNodes.length;
      range.setStart(node, Math.max(0, Math.min(offset, limit)));
      range.collapse(true);
      const selection = globalThis.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.root.focus({ preventScroll: true });
      this._reportSelection();
      return true;
    } catch {
      return false;
    }
  }

  /** Select a source range in the visual view (used by outline and search). */
  selectSourceRange(start, end) {
    const element = this._elementForOffset(start);
    if (!element) return false;
    const target = element.querySelector('[data-inner]') || element;
    const position = this._edgePosition(target, true);
    return this._placeCaret(position.node, position.offset);
  }

  _elementForOffset(offset) {
    let best = null;
    let bestSize = Infinity;
    for (const element of this.root.querySelectorAll('[data-block-type]')) {
      const start = Number(element.dataset.srcStart);
      const end = Number(element.dataset.srcEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (offset >= start && offset <= end) {
        const size = end - start;
        if (size < bestSize) {
          bestSize = size;
          best = element;
        }
      }
    }
    return best;
  }

  /** Scroll the block containing a source offset into view and flash it. */
  revealOffset(offset, { flash = true } = {}) {
    const element = this._elementForOffset(offset);
    if (!element) return false;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (flash) {
      element.classList.add('atex-flash');
      setTimeout(() => element.classList.remove('atex-flash'), 900);
    }
    return true;
  }

  // -- input handling ------------------------------------------------------

  _onInput() {
    if (this.composing) return;
    if (this.pendingFlush) clearTimeout(this.pendingFlush);
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      this.flush({ kind: 'typing' });
    }, 120);
  }

  _onBeforeInput(event) {
    // Delete a whole atom (a chip) with a single keystroke.
    if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
      const selection = globalThis.getSelection?.();
      if (!selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!range.collapsed) return;
      const target =
        event.inputType === 'deleteContentBackward' ? this._atomBefore(range) : this._atomAfter(range);
      if (target) {
        event.preventDefault();
        this.deleteAtom(target.atom, target.element);
      }
    }
    if (event.inputType === 'insertParagraph') {
      event.preventDefault();
      this.splitParagraph();
    }
  }

  _atomBefore(range) {
    const container = range.startContainer;
    const offset = range.startOffset;
    let sibling = null;
    if (container.nodeType === Node.TEXT_NODE) {
      if (offset > 0) return null;
      sibling = container.previousSibling;
    } else {
      sibling = container.childNodes[offset - 1];
      while (sibling && sibling.nodeType === Node.TEXT_NODE && !sibling.data) {
        sibling = sibling.previousSibling;
      }
    }
    if (!sibling || sibling.nodeType !== Node.ELEMENT_NODE) return null;
    const atom = this._nearestAtom(sibling);
    return atom ? { atom, element: atom } : null;
  }

  _atomAfter(range) {
    const container = range.startContainer;
    const offset = range.startOffset;
    let sibling = null;
    if (container.nodeType === Node.TEXT_NODE) {
      if (offset < container.data.length) return null;
      sibling = container.nextSibling;
    } else {
      sibling = container.childNodes[offset];
    }
    if (!sibling || sibling.nodeType !== Node.ELEMENT_NODE) return null;
    return this._nearestAtom(sibling) ? { atom: sibling, element: sibling } : null;
  }

  _nearestAtom(element) {
    const nid = element.dataset?.nid;
    if (!nid) return null;
    const node = this.rc.byId.get(Number(nid));
    if (!node) return null;
    const removable = [
      Kind.Command,
      Kind.Math,
      Kind.Environment,
    ].includes(node.kind);
    return removable ? element : null;
  }

  deleteAtom(element, domElement) {
    const nid = Number(domElement.dataset.nid);
    const node = this.rc.byId.get(nid);
    if (!node) return;
    this.splice([{ start: node.start, end: node.end, text: '' }], { caret: node.start });
  }

  _onKeyDown(event) {
    const { key, ctrlKey, metaKey, shiftKey, altKey } = event;
    const mod = ctrlKey || metaKey;

    if (key === 'Enter') {
      if (shiftKey && !mod) return; // soft break: let the browser insert it
      event.preventDefault();
      const selection = globalThis.getSelection?.();
      const inTable = selection && this._inTable(selection.anchorNode);
      if (inTable && !shiftKey) {
        this.tableNextCell(event);
        return;
      }
      const inList = selection && this._inList(selection.anchorNode);
      if (inList) this.listNewItem();
      else this.splitParagraph();
      return;
    }

    if (key === 'Backspace' && !mod) {
      const selection = globalThis.getSelection?.();
      if (!selection || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!range.collapsed) return;
      if (this._atBlockStart(range)) {
        event.preventDefault();
        this.mergeWithPreviousBlock();
      }
      return;
    }

    if (key === 'Tab') {
      const selection = globalThis.getSelection?.();
      if (!selection || !this._inList(selection.anchorNode)) {
        if (!selection || !this._inTable(selection.anchorNode)) return;
      }
      event.preventDefault();
      if (this._inTable(selection.anchorNode)) {
        this.tableNextCell(event);
        return;
      }
      if (shiftKey) this.listOutdent();
      else this.listIndent();
      return;
    }

    if (mod && !shiftKey && key.toLowerCase() === 'b') {
      event.preventDefault();
      this.toggleInline('textbf');
      return;
    }
    if (mod && !shiftKey && key.toLowerCase() === 'i') {
      event.preventDefault();
      this.toggleInline('emph');
      return;
    }
    if (mod && !shiftKey && key.toLowerCase() === 'u') {
      event.preventDefault();
      this.toggleInline('underline');
      return;
    }
    if (mod && !shiftKey && key === ' ') {
      event.preventDefault();
      this.insertText('~');
      return;
    }
    if (mod && shiftKey && key.toLowerCase() === 'm') {
      event.preventDefault();
      this.exec('math:display');
      return;
    }
    if (mod && shiftKey && key.toLowerCase() === 'e') {
      event.preventDefault();
      this.exec('math:inline');
      return;
    }
    if (mod && shiftKey && key.toLowerCase() === 'k') {
      event.preventDefault();
      this.exec('insert:link');
      return;
    }
    if (mod && shiftKey && key.toLowerCase() === 'c') {
      event.preventDefault();
      this.exec('insert:cite');
      return;
    }
    if (mod && shiftKey && key.toLowerCase() === 'r') {
      event.preventDefault();
      this.exec('insert:ref');
      return;
    }
    if (mod && shiftKey && key.toLowerCase() === 'f') {
      event.preventDefault();
      this.exec('insert:footnote');
      return;
    }
    if (mod && key === '0') {
      event.preventDefault();
      this.exec('format:clear');
      return;
    }
  }

  _atBlockStart(range) {
    const block = blockElementOf(range.startContainer, this.root);
    if (!block) return false;
    const inner = block.querySelector('[data-inner]') || block;
    const position = this._edgePosition(inner, true);
    const probe = document.createRange();
    probe.setStart(position.node, position.offset);
    probe.setEnd(range.startContainer, range.startOffset);
    return probe.toString().length === 0;
  }

  _inList(domNode) {
    let element = domNode.nodeType === Node.ELEMENT_NODE ? domNode : domNode.parentElement;
    while (element && element !== this.root) {
      if (element.classList.contains('atex-li')) return element;
      element = element.parentElement;
    }
    return false;
  }

  _inTable(domNode) {
    let element = domNode.nodeType === Node.ELEMENT_NODE ? domNode : domNode.parentElement;
    while (element && element !== this.root) {
      if (element.classList.contains('atex-td')) return element;
      element = element.parentElement;
    }
    return false;
  }

  _onPaste(event) {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length) {
      event.preventDefault();
      for (const file of files) this._uploadFile(file);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const html = event.clipboardData?.getData('text/html') ?? '';
    event.preventDefault();
    if (html && /<(strong|em|b|i|ul|ol|h[1-6])\b/i.test(html)) {
      const converted = htmlToLatex(html);
      if (converted) {
        this.insertText(converted, { raw: true });
        return;
      }
    }
    this.insertText(text, { raw: false });
  }

  _onDrop(event) {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    const block = blockElementOf(event.target, this.root);
    const info = block ? { start: Number(block.dataset.srcStart), end: Number(block.dataset.srcEnd) } : null;
    for (const file of files) this._uploadFile(file, { at: info ? info.end : null });
  }

  async _uploadFile(file, { at = null, figure = true } = {}) {
    const name = file.name || 'image.png';
    const isImage = /\.(png|jpe?g|gif|svg|webp|bmp|pdf|eps)$/i.test(name);
    const folder = isImage ? 'figures' : 'assets';
    const path = `${folder}/${name}`;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(this.projectId)}/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        body: await file.arrayBuffer(),
      });
      if (!response.ok) throw new Error(await response.text());
      this.callbacks.onFilesChanged?.();
      toast(`Uploaded ${path}`, { kind: 'success' });
      const offset = at !== null ? at : this.selectionRange()?.start ?? this.doc.source.length;
      if (isImage) {
        if (figure) this.insertFigure({ path, at: offset });
        else this.splice([{ start: offset, end: offset, text: `\\includegraphics{${path}}` }], { caret: offset });
      }
    } catch (err) {
      toast(`Upload failed: ${err.message}`, { kind: 'error' });
    }
  }

  /** Insert plain (or raw LaTeX) text at the caret. */
  insertText(text, { raw = false, caret = null } = {}) {
    if (!text) return;
    const selection = this.selectionRange();
    const at = selection ? selection.end : this.doc.source.length;
    const payload = raw ? text : escapeLatexText(text);
    this.splice([{ start: at, end: at, text: payload }], {
      caret: caret === null ? at + payload.length : caret,
      kind: 'typing',
    });
  }

  // -- inline formatting ---------------------------------------------------

  /**
   * Wrap or unwrap the selection in an inline command.
   * Works on the source range, which is exact and needs no AST surgery.
   */
  toggleInline(command, { arg = '' } = {}) {
    const selection = this.selectionRange();
    if (!selection) return;
    if (selection.collapsed) {
      // Nothing selected: create the command and put the caret inside it.
      const open = arg ? `\\${command}{${arg}}{` : `\\${command}{`;
      this.splice([{ start: selection.start, end: selection.end, text: `${open}}` }], {
        caret: selection.start + open.length,
        kind: 'structural',
      });
      return;
    }
    const existing = this._enclosingCommand(selection.start, selection.end, command);
    if (existing) {
      // Unwrap: keep the contents, drop the command.
      const arg = existing.args[existing.args.length - 1];
      const inner = arg ? this.doc.source.slice(arg.start + (arg.lead || '').length + 1, arg.end - 1) : '';
      this.splice([{ start: existing.start, end: existing.end, text: inner }], {
        caret: existing.start + inner.length,
        kind: 'structural',
      });
      return;
    }
    const content = this.doc.source.slice(selection.start, selection.end);
    if (!isWrappable(content)) {
      toast('Select a smaller range to apply formatting', { kind: 'warning' });
      return;
    }
    const open = arg ? `\\${command}{${arg}}{` : `\\${command}{`;
    this.splice([{ start: selection.start, end: selection.end, text: `${open}${content}}` }], {
      caret: selection.start + open.length + content.length + 1,
      kind: 'structural',
    });
  }

  _enclosingCommand(start, end, command) {
    let found = null;
    ast.walkAllOf(this.doc.root.children, (node) => {
      if (found || node.kind !== Kind.Command || node.name !== command) return;
      if (node.start <= start && node.end >= end) {
        if (!found || node.end - node.start < found.end - found.start) found = node;
      }
    });
    return found;
  }

  /** Remove inline formatting from the selection. */
  clearFormatting() {
    const selection = this.selectionRange();
    if (!selection || selection.collapsed) return;
    const wrappers = [];
    ast.walkAllOf(this.doc.root.children, (node) => {
      if (node.kind !== Kind.Command) return;
      if (!['textbf', 'textit', 'emph', 'underline', 'texttt', 'textsc', 'sout', 'textsuperscript', 'textsubscript', 'textsl', 'textmd', 'textrm', 'textsf'].includes(node.name)) return;
      if (node.start >= selection.start && node.end <= selection.end) wrappers.push(node);
    });
    if (!wrappers.length) return;
    const edits = [];
    for (const node of wrappers) {
      const arg = node.args[node.args.length - 1];
      if (!arg) continue;
      const inner = this.doc.source.slice(arg.start + (arg.lead || '').length + 1, arg.end - 1);
      edits.push({ start: node.start, end: node.end, text: inner });
    }
    this.splice(edits, { caret: selection.start, kind: 'structural' });
  }

  // -- paragraphs ----------------------------------------------------------

  /** Split the paragraph at the caret, or start a new one at the end. */
  splitParagraph() {
    const selection = this.selectionRange();
    if (!selection) return;
    const at = selection.start;
    const source = this.doc.source;
    const insideMathOrVar = this.doc.envAt(at);
    if (insideMathOrVar && /^(tabular|figure|table|verbatim|tikzpicture)/.test(insideMathOrVar.name)) {
      toast('Cannot split a paragraph here — use the source view for this block', { kind: 'warning' });
      return;
    }
    // Before splitting, make sure we do not land inside a command's braces.
    const safe = this._safeSplitOffset(at);
    const before = source.slice(0, safe);
    const needsLead = !/\n[ \t\r]*\n$/.test(before) && before.length > 0;
    const after = source.slice(safe);
    const needsTrail = !/^[ \t\r]*\n/.test(after) && after.length > 0;
    const inserted = `${needsLead ? '\n\n' : '\n'}\n${needsTrail ? '' : ''}`;
    // Insert a paragraph break, then leave the caret after it.
    const editText = needsLead ? '\n\n' : '\n\n';
    this.splice([{ start: safe, end: safe, text: editText }], {
      caret: safe + editText.length,
      kind: 'structural',
    });
    void inserted;
    void needsTrail;
  }

  /** Avoid inserting a paragraph break inside braces or a control sequence. */
  _safeSplitOffset(offset) {
    const source = this.doc.source;
    let depth = 0;
    for (let i = 0; i < offset; i++) {
      const c = source[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return offset;
    // Inside braces: move to just after the enclosing group instead.
    let level = depth;
    for (let i = offset; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') level++;
      else if (c === '}') {
        level--;
        if (level === 0) return i + 1;
      }
    }
    return offset;
  }

  /** Join this paragraph with the previous one. */
  mergeWithPreviousBlock() {
    const selection = this.selectionRange();
    if (!selection) return;
    const source = this.doc.source;
    const at = selection.start;
    const before = source.slice(0, at);
    // Remove the whitespace that separates this block from the previous one.
    const match = /(\s*\n\s*\n\s*)$/.exec(before);
    const block = this.blockInfo(this._currentBlockElement());
    if (block && block.start !== null) {
      const gapStart = this._gapStartBefore(at);
      if (gapStart !== null) {
        const removed = at - gapStart;
        this.splice([{ start: gapStart, end: at, text: '' }], {
          caret: Math.max(0, at - removed),
          kind: 'structural',
        });
        return;
      }
    }
    if (match) {
      const start = at - match[0].length;
      this.splice([{ start, end: at, text: ' ' }], { caret: start, kind: 'structural' });
      return;
    }
    // Nothing to merge (start of the document).
    toast('Already at the beginning of the document', { kind: 'info', timeout: 1600 });
  }

  _gapStartBefore(offset) {
    const source = this.doc.source;
    let i = offset;
    while (i > 0 && /\s/.test(source[i - 1])) i--;
    return i < offset ? i : null;
  }

  _currentBlockElement() {
    const selection = globalThis.getSelection?.();
    if (!selection || !selection.rangeCount) return null;
    return blockElementOf(selection.getRangeAt(0).startContainer, this.root);
  }

  // -- headings ------------------------------------------------------------

  setHeadingLevel(level, { wholeBlock = false } = {}) {
    const block = this.blockInfo(this._currentBlockElement());
    if (!block || block.start === null) {
      if (level > 0) this.insertSection(level);
      return;
    }
    const command = level === 0 ? null : levelName(level);
    if (level === 0) {
      // Convert a heading back into a paragraph.
      const node = this._headingNodeAt(block.start);
      if (!node) return;
      const arg = node.args[node.args.length - 1];
      const title = arg ? this.doc.source.slice(arg.start + (arg.lead || '').length + 1, arg.end - 1) : '';
      const trailing = /^\s*\n/.test(this.doc.source.slice(node.end)) ? '' : '\n';
      this.splice([{ start: node.start, end: node.end, text: `${title}${trailing}` }], {
        caret: node.start,
        kind: 'structural',
      });
      return;
    }
    const node = this._headingNodeAt(block.start);
    if (node) {
      const start = node.start;
      const rest = this.doc.source.slice(start).replace(/^\\[a-zA-Z]+\*?/, '');
      this.splice([{ start, end: start + (this.doc.source.slice(start).length - rest.length), text: `\\${command}` }], {
        caret: start + command.length + 1,
        kind: 'structural',
      });
      return;
    }
    // Turn the current block into a heading.
    const element = this._currentBlockElement();
    const text = element ? (element.querySelector('[data-inner]') || element).textContent.trim() : '';
    this.splice([{ start: block.start, end: block.end, text: `\\${command}{${text}}\n\n` }], {
      caret: block.start + command.length + 2,
      kind: 'structural',
    });
    void wholeBlock;
  }

  _headingNodeAt(offset) {
    let found = null;
    ast.walkAllOf(this.doc.root.children, (node) => {
      if (found) return;
      if (node.kind !== Kind.Command) return;
      if (SECTION_LEVELS[node.name] === undefined) return;
      if (node.start <= offset && node.end >= offset) found = node;
    });
    return found;
  }

  // -- lists ---------------------------------------------------------------

  /** Wrap the current paragraph (or the selected blocks) in a list. */
  wrapInList(type = 'itemize') {
    const block = this.blockInfo(this._currentBlockElement());
    if (!block || block.start === null) return;
    const element = this._currentBlockElement();
    const inList = element && element.closest('.atex-list');
    if (inList) {
      // Already a list: change its type instead.
      const envNode = this._envNodeForElement(inList);
      if (envNode) {
        const current = ['itemize', 'enumerate', 'description'].includes(envNode.name) ? envNode.name : 'itemize';
        const target = ['itemize', 'enumerate', 'description'].includes(type) ? type : 'itemize';
        if (current === target) return;
        const openEnd = envNode.start + `\\begin{${envNode.name}}`.length;
        const closeStart = envNode.end - `\\end{envNode.name}`.length;
        this.splice(
          [
            { start: envNode.start, end: openEnd, text: `\\begin{${target}}` },
            { start: closeStart, end: envNode.end, text: `\\end{${target}}` },
          ],
          { caret: envNode.start, kind: 'structural' }
        );
        return;
      }
    }
    const text = this.doc.source.slice(block.start, block.end).trim();
    const body = text.replace(/^\s+|\s+$/g, '');
    const lines = body.split(/\n\s*\n/).filter((line) => line.trim());
    const items = (lines.length ? lines : [body]).map((line) => `\\item ${line.trim()}`).join('\n');
    this.splice([{ start: block.start, end: block.end, text: `\\begin{${type}}\n${items}\n\\end{${type}}` }], {
      caret: block.start + `\\begin{${type}}\n`.length + 6,
      kind: 'structural',
    });
  }

  _envNodeForElement(element) {
    const nid = element.dataset.nid;
    if (!nid) return null;
    const node = this.rc.byId.get(Number(nid));
    return node && node.kind === Kind.Environment ? node : null;
  }

  /** The `\item` the caret is in, plus its list environment. */
  _currentItem() {
    const selection = globalThis.getSelection?.();
    if (!selection || !selection.rangeCount) return null;
    let element = selection.getRangeAt(0).startContainer;
    element = element.nodeType === Node.ELEMENT_NODE ? element : element.parentElement;
    const li = element ? element.closest('.atex-li') : null;
    if (!li) return null;
    const listEl = li.closest('.atex-list-items');
    const envEl = li.closest('.atex-list');
    const envNode = envEl ? this._envNodeForElement(envEl) : null;
    const itemNode = li.dataset.nid ? this.rc.byId.get(Number(li.dataset.nid)) : null;
    if (!envNode || !itemNode) return null;
    const items = splitListItems(envNode);
    const index = items.items.findIndex((item) => item.node === itemNode);
    return { li, listEl, envEl, envNode, itemNode, index, items: items.items };
  }

  /** Range of source text covered by the item at `index` (excluding its \item). */
  _itemSpan(envNode, index, items) {
    const item = items[index];
    const next = items[index + 1];
    const start = item.node.end;
    let end;
    if (next) end = next.node.start;
    else {
      const closeTag = `\\end{${envNode.name}}`;
      const at = this.doc.source.lastIndexOf(closeTag, envNode.end);
      end = at >= 0 && at >= start ? at : envNode.end;
    }
    return { start, end };
  }

  listNewItem() {
    const current = this._currentItem();
    if (!current) {
      this.splitParagraph();
      return;
    }
    const { envNode, index, items } = current;
    const span = this._itemSpan(envNode, index, items);
    const content = this.doc.source.slice(span.start, span.end);
    const blank = content.trim();
    if (!blank) {
      // Empty item: leave the list.
      this.listOutdent();
      return;
    }
    const selection = this.selectionRange();
    const at = selection ? selection.start : span.end;
    const safe = Math.max(span.start, Math.min(span.end, at));
    this.splice([{ start: safe, end: safe, text: '\n\\item ' }], {
      caret: safe + '\n\\item '.length,
      kind: 'structural',
    });
  }

  listIndent() {
    const current = this._currentItem();
    if (!current || current.index === 0) {
      if (current) toast('The first item cannot be indented', { kind: 'info', timeout: 1600 });
      return;
    }
    const { envNode, index, items } = current;
    const span = this._itemSpan(envNode, index, items);
    const content = this.doc.source.slice(span.start, span.end);
    const inner = dedentBlock(content).trim();
    const itemText = this.doc.source.slice(items[index].node.start, span.end);
    const prevSpan = this._itemSpan(envNode, index - 1, items);
    // Remove the item (from its \item through to the next one) and re-add its
    // content as a nested list at the end of the previous item.
    const nested = `\n  \\begin{${envNode.name}}\n  \\item ${inner}\n  \\end{${envNode.name}}\n`;
    this.splice(
      [
        { start: items[index].node.start, end: span.end, text: '' },
        { start: prevSpan.end, end: prevSpan.end, text: nested },
      ],
      { caret: prevSpan.end + nested.length, kind: 'structural' }
    );
    void itemText;
  }

  listOutdent() {
    const current = this._currentItem();
    if (!current) return;
    const { envNode, index, items, li } = current;
    const parentList = li.parentElement?.closest('.atex-li');
    if (!parentList) {
      // Already top level: converting to a paragraph is the sensible escape.
      const span = this._itemSpan(envNode, index, items);
      const content = this.doc.source.slice(span.start, span.end).trim();
      this.splice([{ start: items[index].node.start, end: span.end, text: '' }], { caret: items[index].node.start });
      void content;
      return;
    }
    // Move this item out to just after the enclosing list.
    const span = this._itemSpan(envNode, index, items);
    const content = this.doc.source.slice(span.start, span.end).trim();
    const outerEnvEl = li.parentElement.closest('.atex-list');
    const outerEnvNode = outerEnvEl ? this._envNodeForElement(outerEnvEl) : null;
    if (!outerEnvNode) return;
    const closeTag = `\\end{${outerEnvNode.name}}`;
    const after = this.doc.source.indexOf(closeTag, outerEnvNode.start);
    const insertAt = after >= 0 ? after + closeTag.length : outerEnvNode.end;
    this.splice(
      [
        { start: items[index].node.start, end: span.end, text: '' },
        { start: insertAt, end: insertAt, text: `\n\\item ${content}` },
      ],
      { caret: insertAt + 8, kind: 'structural' }
    );
  }

  // -- tables --------------------------------------------------------------

  _inTableOrNull(domNode) {
    const selection = globalThis.getSelection?.();
    const node = domNode || (selection && selection.rangeCount ? selection.getRangeAt(0).startContainer : null);
    if (!node) return null;
    let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const cell = element ? element.closest('.atex-td') : null;
    if (!cell) return null;
    const tableEl = cell.closest('.atex-table-widget');
    const envNode = tableEl ? this._tableGridNode(tableEl) : null;
    if (!envNode) return null;
    return { cell, tableEl, envNode, row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
  }

  /**
   * The environment that actually holds the grid: for a `table` float that is
   * the nested `tabular`, not the float itself.
   */
  _tableGridNode(widget) {
    if (!widget) return null;
    const tabularNid = widget.dataset.tabularNid;
    if (tabularNid) {
      const node = this.rc.byId.get(Number(tabularNid));
      if (node) return node;
    }
    return this._envNodeForElement(widget);
  }

  tableNextCell(event) {
    const info = this._inTableOrNull();
    if (!info) return;
    const cells = Array.from(info.tableEl.querySelectorAll('.atex-td'));
    const currentIndex = cells.indexOf(info.cell);
    const nextIndex = event && event.shiftKey ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0) return;
    if (nextIndex >= cells.length) {
      this.tableAddRow({ after: info.row });
      return;
    }
    const target = cells[nextIndex];
    const inner = target.querySelector('[data-inner]') || target;
    const position = this._edgePosition(inner, true);
    this._placeCaret(position.node, position.offset);
  }

  /** Rebuild a tabular environment's body from a grid of cell source text. */
  _writeTableBody(envNode, grid, { rules = null, spec = null } = {}) {
    const model = readTable(envNode);
    const source = this.doc.source;
    const lines = [];
    const columnCount = grid[0] ? grid[0].length : model.width;
    const specText = spec || readColumnSpec(envNode).raw || 'l'.repeat(columnCount);
    const bodyStart = this._tabularBodyStart(envNode);
    const bodyEnd = this._tabularBodyEnd(envNode);
    for (let r = 0; r < grid.length; r++) {
      const rowRules = rules ? rules[r] : null;
      if (rowRules?.top) lines.push(`\\${rowRules.top}`);
      lines.push(grid[r].map((cell) => ` ${cell.trim()} `).join('&') + ' \\\\');
      if (rowRules?.bottom) lines.push(`\\${rowRules.bottom}`);
    }
    let body = '\n' + lines.join('\n') + '\n';
    // Anything that lived between the rows (whitespace around rules, exotic
    // commands) is re-emitted so rewriting the grid cannot drop it.
    if (model.orphans && model.orphans.length) {
      const extra = model.orphans
        .map((node) => (node.raw || ''))
        .join('')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .trim();
      if (extra) body += `${extra}\n`;
    }
    const edits = [{ start: bodyStart, end: bodyEnd, text: body }];
    const arg = envNode.args.find((a) => !a.optional);
    if (arg && spec && readColumnSpec(envNode).raw !== spec) {
      const inner = `{${spec}}`;
      edits.push({ start: arg.start + (arg.lead || '').length, end: arg.end, text: inner });
    }
    void source;
    this.splice(edits, { caret: null, kind: 'structural' });
  }

  _tabularBodyStart(envNode) {
    // Just after `\begin{tabular}{spec}` and its trailing whitespace.
    let offset = envNode.start;
    const source = this.doc.source;
    const args = envNode.args || [];
    if (args.length) offset = args[args.length - 1].end;
    while (offset < envNode.end && /\s/.test(source[offset])) offset++;
    return offset;
  }

  _tabularBodyEnd(envNode) {
    const source = this.doc.source;
    const closeTag = `\\end{${envNode.endName || envNode.name}}`;
    const at = source.lastIndexOf(closeTag, envNode.end);
    if (at < 0) return envNode.end;
    let end = at;
    while (end > envNode.start && /\s/.test(source[end - 1])) end--;
    return end;
  }

  tableGrid(envNode) {
    const model = readTable(envNode);
    const source = this.doc.source;
    return model.rows.map((row) => row.cells.map((cell) => source.slice(cell.nodes[0]?.start ?? 0, cell.nodes[cell.nodes.length - 1]?.end ?? 0)));
  }

  tableAddRow({ after = null } = {}) {
    const info = this._inTableOrNull();
    if (!info) return;
    const grid = this.tableGrid(info.envNode);
    const at = after === null ? grid.length - 1 : after;
    const columns = grid[0] ? grid[0].length : 1;
    grid.splice(at + 1, 0, new Array(columns).fill(''));
    this._writeTableBody(info.envNode, grid);
  }

  tableAddColumn({ after = null } = {}) {
    const info = this._inTableOrNull();
    if (!info) return;
    const grid = this.tableGrid(info.envNode);
    const at = after === null ? (grid[0] ? grid[0].length - 1 : 0) : after;
    for (const row of grid) row.splice(at + 1, 0, '');
    const spec = readColumnSpec(info.envNode).spec.slice();
    spec.splice(at + 1, 0, 'l');
    this._writeTableBody(info.envNode, grid, { spec: spec.join('') });
  }

  tableDeleteRow() {
    const info = this._inTableOrNull();
    if (!info) return;
    const grid = this.tableGrid(info.envNode);
    if (grid.length <= 1) {
      toast('A table needs at least one row', { kind: 'warning' });
      return;
    }
    grid.splice(info.row, 1);
    this._writeTableBody(info.envNode, grid);
  }

  tableDeleteColumn() {
    const info = this._inTableOrNull();
    if (!info) return;
    const grid = this.tableGrid(info.envNode);
    if ((grid[0] || []).length <= 1) {
      toast('A table needs at least one column', { kind: 'warning' });
      return;
    }
    for (const row of grid) row.splice(info.col, 1);
    const spec = readColumnSpec(info.envNode).spec.slice();
    spec.splice(info.col, 1);
    this._writeTableBody(info.envNode, grid, { spec: spec.join('') });
  }

  tableSetAlignment(letter) {
    const info = this._inTableOrNull();
    if (!info) return;
    const spec = readColumnSpec(info.envNode).spec.slice();
    spec[info.col] = letter;
    const grid = this.tableGrid(info.envNode);
    this._writeTableBody(info.envNode, grid, { spec: spec.join('') });
  }

  tableToggleRule(position) {
    const info = this._inTableOrNull();
    if (!info) return;
    const model = readTable(info.envNode);
    const grid = this.tableGrid(info.envNode);
    const rules = model.rows.map((row) => ({
      top: row.topRule ? row.topRule.name : null,
      bottom: row.bottomRule ? row.bottomRule.name : null,
    }));
    const row = info.row;
    if (position === 'top') {
      rules[row].top = rules[row].top ? null : 'midrule';
    } else {
      rules[row].bottom = rules[row].bottom ? null : 'midrule';
    }
    this._writeTableBody(info.envNode, grid, { rules });
  }

  tableSetPreamble(spec) {
    const info = this._inTableOrNull();
    if (!info) return;
    const grid = this.tableGrid(info.envNode);
    this._writeTableBody(info.envNode, grid, { spec });
  }

  // -- insertions ----------------------------------------------------------

  insertBlockSource(text, { caretOffset = null } = {}) {
    const selection = this.selectionRange();
    let at = selection ? selection.end : this.doc.source.length;
    const block = selection ? this.blockInfo(this._currentBlockElement()) : null;
    if (block && block.end !== null && selection && selection.collapsed) at = block.end;
    const source = this.doc.source;
    let prefix = '';
    let suffix = '';
    if (at > 0 && !/\n[ \t\r]*\n[ \t\r]*$/.test(source.slice(Math.max(0, at - 40), at))) prefix = at > 0 ? '\n\n' : '';
    if (!/^[ \t\r]*\n[ \t\r]*\n/.test(source.slice(at, at + 40)) && at < source.length) suffix = '\n\n';
    const payload = `${prefix}${text}${suffix}`;
    const caret = at + prefix.length + (caretOffset === null ? text.length : caretOffset);
    this.splice([{ start: at, end: at, text: payload }], { caret, kind: 'structural' });
    return caret;
  }

  insertLinkedImageInText({ at }) {
    // Used when a file is uploaded from the top bar: add a figure, or an
    // inline image when the project has a figure environment already around it.
    this.insertFigure({ path: at });
  }

  async insertFigure({ path = null, at = null } = {}) {
    if (!path) {
      const chosen = await this._pickImage();
      if (!chosen) return;
      path = chosen;
    }
    const text = [
      '\\begin{figure}[htbp]',
      '  \\centering',
      `  \\includegraphics[width=0.8\\textwidth]{${path}}`,
      '  \\caption{Caption}',
      `  \\label{fig:${slug(path)}}`,
      '\\end{figure}',
    ].join('\n');
    if (at !== null) {
      const selection = this.selectionRange();
      const target = selection ? selection.end : this.doc.source.length;
      this.splice([{ start: target, end: target, text: `\n\n${text}\n` }], { caret: target + 2, kind: 'structural' });
      this._focusAfterInsert(2, target + 2);
      return;
    }
    this.insertBlockSource(text, { caretOffset: text.indexOf('{Caption}') + 1 });
  }

  _focusAfterInsert(kind, caret) {
    void kind;
    this.focusOffset(caret);
  }

  async _pickImage() {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'atex-picker';
      const list = document.createElement('div');
      list.className = 'atex-picker-list';
      wrap.appendChild(list);
      const images = (this.callbacks.getFiles?.() || []).filter((file) => file.image);
      if (!images.length) {
        list.appendChild(emptyNote('No images in this project yet. Drop a file here or upload one.'));
      }
      for (const file of images) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'atex-picker-item';
        item.innerHTML = `<img src="/api/projects/${encodeURIComponent(this.projectId)}/raw?path=${encodeURIComponent(file.path)}" alt=""><span>${file.path}</span>`;
        item.addEventListener('click', () => {
          close();
          resolve(file.path);
        });
        list.appendChild(item);
      }
      const upload = document.createElement('input');
      upload.type = 'file';
      upload.accept = 'image/*,application/pdf';
      upload.className = 'atex-file-input';
      upload.addEventListener('change', async () => {
        const file = upload.files?.[0];
        if (!file) return;
        const path = `figures/${file.name}`;
        await fetch(`/api/projects/${encodeURIComponent(this.projectId)}/upload?path=${encodeURIComponent(path)}`, {
          method: 'POST',
          body: await file.arrayBuffer(),
        });
        this.callbacks.onFilesChanged?.();
        close();
        resolve(path);
      });
      wrap.appendChild(upload);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'atex-btn';
      button.textContent = 'Upload an image…';
      button.addEventListener('click', () => upload.click());
      wrap.appendChild(button);

      let instance = null;
      const close = () => instance && instance.close();
      instance = modal({
        title: 'Choose an image',
        content: wrap,
        actions: [{ label: 'Cancel', onClick: () => { close(); resolve(null); } }],
        wide: true,
        onClose: () => resolve(null),
      });
    });
  }

  insertTable({ rows = 3, cols = 3, spec = null } = {}) {
    const columnSpec = spec || 'l'.repeat(cols);
    const body = [];
    for (let r = 0; r < rows; r++) {
      body.push(new Array(cols).fill('').map((_, c) => (r === 0 ? ` Header ${c + 1} ` : ' ')).join('&') + ' \\\\');
    }
    const text = [
      '\\begin{table}[htbp]',
      '  \\centering',
      '  \\caption{Caption}',
      `  \\label{tab:${'table'}}`,
      `  \\begin{tabular}{${columnSpec}}`,
      '    \\toprule',
      `    ${body[0]}`,
      '    \\midrule',
      ...body.slice(1).map((line) => `    ${line}`),
      '    \\bottomrule',
      '  \\end{tabular}',
      '\\end{table}',
    ].join('\n');
    this.insertBlockSource(text, { caretOffset: 0 });
  }

  insertSection(level) {
    const command = levelName(level);
    this.insertBlockSource(`\\${command}{New ${command}}\n`, {
      caretOffset: command.length + 2,
    });
  }

  insertMath({ display = false, env = null } = {}) {
    const selection = this.selectionRange();
    const selected = selection && !selection.collapsed ? this.doc.source.slice(selection.start, selection.end) : '';
    if (env) {
      const text = `\\begin{${env}}\n${selected || 'x = y'}\n\\end{${env}}`;
      const caret = this.insertBlockSource(text, { caretOffset: text.indexOf(selected || 'x = y') });
      this._openMathEditor({ env, offset: caret });
      return;
    }
    if (display) {
      const text = `\\[\n${selected || 'x = y'}\n\\]`;
      const caret = this.insertBlockSource(text, { caretOffset: 2 });
      this._openMathEditor({ delim: '\\[', offset: caret });
      return;
    }
    const payload = `$${selected}$`;
    this.insertText(payload, { raw: true, caret: selection ? selection.start + 1 : null });
    const offset = selection ? selection.start : this.doc.source.length - 1;
    this._openMathEditor({ delim: '$', offset: offset + 1 });
  }

  insertFootnote() {
    const selection = this.selectionRange();
    const selected = selection && !selection.collapsed ? this.doc.source.slice(selection.start, selection.end) : '';
    const at = selection ? selection.start : this.doc.source.length;
    const text = `\\footnote{${selected}}`;
    this.splice([{ start: at, end: selection ? selection.end : at, text }], {
      caret: at + text.length - 1,
      kind: 'structural',
    });
  }

  insertLabel() {
    const selection = this.selectionRange();
    const at = selection ? selection.start : this.doc.source.length;
    const env = this.doc.envAt(at);
    const prefix = env ? labelPrefixForEnv(env.name) : 'sec';
    promptModal({
      title: 'Insert a label',
      label: 'Label name',
      value: `${prefix}:`,
      placeholder: 'fig:plot',
      confirmLabel: 'Insert',
    }).then((value) => {
      if (value === null || !value.trim()) return;
      const text = `\\label{${value.trim()}}`;
      this.splice([{ start: at, end: at, text }], { caret: at + text.length, kind: 'structural' });
    });
  }

  insertHref() {
    const selection = this.selectionRange();
    const selected = selection && !selection.collapsed ? this.doc.source.slice(selection.start, selection.end) : '';
    const at = selection ? selection.start : this.doc.source.length;
    formModal({
      title: 'Insert a link',
      fields: [
        { name: 'url', label: 'URL', value: 'https://', placeholder: 'https://example.com' },
        { name: 'text', label: 'Link text', value: selected, placeholder: 'Displayed text' },
      ],
      confirmLabel: 'Insert',
    }).then((values) => {
      if (!values || !values.url) return;
      const text = values.text
        ? `\\href{${values.url}}{${values.text}}`
        : `\\url{${values.url}}`;
      this.splice([{ start: at, end: selection ? selection.end : at, text }], {
        caret: at + text.length,
        kind: 'structural',
      });
    });
  }

  insertPageBreak() {
    this.insertBlockSource('\\newpage\n', { caretOffset: 0 });
  }

  insertTableOfContents() {
    this.insertBlockSource('\\tableofcontents\n', { caretOffset: 0 });
  }

  insertRule() {
    this.insertBlockSource('\\hrule\n', { caretOffset: 0 });
  }

  // -- pickers -------------------------------------------------------------

  /** Choose a label to reference. */
  insertRef() {
    const selection = this.selectionRange();
    const at = selection ? selection.start : this.doc.source.length;
    const labels = Array.from(this.doc.labels.values());
    if (!labels.length) {
      toast('No \\label in this document yet', { kind: 'warning' });
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'atex-picker';
    const search = document.createElement('input');
    search.className = 'atex-input atex-picker-search';
    search.placeholder = 'Search labels…';
    wrap.appendChild(search);
    const list = document.createElement('div');
    list.className = 'atex-picker-list';
    wrap.appendChild(list);
    const render = (filter) => {
      list.replaceChildren();
      const needle = filter.toLowerCase();
      const filtered = labels.filter(
        (label) => !needle || label.key.toLowerCase().includes(needle) || (label.caption || '').toLowerCase().includes(needle)
      );
      if (!filtered.length) list.appendChild(emptyNote('No matching labels'));
      for (const label of filtered) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'atex-picker-item';
        item.innerHTML =
          `<span class="atex-picker-kind">${labelKindIcon(label.kind)}</span>` +
          `<span class="atex-picker-main"><strong>${escapeHtml(label.key)}</strong>` +
          `<small>${escapeHtml(label.caption || label.kind)}</small></span>` +
          (this.doc.resolveRef(label.key) ? `<span class="atex-picker-number">${escapeHtml(this.doc.resolveRef(label.key))}</span>` : '');
        item.addEventListener('click', () => {
          close();
          const text = `\\ref{${label.key}}`;
          this.splice([{ start: at, end: at, text }], { caret: at + text.length, kind: 'structural' });
        });
        list.appendChild(item);
      }
    };
    render('');
    search.addEventListener('input', () => render(search.value));
    let instance = null;
    const close = () => instance && instance.close();
    instance = modal({
      title: 'Reference a label',
      content: wrap,
      actions: [{ label: 'Cancel', onClick: () => close() }],
      wide: true,
      onMount: () => setTimeout(() => search.focus(), 40),
    });
  }

  /** Choose a citation from the project's .bib files. */
  insertCite({ command = 'cite' } = {}) {
    const selection = this.selectionRange();
    const at = selection ? selection.start : this.doc.source.length;
    const entries = this.callbacks.getBibEntries?.() || [];
    const wrap = document.createElement('div');
    wrap.className = 'atex-picker';
    const search = document.createElement('input');
    search.className = 'atex-input atex-picker-search';
    search.placeholder = 'Search by author, title or key…';
    wrap.appendChild(search);
    const list = document.createElement('div');
    list.className = 'atex-picker-list';
    wrap.appendChild(list);
    const chosen = new Set();

    const commit = () => {
      const keys = Array.from(chosen);
      if (!keys.length) return;
      const text = `\\${command}{${keys.join(',')}}`;
      close();
      this.splice([{ start: at, end: at, text }], { caret: at + text.length, kind: 'structural' });
    };

    const render = (filter) => {
      list.replaceChildren();
      const needle = filter.toLowerCase().trim();
      const filtered = entries.filter((entry) => {
        if (!needle) return true;
        const haystack = `${entry.key} ${entry.fields.author || ''} ${entry.fields.title || ''} ${entry.fields.year || ''}`.toLowerCase();
        return haystack.includes(needle);
      });
      if (!entries.length) list.appendChild(emptyNote('No .bib file found in this project. Add one to cite.'));
      else if (!filtered.length) list.appendChild(emptyNote('No matching entries'));
      for (const entry of filtered) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `atex-picker-item ${chosen.has(entry.key) ? 'is-chosen' : ''}`.trim();
        item.innerHTML =
          `<span class="atex-picker-kind">${entry.type === 'article' ? icon('file', 13) : icon('book', 13)}</span>` +
          `<span class="atex-picker-main"><strong>${escapeHtml(entry.fields.author || entry.key)}</strong>` +
          `<small>${escapeHtml((entry.fields.title || '').slice(0, 90))}${
            entry.fields.year ? ` · ${escapeHtml(entry.fields.year)}` : ''
          }</small></span>` +
          `<span class="atex-picker-key">${escapeHtml(entry.key)}</span>`;
        item.addEventListener('click', () => {
          if (chosen.has(entry.key)) chosen.delete(entry.key);
          else chosen.add(entry.key);
          render(search.value);
        });
        item.addEventListener('dblclick', () => commit());
        list.appendChild(item);
      }
    };
    render('');
    search.addEventListener('input', () => render(search.value));
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && chosen.size) commit();
    });

    const commandRow = document.createElement('div');
    commandRow.className = 'atex-chip-row';
    for (const name of ['cite', 'citep', 'citet', 'parencite', 'textcite']) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `atex-chip ${name === command ? 'is-active' : ''}`.trim();
      chip.textContent = `\\${name}`;
      chip.addEventListener('click', () => {
        command = name;
        for (const other of commandRow.querySelectorAll('.atex-chip')) other.classList.remove('is-active');
        chip.classList.add('is-active');
      });
      commandRow.appendChild(chip);
    }
    wrap.appendChild(commandRow);

    let instance = null;
    const close = () => instance && instance.close();
    instance = modal({
      title: 'Insert a citation',
      content: wrap,
      actions: [
        { label: 'Cancel', onClick: () => close() },
        { label: 'Insert', kind: 'primary', onClick: commit },
      ],
      wide: true,
      onMount: () => setTimeout(() => search.focus(), 40),
    });
  }

  // -- math editor ---------------------------------------------------------

  _openMathEditor({ delim = '$', env = null, offset = null } = {}) {
    const target = offset !== null ? offset : this.selectionRange()?.start ?? 0;
    const node = this._mathNodeAt(target);
    if (!node) return;
    const isEnv = node.kind === Kind.Environment;
    const initial = isEnv ? node.children.map((c) => c.raw || '').join('').trim() : node.value;

    const wrap = document.createElement('div');
    wrap.className = 'atex-math-editor';
    const input = document.createElement('textarea');
    input.className = 'atex-input atex-input-mono atex-math-input';
    input.value = initial;
    input.rows = isEnv || node.mode === 'display' ? 3 : 2;
    input.spellcheck = false;
    wrap.appendChild(input);

    const preview = document.createElement('div');
    preview.className = 'atex-math-preview';
    wrap.appendChild(preview);

    const palette = document.createElement('div');
    palette.className = 'atex-math-palette';
    for (const group of MATH_PALETTE) {
      const row = document.createElement('div');
      row.className = 'atex-math-palette-row';
      const label = document.createElement('span');
      label.className = 'atex-math-palette-label';
      label.textContent = group.group;
      row.appendChild(label);
      const items = document.createElement('div');
      items.className = 'atex-math-palette-items';
      for (const item of group.items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'atex-math-key';
        button.innerHTML = katexPreview(item) || escapeHtml(item);
        button.title = item;
        button.addEventListener('click', () => {
          insertAtCursor(input, item);
          update();
        });
        items.appendChild(button);
      }
      row.appendChild(items);
      palette.appendChild(row);
    }
    wrap.appendChild(palette);

    let texPreviewTimer = null;
    const update = () => {
      renderMathInto(preview, input.value, { display: true, ctx: this.ctx });
      if (this.settings.serverMathPreview && this.projectId) {
        clearTimeout(texPreviewTimer);
        texPreviewTimer = setTimeout(async () => {
          try {
            const response = await fetch('/api/math/svg', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ latex: input.value, display: true, preamble: this.doc.preamble() }),
            });
            const data = await response.json();
            if (data.svg) {
              preview.innerHTML = data.svg;
              const svg = preview.querySelector('svg');
              if (svg) {
                svg.removeAttribute('width');
                svg.removeAttribute('height');
                svg.style.maxWidth = '100%';
                svg.style.height = 'auto';
              }
              preview.classList.add('atex-math-verified');
            }
          } catch {
            /* keep the KaTeX preview */
          }
        }, 420);
      }
    };
    update();
    input.addEventListener('input', update);

    const apply = () => {
      const value = input.value;
      const edits = isEnv
        ? [{ start: this._tabularBodyStart(node), end: this._envBodyEnd(node), text: `\n${value}\n` }]
        : [{ start: node.start, end: node.end, text: `${delim}${value}${closingFor(delim)}` }];
      instance.close();
      this.splice(edits, { caret: node.start, kind: 'structural' });
    };

    let instance = null;
    instance = modal({
      title: isEnv ? `Edit ${`\\begin{${node.name}}`}` : 'Edit math',
      content: wrap,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: () => instance.close() },
        { label: 'Apply', kind: 'primary', onClick: apply },
      ],
      onMount: () => {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 40);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            apply();
          }
        });
      },
    });
  }

  _envBodyEnd(envNode) {
    const source = this.doc.source;
    const closeTag = `\\end{${envNode.endName || envNode.name}}`;
    const at = source.lastIndexOf(closeTag, envNode.end);
    if (at < 0) return envNode.end;
    let end = at;
    while (end > envNode.start && /\s/.test(source[end - 1])) end--;
    return end;
  }

  _mathNodeAt(offset) {
    let found = null;
    let bestSize = Infinity;
    ast.walkAllOf(this.doc.root.children, (node) => {
      if (offset < node.start || offset > node.end) return;
      if (node.kind === Kind.Math || (node.kind === Kind.Environment && /^(equation|align|gather|multline|displaymath|eqnarray|flalign|alignat|split)/.test(node.name))) {
        const size = node.end - node.start;
        if (size < bestSize) {
          bestSize = size;
          found = node;
        }
      }
    });
    return found;
  }

  // -- click behaviour -----------------------------------------------------

  _onClick(event) {
    const action = event.target.closest?.('[data-action]');
    if (action) {
      event.preventDefault();
      this._handleAction(action.dataset.action, action, event);
      return;
    }
    const atom = event.target.closest?.('.atex-atom');
    if (atom && !event.target.closest('.atex-widget-bar')) {
      this._handleAtomClick(atom, event);
    }
  }

  _onDoubleClick(event) {
    const atom = event.target.closest?.('.atex-atom');
    if (!atom) return;
    event.preventDefault();
    this._handleAtomClick(atom, event, { edit: true });
  }

  _handleAction(action, element, event) {
    const widget = element.closest('.atex-widget');
    const envNode = widget ? this._envNodeForElement(widget) : null;
    switch (action) {
      case 'table-add-row':
        this.tableAddRow({ after: Number(this._inTableOrNull()?.row ?? -1) });
        break;
      case 'table-add-col':
        this.tableAddColFromWidget(widget);
        break;
      case 'table-add-row':
        this.tableAddRow({ after: Number(this._inTableOrNull()?.row ?? -1) });
        break;
      case 'table-options':
        this._openTableOptions(widget);
        break;
      case 'table-caption':
        this._openTableCaption(widget);
        break;
      case 'table-source':
        this._showSource(widget);
        break;
      case 'figure-options':
        this._openFigureOptions(widget);
        break;
      case 'figure-source':
        this._showSource(widget);
        break;
      case 'edit-raw-block':
        this._editRawBlock(widget);
        break;
      case 'goto-source':
        if (envNode) this.callbacks.onRevealSource?.(envNode.start);
        break;
      case 'math-edit':
        this._openMathEditor({ offset: Number(widget?.dataset.srcStart || 0) });
        break;
      case 'open-file':
        if (element.dataset.path) this.callbacks.onOpenFile?.(element.dataset.path);
        break;
      default:
        break;
    }
    void event;
  }

  tableAddColFromWidget(widget) {
    const envNode = this._tableGridNode(widget);
    if (!envNode) return;
    const grid = this.tableGrid(envNode);
    for (const row of grid) row.push('');
    const spec = readColumnSpec(envNode).spec.slice();
    spec.push('l');
    this._writeTableBody(envNode, grid, { spec: spec.join('') });
  }

  _showSource(widget) {
    const envNode = widget ? this._envNodeForElement(widget) : null;
    if (!envNode) return;
    // A table float's interesting source is the grid plus the caption. Show the
    // outer environment, which contains both.
    const source = this.doc.source.slice(envNode.start, envNode.end);
    const pre = document.createElement('pre');
    pre.className = 'atex-code-preview';
    pre.textContent = source;
    modal({
      title: 'LaTeX source of this block',
      content: pre,
      wide: true,
      actions: [
        { label: 'Copy', onClick: () => navigator.clipboard?.writeText(source) },
        { label: 'Edit in source view', kind: 'primary', onClick: (panel, close) => { close(); this.callbacks.onRevealSource?.(envNode.start); } },
      ],
    });
  }

  _editRawBlock(widget) {
    const envNode = widget ? this._envNodeForElement(widget) : null;
    if (!envNode) return;
    const body = envNode.children.map((n) => n.raw || '').join('');
    const textarea = document.createElement('textarea');
    textarea.className = 'atex-input atex-input-mono';
    textarea.rows = 14;
    textarea.spellcheck = false;
    textarea.value = body.replace(/^\n/, '').replace(/\s+$/, '');
    modal({
      title: `Edit \\begin{${envNode.name}} content`,
      content: textarea,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: (panel, close) => close() },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: (panel, close) => {
            const start = this._tabularBodyStart(envNode);
            const end = this._envBodyEnd(envNode);
            close();
            this.splice([{ start, end, text: `\n${textarea.value}\n` }], { kind: 'structural' });
          },
        },
      ],
      onMount: () => setTimeout(() => textarea.focus(), 40),
    });
  }

  _openTableOptions(widget) {
    const envNode = this._tableGridNode(widget);
    if (!envNode) return;
    const info = this._inTableOrNull();
    const columnIndex = info ? info.col : 0;
    const wrap = document.createElement('div');
    wrap.className = 'atex-form';
    const spec = readColumnSpec(envNode);
    const alignRow = document.createElement('div');
    alignRow.className = 'atex-chip-row';
    const letters = [
      ['l', 'Left'],
      ['c', 'Centre'],
      ['r', 'Right'],
      ['p{4cm}', 'Fixed width'],
    ];
    for (const [letter, label] of letters) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `atex-chip ${spec.spec[columnIndex] === letter[0] ? 'is-active' : ''}`.trim();
      chip.textContent = label;
      chip.addEventListener('click', () => {
        close();
        this.tableSetAlignment(letter);
      });
      alignRow.appendChild(chip);
    }
    wrap.appendChild(fieldLabel(`Column ${columnIndex + 1} alignment`));
    wrap.appendChild(alignRow);

    const ruleRow = document.createElement('div');
    ruleRow.className = 'atex-chip-row';
    for (const [position, label] of [['top', 'Rule above'], ['bottom', 'Rule below']]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'atex-chip';
      chip.textContent = label;
      chip.addEventListener('click', () => {
        close();
        this.tableToggleRule(position);
      });
      ruleRow.appendChild(chip);
    }
    wrap.appendChild(fieldLabel('Horizontal rules (current row)'));
    wrap.appendChild(ruleRow);

    const specInput = document.createElement('input');
    specInput.className = 'atex-input atex-input-mono';
    specInput.value = spec.raw;
    wrap.appendChild(fieldLabel('Column specification'));
    wrap.appendChild(specInput);

    const sizeRow = document.createElement('div');
    sizeRow.className = 'atex-chip-row';
    const addRow = document.createElement('button');
    addRow.type = 'button';
    addRow.className = 'atex-chip';
    addRow.textContent = '+ Row';
    addRow.addEventListener('click', () => { close(); this.tableAddRow({ after: columnIndex.length ? (info?.row ?? 0) : 0 }); });
    const delRow = document.createElement('button');
    delRow.type = 'button';
    delRow.className = 'atex-chip';
    delRow.textContent = '− Row';
    delRow.addEventListener('click', () => { close(); this.tableDeleteRow(); });
    const addCol = document.createElement('button');
    addCol.type = 'button';
    addCol.className = 'atex-chip';
    addCol.textContent = '+ Column';
    addCol.addEventListener('click', () => { close(); this.tableAddColumn({ after: info?.col ?? 0 }); });
    const delCol = document.createElement('button');
    delCol.type = 'button';
    delCol.className = 'atex-chip';
    delCol.textContent = '− Column';
    delCol.addEventListener('click', () => { close(); this.tableDeleteColumn(); });
    sizeRow.append(addRow, delRow, addCol, delCol);
    wrap.appendChild(fieldLabel('Rows and columns'));
    wrap.appendChild(sizeRow);

    let instance = null;
    const close = () => instance && instance.close();
    instance = modal({
      title: 'Table options',
      content: wrap,
      actions: [
        { label: 'Cancel', onClick: () => close() },
        {
          label: 'Apply specification',
          kind: 'primary',
          onClick: () => {
            const value = specInput.value.trim();
            close();
            if (value) this.tableSetPreamble(value);
          },
        },
      ],
      onMount: () => setTimeout(() => specInput.focus(), 40),
    });
  }

  /** Caption and label of a table float, edited in one small dialog. */
  _openTableCaption(widget) {
    const envNode = widget ? this._envNodeForElement(widget) : null;
    if (!envNode) return;
    const captionNode = findCommandIn(envNode, 'caption');
    const labelNode = findCommandIn(envNode, 'label');
    const captionArg = captionNode ? captionNode.args[captionNode.args.length - 1] : null;
    const wrap = document.createElement('div');
    wrap.className = 'atex-form';
    const captionInput = document.createElement('textarea');
    captionInput.className = 'atex-input';
    captionInput.rows = 2;
    captionInput.value = captionArg ? ast.plainText(captionArg.children) : '';
    wrap.appendChild(fieldLabel('Caption'));
    wrap.appendChild(captionInput);
    const labelInput = document.createElement('input');
    labelInput.className = 'atex-input atex-input-mono';
    labelInput.value = labelNode ? ast.plainText(labelNode.args[0].children) : '';
    wrap.appendChild(fieldLabel('Label'));
    wrap.appendChild(labelInput);

    let instance = null;
    instance = modal({
      title: 'Table caption',
      content: wrap,
      actions: [
        { label: 'Cancel', onClick: () => instance.close() },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: () => {
            const edits = [];
            if (captionArg) {
              edits.push({
                start: captionArg.start + (captionArg.lead || '').length + 1,
                end: captionArg.end - 1,
                text: escapeLatexText(captionInput.value),
              });
            } else {
              edits.push({
                start: envNode.start + 10,
                end: envNode.start + 10,
                text: `\n  \caption{${escapeLatexText(captionInput.value)}}`,
              });
            }
            if (labelNode && labelInput.value.trim()) {
              const arg = labelNode.args[0];
              edits.push({ start: arg.start + (arg.lead || '').length + 1, end: arg.end - 1, text: labelInput.value.trim() });
            } else if (!labelNode && labelInput.value.trim()) {
              const anchor = captionNode || { end: envNode.start + 10 };
              edits.push({
                start: anchor.end,
                end: anchor.end,
                text: `\n  \label{${labelInput.value.trim()}}`,
              });
            }
            instance.close();
            this.splice(edits, { kind: 'structural' });
          },
        },
      ],
      onMount: () => setTimeout(() => captionInput.focus(), 40),
    });
  }

  _openFigureOptions(widget) {
    const envNode = widget ? this._envNodeForElement(widget) : null;
    if (!envNode) return;
    const source = this.doc.source.slice(envNode.start, envNode.end);
    const widthMatch = /width\s*=\s*([\d.]+)\s*\\textwidth/.exec(source);
    const current = widthMatch ? Math.round(parseFloat(widthMatch[1]) * 100) : 100;
    const wrap = document.createElement('div');
    wrap.className = 'atex-form';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '10';
    slider.max = '100';
    slider.value = String(current);
    slider.className = 'atex-range';
    const readout = document.createElement('span');
    readout.className = 'atex-range-value';
    readout.textContent = `${current}%`;
    slider.addEventListener('input', () => {
      readout.textContent = `${slider.value}%`;
    });
    const row = document.createElement('div');
    row.className = 'atex-field-row';
    row.append(slider, readout);
    wrap.appendChild(fieldLabel('Width (fraction of the text width)'));
    wrap.appendChild(row);

    const graphicNode = findCommandIn(envNode, 'includegraphics');
    const pathInput = document.createElement('input');
    pathInput.className = 'atex-input atex-input-mono';
    pathInput.value = graphicNode ? ast.plainText((graphicNode.args.find((a) => !a.optional) || { children: [] }).children).trim() : '';
    wrap.appendChild(fieldLabel('Image file'));
    wrap.appendChild(pathInput);

    const captionInput = document.createElement('textarea');
    captionInput.className = 'atex-input';
    captionInput.rows = 2;
    const captionNode = findCommandIn(envNode, 'caption');
    captionInput.value = captionNode ? ast.plainText(captionNode.args[captionNode.args.length - 1].children) : '';
    wrap.appendChild(fieldLabel('Caption'));
    wrap.appendChild(captionInput);

    const labelNode = findCommandIn(envNode, 'label');
    const labelInput = document.createElement('input');
    labelInput.className = 'atex-input atex-input-mono';
    labelInput.value = labelNode ? ast.plainText(labelNode.args[0].children) : '';
    wrap.appendChild(fieldLabel('Label'));
    wrap.appendChild(labelInput);

    const placementRow = document.createElement('div');
    placementRow.className = 'atex-chip-row';
    let placement = (envNode.args[0] ? ast.plainText(envNode.args[0].children).trim() : '') || 'htbp';
    for (const option of ['htbp', 'h', 't', 'b', 'p', 'H']) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `atex-chip ${option === placement ? 'is-active' : ''}`.trim();
      chip.textContent = option;
      chip.addEventListener('click', () => {
        placement = option;
        for (const other of placementRow.querySelectorAll('.atex-chip')) other.classList.remove('is-active');
        chip.classList.add('is-active');
      });
      placementRow.appendChild(chip);
    }
    wrap.appendChild(fieldLabel('Placement'));
    wrap.appendChild(placementRow);

    let instance = null;
    instance = modal({
      title: 'Figure options',
      content: wrap,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: () => instance.close() },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: () => {
            const edits = [];
            const fraction = (Number(slider.value) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
            if (graphicNode) {
              const opts = graphicNode.args.find((a) => a.optional);
              const newOpts = `[width=${fraction === '1' ? '' : fraction}\\textwidth]`;
              if (opts) edits.push({ start: opts.start, end: opts.end, text: newOpts });
              else {
                const pathArg = graphicNode.args.find((a) => !a.optional);
                if (pathArg) {
                  const insertAt = pathArg.start - (pathArg.lead || '').length;
                  edits.push({ start: insertAt, end: insertAt, text: newOpts });
                }
              }
              const pathArg = graphicNode.args.find((a) => !a.optional);
              if (pathArg && pathInput.value.trim()) {
                edits.push({
                  start: pathArg.start + (pathArg.lead || '').length + 1,
                  end: pathArg.end - 1,
                  text: pathInput.value.trim(),
                });
              }
            }
            if (captionNode) {
              const arg = captionNode.args[captionNode.args.length - 1];
              edits.push({ start: arg.start + (arg.lead || '').length + 1, end: arg.end - 1, text: captionInput.value });
            } else {
              const label = labelNode || graphicNode;
              const insertAt = label ? label.end + 1 : envNode.start + 10;
              edits.push({ start: insertAt, end: insertAt, text: `\n  \\caption{${captionInput.value}}` });
            }
            if (labelNode && labelInput.value.trim()) {
              const arg = labelNode.args[0];
              edits.push({ start: arg.start + (arg.lead || '').length + 1, end: arg.end - 1, text: labelInput.value.trim() });
            }
            if (envNode.args[0]) {
              const arg = envNode.args[0];
              edits.push({ start: arg.start, end: arg.end, text: `[${placement}]` });
            }
            instance.close();
            if (edits.length) this.splice(edits, { kind: 'structural' });
          },
        },
      ],
    });
  }

  _handleAtomClick(atom, event, { edit = false } = {}) {
    const nid = Number(atom.dataset.nid || 0);
    const node = nid ? this.rc.byId.get(nid) : null;
    if (!node) return;
    const isMath = atom.classList.contains('atex-math') || atom.classList.contains('atex-display-math');
    if (isMath) {
      event.preventDefault();
      this._openMathEditor({ offset: node.start });
      return;
    }
    if (atom.classList.contains('atex-cite')) {
      event.preventDefault();
      const key = ast.plainText((node.args[node.args.length - 1] || { children: [] }).children).trim();
      this._openCitationEditor(node, key);
      return;
    }
    if (atom.classList.contains('atex-ref')) {
      event.preventDefault();
      const key = ast.plainText((node.args[node.args.length - 1] || { children: [] }).children).trim();
      const label = this.doc.labels.get(key);
      this._openSmallPopover(atom, `${node.name === 'ref' ? 'Reference' : `\\${node.name}`}`, key, [
        label
          ? {
              label: 'Go to label',
              onClick: () => {
                closePopover();
                this.revealOffset(label.node.start);
                this.callbacks.onRevealSource?.(label.node.start);
              },
            }
          : null,
        {
          label: 'Change label…',
          onClick: async () => {
            closePopover();
            const value = await promptModal({ title: 'Change reference', label: 'Label name', value: key });
            if (value === null) return;
            const arg = node.args[node.args.length - 1];
            this.splice([{ start: arg.start + (arg.lead || '').length + 1, end: arg.end - 1, text: value }], { kind: 'structural' });
          },
        },
        {
          label: 'Remove',
          kind: 'danger',
          onClick: () => {
            closePopover();
            this.splice([{ start: node.start, end: node.end, text: '' }], { caret: node.start, kind: 'structural' });
          },
        },
      ].filter(Boolean));
      return;
    }
    if (atom.classList.contains('atex-label')) {
      event.preventDefault();
      const key = ast.plainText(node.args[0].children).trim();
      const users = [];
      const source = this.doc.source;
      const re = new RegExp(`\\\\[a-z]*ref\\*?\\{${escapeRegExp(key)}\\}`, 'g');
      let match;
      while ((match = re.exec(source))) users.push(match.index);
      this._openSmallPopover(atom, 'Label', key, [
        {
          label: 'Rename…',
          onClick: async () => {
            closePopover();
            const value = await promptModal({ title: 'Rename label', label: 'Label name', value: key });
            if (value === null || !value.trim()) return;
            const edits = [
              { start: node.args[0].start + (node.args[0].lead || '').length + 1, end: node.args[0].end - 1, text: value.trim() },
            ];
            for (const at of users) {
              const slice = source.slice(at, at + 40);
              const argStart = at + slice.indexOf('{') + 1;
              const argEnd = source.indexOf('}', argStart);
              if (argEnd > 0) edits.push({ start: argStart, end: argEnd, text: value.trim() });
            }
            this.splice(edits, { kind: 'structural' });
          },
        },
        {
          label: `${users.length} reference${users.length === 1 ? '' : 's'}`,
          onClick: () => {
            closePopover();
            this.revealOffset(node.start);
          },
        },
        {
          label: 'Remove label',
          kind: 'danger',
          onClick: () => {
            closePopover();
            this.splice([{ start: node.start, end: node.end, text: '' }], { caret: node.start, kind: 'structural' });
          },
        },
      ]);
      return;
    }
    if (atom.classList.contains('atex-footnote')) {
      event.preventDefault();
      this._openFootnoteEditor(node);
      return;
    }
    if (atom.classList.contains('atex-unknown') || atom.classList.contains('atex-atom-cmd') || edit) {
      event.preventDefault();
      this._openRawCommandEditor(node);
      return;
    }
    if (atom.classList.contains('atex-inline-image')) {
      event.preventDefault();
      this.callbacks.onRevealSource?.(node.start);
      return;
    }
  }

  _openSmallPopover(anchor, title, subtitle, actions) {
    const body = document.createElement('div');
    body.className = 'atex-popover-info';
    const strong = document.createElement('div');
    strong.className = 'atex-popover-strong';
    strong.textContent = subtitle;
    body.appendChild(strong);
    popover({ anchor, title, content: body, actions });
  }

  _openCitationEditor(node, key) {
    const entries = this.callbacks.getBibEntries?.() || [];
    const known = entries.filter((entry) => key.split(',').map((k) => k.trim()).includes(entry.key));
    const body = document.createElement('div');
    body.className = 'atex-popover-info';
    for (const entry of known) {
      const block = document.createElement('div');
      block.className = 'atex-bib-entry';
      block.innerHTML = `<strong>${escapeHtml(entry.fields.author || entry.key)}</strong>
        <em>${escapeHtml(entry.fields.title || '')}</em>
        <small>${escapeHtml([entry.fields.journal || entry.fields.booktitle, entry.fields.year, entry.fields.publisher].filter(Boolean).join(' · '))}</small>`;
      body.appendChild(block);
    }
    if (!known.length) {
      const note = document.createElement('p');
      note.className = 'atex-muted';
      note.textContent = `No .bib entry found for “${key}”.`;
      body.appendChild(note);
    }
    const actions = [
      {
        label: 'Change citation…',
        onClick: () => {
          closePopover();
          this.splice([{ start: node.start, end: node.end, text: '' }], { caret: node.start, kind: 'structural' });
          this.insertCite({ command: node.name });
        },
      },
      {
        label: 'Remove',
        kind: 'danger',
        onClick: () => {
          closePopover();
          this.splice([{ start: node.start, end: node.end, text: '' }], { caret: node.start, kind: 'structural' });
        },
      },
    ];
    popover({ anchor: this.rc.elementFor(node) || this.root, title: `\\${node.name}`, content: body, actions });
  }

  _openFootnoteEditor(node) {
    const arg = node.args[node.args.length - 1];
    if (!arg) return;
    const textarea = document.createElement('textarea');
    textarea.className = 'atex-input';
    textarea.rows = 4;
    textarea.value = ast.plainText(arg.children);
    modal({
      title: 'Footnote',
      content: textarea,
      actions: [
        { label: 'Cancel', onClick: (panel, close) => close() },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: (panel, close) => {
            const value = textarea.value;
            close();
            this.splice(
              [{ start: arg.start + (arg.lead || '').length + 1, end: arg.end - 1, text: escapeLatexText(value) }],
              { kind: 'structural' }
            );
          },
        },
      ],
      onMount: () => setTimeout(() => textarea.focus(), 40),
    });
  }

  _openRawCommandEditor(node) {
    const source = this.doc.source.slice(node.start, node.end);
    const textarea = document.createElement('textarea');
    textarea.className = 'atex-input atex-input-mono';
    textarea.rows = 8;
    textarea.spellcheck = false;
    textarea.value = source;
    modal({
      title: `\\${node.name}`,
      content: textarea,
      wide: true,
      actions: [
        { label: 'Cancel', onClick: (panel, close) => close() },
        {
          label: 'Apply',
          kind: 'primary',
          onClick: (panel, close) => {
            const value = textarea.value;
            close();
            this.splice([{ start: node.start, end: node.end, text: value }], { kind: 'structural' });
          },
        },
      ],
      onMount: () => setTimeout(() => textarea.focus(), 40),
    });
  }

  // -- selection reporting -------------------------------------------------

  _reportSelection() {
    const selection = this.selectionRange();
    if (!selection) {
      this.callbacks.onSelectionChange?.(null);
      return;
    }
    const marks = this._activeMarks(selection);
    const block = this.blockInfo(this._currentBlockElement());
    const heading = this._headingNodeAt(selection.start);
    this.selectionState = {
      ...selection,
      marks,
      blockType: block ? block.type : null,
      headingLevel: heading ? SECTION_LEVELS[heading.name] : 0,
      inList: !!this._inList(globalThis.getSelection()?.anchorNode || this.root),
      inTable: !!this._inTableOrNull(),
      listType: this._currentListType(),
      words: selection.collapsed
        ? 0
        : selection.text.split(/\s+/).filter(Boolean).length,
      characters: selection.text.length,
    };
    this.callbacks.onSelectionChange?.(this.selectionState);
  }

  _activeMarks(selection) {
    const marks = new Set();
    if (!selection) return marks;
    const probe = selection.collapsed ? selection.start : selection.start + 1;
    ast.walkAllOf(this.doc.root.children, (node) => {
      if (node.kind !== Kind.Command) return;
      if (node.start > probe || node.end < probe) return;
      marks.add(node.name);
    });
    return marks;
  }

  _currentListType() {
    const current = this._currentItem();
    if (!current) return null;
    return current.envNode.name;
  }

  // -- public helpers ------------------------------------------------------

  /** Focus the editor and place the caret at the end of the document. */
  focusEnd() {
    this.focusOffset(this.doc.source.length, { atEnd: true });
  }

  setEditable(editable) {
    this.editable = editable;
    this.root.setAttribute('contenteditable', editable ? 'true' : 'false');
    this.root.classList.toggle('atex-readonly', !editable);
  }

  /** Search the document text and reveal the first match after the caret. */
  find(query, { from = null } = {}) {
    if (!query) return null;
    const source = this.doc.source;
    const startAt = from === null ? 0 : from;
    let index = source.indexOf(query, startAt);
    if (index < 0) index = source.indexOf(query, 0);
    if (index < 0) return null;
    this.revealOffset(index);
    this.callbacks.onRevealSource?.(index, index + query.length);
    return { start: index, end: index + query.length };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function levelName(level) {
  return ['part', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'][Math.min(level, 5)] || 'section';
}

function labelPrefixForEnv(name) {
  if (/^(figure|wrapfigure|sidewaysfigure)/.test(name)) return 'fig';
  if (/^(table|longtable|tabular)/.test(name)) return 'tab';
  if (/^(equation|align|gather|multline|eqnarray|flalign)/.test(name)) return 'eq';
  if (/^(theorem|lemma|corollary|proposition|definition)/.test(name)) return 'thm';
  if (/^(algorithm|algorithmic)/.test(name)) return 'alg';
  return 'sec';
}

function closingFor(delim) {
  if (delim === '$$') return '$$';
  if (delim === '\\(') return '\\)';
  if (delim === '\\[') return '\\]';
  return '$';
}

function slug(value) {
  return String(value)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || 'figure';
}

function isWrappable(source) {
  if (!source.trim()) return false;
  if (/\\$/.test(source)) return false; // ends inside a control sequence
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function escapeLatexText(value) {
  const map = {
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    $: '\\$',
    '&': '\\&',
    '#': '\\#',
    '%': '\\%',
    _: '\\_',
    '~': '\\textasciitilde{}',
    '^': '\\textasciicircum{}',
  };
  return String(value).replace(/[\\{}$&#%_~^]/g, (c) => map[c]);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dedentBlock(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s{1,2}/, ''))
    .join('\n');
}

function insertAtCursor(textarea, snippet) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const needsBraces = /\{\}$|\\begin/.test(snippet);
  const value = textarea.value;
  textarea.value = value.slice(0, start) + snippet + value.slice(end);
  const caret = start + snippet.length - (needsBraces ? 1 : 0);
  textarea.selectionStart = needsBraces ? caret : start + snippet.length;
  textarea.selectionEnd = textarea.selectionStart;
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

function katexPreview(latex) {
  const katex = globalThis.katex;
  if (!katex) return '';
  try {
    const holder = document.createElement('span');
    katex.render(latex, holder, { throwOnError: true, strict: false });
    return holder.innerHTML;
  } catch {
    return '';
  }
}

function findCommandIn(envNode, name) {
  let found = null;
  const visit = (nodes) => {
    for (const node of nodes) {
      if (found) return;
      if (node.kind === Kind.Command && node.name === name) {
        found = node;
        return;
      }
      const kids = ast.childrenOf(node);
      if (kids && node.kind !== Kind.Command) visit(kids);
    }
  };
  visit(envNode.children);
  return found;
}

function emptyNote(text) {
  const note = document.createElement('p');
  note.className = 'atex-muted atex-picker-empty';
  note.textContent = text;
  return note;
}

function fieldLabel(text) {
  const label = document.createElement('div');
  label.className = 'atex-field-label';
  label.textContent = text;
  return label;
}

function labelKindIcon(kind) {
  switch (kind) {
    case 'figure':
      return icon('image', 13);
    case 'table':
      return icon('table', 13);
    case 'equation':
      return icon('math', 13);
    default:
      return icon('section', 13);
  }
}

/** Convert simple pasted HTML into LaTeX, so pasting from a web page works. */
function htmlToLatex(html) {
  const container = document.createElement('div');
  container.innerHTML = html;
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const inner = Array.from(node.childNodes).map(walk).join('');
    switch (node.tagName) {
      case 'STRONG':
      case 'B':
        return inner.trim() ? `\\textbf{${inner}}` : inner;
      case 'EM':
      case 'I':
        return inner.trim() ? `\\emph{${inner}}` : inner;
      case 'U':
        return inner.trim() ? `\\underline{${inner}}` : inner;
      case 'CODE':
      case 'TT':
        return inner.trim() ? `\\texttt{${inner}}` : inner;
      case 'S':
      case 'DEL':
      case 'STRIKE':
        return inner.trim() ? `\\sout{${inner}}` : inner;
      case 'SUP':
        return inner.trim() ? `\\textsuperscript{${inner}}` : inner;
      case 'SUB':
        return inner.trim() ? `\\textsubscript{${inner}}` : inner;
      case 'BR':
        return '\n';
      case 'P':
      case 'DIV':
        return `\n\n${inner}\n\n`;
      case 'LI':
        return `\\item ${inner}\n`;
      case 'UL':
        return `\n\\begin{itemize}\n${inner}\\end{itemize}\n`;
      case 'OL':
        return `\n\\begin{enumerate}\n${inner}\\end{enumerate}\n`;
      case 'H1':
        return `\n\\section{${inner}}\n`;
      case 'H2':
        return `\n\\subsection{${inner}}\n`;
      case 'H3':
        return `\n\\subsubsection{${inner}}\n`;
      case 'A':
        return `\\href{${node.getAttribute('href') || ''}}{${inner}}`;
      default:
        return inner;
    }
  };
  const latex = Array.from(container.childNodes).map(walk).join('');
  return latex.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

export { escapeLatexText, htmlToLatex, levelName, normalizeText };
