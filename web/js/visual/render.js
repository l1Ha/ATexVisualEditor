/**
 * ATexVisualEditor — CST to DOM.
 *
 * Every element the renderer creates that corresponds to a CST node carries
 * `data-nid="<node id>"`, and every element that contains editable content
 * carries `data-inner` plus a `__atexSlots` property describing the CST list
 * behind it.  That is all the reconciler needs to map a DOM edit back onto the
 * right node, which is what lets untouched LaTeX stay untouched.
 *
 * Anything the editor does not model renders as a read-only *atom* (a chip)
 * rather than being silently dropped: the document is always complete, and the
 * source view is always available for the exotic parts.
 */

import * as ast from '../core/ast.js';
import { Kind } from '../core/ast.js';
import { INLINE_TAGS, INLINE_CLASSES, MATH_ENVS, INVISIBLE_COMMANDS } from '../core/latex-knowledge.js';
import {
  BlockType,
  analyseFigure,
  analyseTableFloat,
  readTable,
  readColumnSpec,
  parseGraphicsOptions,
  splitListItems,
} from './blocks.js';
import { displayText } from './text-util.js';
import { icon } from '../ui/icons.js';

const COLOR_NAMES = {
  red: '#e11d48', blue: '#2563eb', green: '#059669', black: '#111827',
  white: '#ffffff', gray: '#6b7280', grey: '#6b7280', orange: '#ea580c',
  purple: '#7c3aed', teal: '#0d9488', brown: '#92400e', cyan: '#0891b2',
  magenta: '#c026d3', olive: '#65a30d', pink: '#db2777', violet: '#8b5cf6',
  yellow: '#ca8a04', lightgray: '#d1d5db', darkgray: '#374151',
};

function colorValue(name) {
  if (!name) return '';
  const key = String(name).trim();
  if (COLOR_NAMES[key]) return COLOR_NAMES[key];
  if (/^#[0-9a-f]{3,8}$/i.test(key)) return key;
  const rgb = /^rgb\s*\(([^)]+)\)$/i.exec(key);
  if (rgb) return `rgb(${rgb[1]})`;
  const model = /^([a-z]+)!\s*([\d.]+)$/i.exec(key);
  if (model) return COLOR_NAMES[model[1]] || '';
  return '';
}

const el = (tag, className, attrs = {}) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'style') node.setAttribute('style', value);
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, String(value));
  }
  return node;
};

function attachSlots(element, slots, list, container) {
  element.__atexSlots = { slots, list, container };
  element.setAttribute('data-inner', '');
  return element;
}

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

/**
 * Render a list of inline CST nodes into `container`.
 *
 * @param {object[]} nodes
 * @param {Element} container
 * @param {object} ctx render context: {doc, rc, footnoteNumbers, settings, projectId}
 */
export function renderInline(nodes, container, ctx) {
  for (const node of nodes) {
    if (!ast.isNode(node)) continue;
    renderInlineNode(node, container, ctx);
  }
}

function renderInlineNode(node, container, ctx) {
  switch (node.kind) {
    case Kind.Text: {
      const value = displayText(node);
      if (!value) {
        // Whitespace-only text is not shown, but is still registered so an edit
        // nearby rewrites it in place instead of dropping it.
        ctx.rc.registerPiece(node, node.sliceOf || node, Number.isFinite(node.order) ? node.order : 0);
        const span = el('span', 'atex-hidden-ws');
        span.__atexSkip = true;
        container.appendChild(span);
        ctx.rc.register(node, span);
        return;
      }
      const textNode = document.createTextNode(value);
      container.appendChild(textNode);
      ctx.rc.register(node, textNode);
      // The piece holds the *CST* node (not the DOM text node): a paragraph cut
      // into pieces must be rebuilt from all of them, in order, verbatim.
      ctx.rc.registerPiece(node, node.sliceOf || node, Number.isFinite(node.order) ? node.order : 0);
      if (ctx.textMap) ctx.textMap.set(textNode, node);
      return;
    }
    case Kind.Math:
      container.appendChild(renderMathChip(node, ctx));
      return;
    case Kind.Command:
      renderCommand(node, container, ctx);
      return;
    case Kind.Group: {
      // A bare group has no LaTeX meaning of its own; show its content.
      renderInline(node.children, container, ctx);
      return;
    }
    case Kind.Environment: {
      if (node.verbatim) {
        container.appendChild(renderAtom(node, 'code', `\\begin{${node.name}}…`, ctx));
        return;
      }
      renderInline(node.children, container, ctx);
      return;
    }
    case Kind.Comment: {
      const marker = el('span', 'atex-comment-marker', { 'data-nid': node.id, title: node.value });
      marker.__atexSkip = true;
      marker.textContent = '⁒';
      container.appendChild(marker);
      ctx.rc.register(node, marker);
      return;
    }
    case Kind.Raw: {
      const textNode = document.createTextNode(node.value);
      container.appendChild(textNode);
      ctx.rc.register(node, textNode);
      if (ctx.textMap) ctx.textMap.set(textNode, node);
      return;
    }
    default:
      return;
  }
}

/** A read-only chip standing in for something the editor does not model. */
function renderAtom(node, kind, label, ctx, extra = {}) {
  const chip = el('span', `atex-atom atex-atom-${kind}`, {
    'data-nid': node.id,
    contenteditable: 'false',
    title: extra.title || label,
  });
  if (extra.className) chip.className += ` ${extra.className}`;
  if (extra.style) chip.setAttribute('style', extra.style);
  chip.textContent = label;
  ctx.rc.register(node, chip);
  return chip;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function argText(node, index = -1) {
  const args = node.args || [];
  const arg = index < 0 ? args[args.length - 1] : args[index];
  return arg ? ast.plainText(arg.children).trim() : '';
}

function renderCommand(node, container, ctx) {
  const name = node.name;

  // -- references, citations, labels, footnotes: chips ---------------------
  if (name === 'label') {
    const key = argText(node);
    const chip = el('span', 'atex-atom atex-label', {
      'data-nid': node.id,
      contenteditable: 'false',
      title: `Label: ${key}\nDouble-click to edit`,
    });
    chip.innerHTML = `${icon('tag', 11)}<span>${escapeHtml(key)}</span>`;
    ctx.rc.register(node, chip);
    container.appendChild(chip);
    return;
  }

  if (['ref', 'pageref', 'eqref', 'autoref', 'cref', 'Cref', 'vref', 'nameof'].includes(name)) {
    const key = argText(node);
    const resolved = ctx.doc.resolveRef(key);
    const label = resolved === null ? (ctx.settings.showRefKeys ? key : '?') : resolved;
    const chip = el('span', 'atex-atom atex-ref', {
      'data-nid': node.id,
      contenteditable: 'false',
      title: `\\${name}{${key}}`,
    });
    chip.innerHTML = `${icon('link', 11)}<span>${escapeHtml(String(label))}</span>`;
    if (resolved === null) chip.classList.add('atex-ref-unresolved');
    ctx.rc.register(node, chip);
    container.appendChild(chip);
    return;
  }

  if (name.startsWith('cite') || name === 'Cite' || name === 'nocite' || /^[A-Z]?[A-Za-z]*cite$/.test(name)) {
    const key = argText(node);
    if (key) {
      const resolved = ctx.doc.resolveCite(key);
      const chip = el('span', 'atex-atom atex-cite', {
        'data-nid': node.id,
        contenteditable: 'false',
        title: `\\${name}{${key}}`,
      });
      chip.innerHTML = `${icon('quote', 11)}<span>${escapeHtml(resolved ? `${resolved}` : key)}</span>`;
      if (!resolved) chip.classList.add('atex-cite-unresolved');
      ctx.rc.register(node, chip);
      container.appendChild(chip);
      return;
    }
  }

  if (name === 'footnote' || name === 'thanks') {
    const number = ctx.footnoteNumbers.get(node.id);
    const chip = el('sup', 'atex-atom atex-footnote', {
      'data-nid': node.id,
      contenteditable: 'false',
      title: 'Footnote — click to edit',
    });
    chip.textContent = number ? String(number) : '*';
    ctx.rc.register(node, chip);
    container.appendChild(chip);
    return;
  }

  if (name === 'url' || name === 'nolinkurl') {
    const target = argText(node);
    const chip = el('a', 'atex-atom atex-link', {
      'data-nid': node.id,
      contenteditable: 'false',
      href: name === 'url' ? safeUrl(target) : undefined,
      target: '_blank',
      rel: 'noreferrer noopener',
      title: target,
    });
    chip.textContent = target;
    ctx.rc.register(node, chip);
    container.appendChild(chip);
    return;
  }

  if (name === 'href') {
    const target = argText(node, 0);
    const link = el('a', 'atex-inline atex-href', {
      'data-nid': node.id,
      href: safeUrl(target),
      target: '_blank',
      rel: 'noreferrer noopener',
      title: target,
    });
    const inner = el('span', '');
    attachSlots(inner, node.args[1] ? node.args[1].children.map((n) => ({ node: n, visible: true })) : [], node.args[1]?.children || [], node.args[1]?.children || []);
    link.appendChild(inner);
    renderInline(node.args[1] ? node.args[1].children : [], inner, ctx);
    ctx.rc.register(node, link);
    container.appendChild(link);
    return;
  }

  if (name === 'includegraphics') {
    container.appendChild(renderImageChip(node, ctx));
    return;
  }

  if (name === 'verb' || name === 'lstinline') {
    const text = argText(node);
    const chip = renderAtom(node, 'verb', text, ctx, { title: `\\${name}${text}` });
    chip.classList.add('atex-code');
    container.appendChild(chip);
    return;
  }

  // Multi-file projects: \input / \include become clickable file chips.
  if (name === 'input' || name === 'include' || name === 'subfile') {
    const target = argText(node);
    const chip = el('span', 'atex-atom atex-include', {
      'data-nid': node.id,
      'data-action': 'open-file',
      'data-path': target,
      contenteditable: 'false',
      title: `\\${name}{${target}} — click to open this file`,
    });
    chip.innerHTML = `${icon('file', 11)}<span>${escapeHtml(target || '…')}</span>`;
    ctx.rc.register(node, chip);
    container.appendChild(chip);
    return;
  }

  if (name === '\\') {
    const br = el('br', 'atex-linebreak', { 'data-nid': node.id });
    ctx.rc.register(node, br);
    container.appendChild(br);
    return;
  }

  // -- inline formatting: a real element wrapping the argument -------------
  const tag = INLINE_TAGS[name];
  if (tag && hasContentArgument(node)) {
    const arg = contentArgument(node);
    const style = inlineStyle(name, node);
    const element = el(tag === 'a' ? 'span' : tag, 'atex-inline', {
      'data-nid': node.id,
      style: style || undefined,
    });
    if (INLINE_CLASSES[name]) element.classList.add(INLINE_CLASSES[name]);
    if (tag === 'a') element.classList.add('atex-link');
    if (['sup', 'sub'].includes(tag)) element.classList.add('atex-footnote-like');
    const label = el('span', '');
    attachSlots(label, arg.children.map((n) => ({ node: n, visible: true })), arg.children, arg.children);
    element.appendChild(label);
    renderInline(arg.children, label, ctx);
    ctx.rc.register(node, element);
    container.appendChild(element);
    return;
  }

  if (name === 'item') {
    // Should have been consumed by the list renderer; show a marker if not.
    container.appendChild(renderAtom(node, 'cmd', '\\item', ctx));
    return;
  }

  // -- nothing visible: a very quiet marker ---------------------------------
  if (isQuietCommand(name) || INVISIBLE_COMMANDS.has(name)) {
    const marker = el('span', 'atex-quiet-marker', {
      'data-nid': node.id,
      contenteditable: 'false',
      title: `\\${name}`,
    });
    marker.textContent = `\\${name}`;
    ctx.rc.register(node, marker);
    container.appendChild(marker);
    return;
  }

  // -- anything else: a chip, with its arguments visible when they are text --
  const chip = el('span', 'atex-atom atex-unknown', {
    'data-nid': node.id,
    contenteditable: 'false',
    title: `\\${name} — double-click to edit the LaTeX`,
  });
  const nameSpan = el('span', 'atex-unknown-name', { text: `\\${name}${node.star ? '*' : ''}` });
  chip.appendChild(nameSpan);
  const preview = previewOf(node);
  if (preview) chip.appendChild(el('span', 'atex-unknown-args', { text: preview }));
  ctx.rc.register(node, chip);
  container.appendChild(chip);
}

function isQuietCommand(name) {
  return [
    'centering', 'raggedright', 'raggedleft', 'noindent', 'bigskip', 'medskip',
    'smallskip', 'vspace', 'hspace', 'quad', 'qquad', 'hfill', 'vfill',
    'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE',
    'huge', 'Huge', 'bfseries', 'itshape', 'ttfamily', 'rmfamily', 'sffamily',
    'scshape', 'slshape', 'normalfont', 'em', 'nonumber', 'notag', 'displaystyle',
    'protect', 'relax', 'ignorespaces', 'index', 'xspace', 'hline',
  ].includes(name);
}

/** A short, readable preview of a command's arguments for its chip. */
function previewOf(node) {
  if (!node.args || !node.args.length) return '';
  const parts = node.args.slice(-2).map((arg) => {
    const text = ast.plainText(arg.children, { max: 60 }).replace(/\s+/g, ' ').trim();
    return arg.optional ? `[${text}]` : `{${text}}`;
  });
  return parts.join('');
}

function hasContentArgument(node) {
  return contentArgument(node) !== null;
}

function contentArgument(node) {
  const args = node.args || [];
  if (!args.length) return null;
  const last = args[args.length - 1];
  if (last.optional) return null;
  return last;
}

function inlineStyle(name, node) {
  if (name === 'textcolor') {
    const color = colorValue(argText(node, 0));
    return color ? `color:${color}` : '';
  }
  if (name === 'colorbox') {
    const color = colorValue(argText(node, 0));
    return color ? `background:${color};padding:0 .2em;border-radius:3px` : '';
  }
  if (name === 'fcolorbox') {
    const frame = colorValue(argText(node, 0));
    const back = colorValue(argText(node, 1));
    return [
      frame ? `border:1px solid ${frame}` : '',
      back ? `background:${back}` : '',
      'padding:0 .2em;border-radius:3px',
    ]
      .filter(Boolean)
      .join(';');
  }
  if (name === 'underline' || name === 'uline') return 'text-decoration:underline';
  return '';
}

function safeUrl(value) {
  const url = String(value || '').trim();
  if (/^(https?|mailto|ftp):/i.test(url)) return url;
  if (url.startsWith('/') || url.startsWith('#')) return url;
  if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) return `https://${url}`;
  return '';
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

export function renderMathChip(node, ctx) {
  const chip = el('span', 'atex-math atex-atom', {
    'data-nid': node.id,
    contenteditable: 'false',
    title: `$${node.value}$ — double-click to edit`,
  });
  renderMathInto(chip, sanitizeMathForDisplay(node.value), { display: false, ctx });
  ctx.rc.register(node, chip);
  // Remember the source so the popup editor can find it again.
  chip.__atexMathSource = node.value;
  return chip;
}

/**
 * Render LaTeX math into an element.
 * KaTeX gives immediate feedback; display blocks are upgraded to a real TeX
 * rendering (which honours the document's own macros) shortly afterwards.
 */
export function renderMathInto(element, latex, { display = false, ctx = null, onError = null } = {}) {
  const katex = globalThis.katex;
  const macros = ctx ? macrosFromDoc(ctx.doc) : {};
  if (katex) {
    try {
      katex.render(display ? mathDisplayWrap(latex) : latex, element, {
        displayMode: display,
        throwOnError: true,
        errorColor: '#dc2626',
        macros,
        strict: false,
        trust: false,
        // HTML only: the MathML twin is invisible but doubles textContent,
        // which would corrupt offset mapping and word counts.
        output: 'html',
      });
      element.classList.remove('atex-math-error');
      return true;
    } catch (err) {
      element.textContent = latex;
      element.classList.add('atex-math-error');
      element.title = String(err && err.message ? err.message : err);
      if (onError) onError(err);
      return false;
    }
  }
  element.textContent = display ? `\\[${latex}\\]` : `$${latex}$`;
  element.classList.add('atex-math-raw');
  return false;
}

/**
 * Commands that are document-level, not mathematical: KaTeX rejects them, and a
 * preview has nothing to reference.  Only the *display* is sanitised — the CST
 * keeps the original source.
 */
export function sanitizeMathForDisplay(latex) {
  return String(latex)
    .replace(/\\label\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:nonumber|notag)\b/g, '')
    .replace(/\\tag\s*\{[^{}]*\}/g, '')
    .replace(/\\intertext\s*\{[^{}]*\}/g, '')
    .trim();
}

/** The first \\label{...} inside a math fragment, if any. */
export function mathLabelOf(latex) {
  const match = /\\label\s*\{([^{}]*)\}/.exec(String(latex));
  return match ? match[1] : '';
}

/** KaTeX has no `align` environment; `aligned` inside display mode is closest. */
function mathDisplayWrap(latex) {
  const trimmed = String(latex).trim();
  const env = /^\\begin\{([a-zA-Z*]+)\}/.exec(trimmed);
  if (!env) return trimmed;
  const map = {
    align: 'aligned',
    'align*': 'aligned',
    alignat: 'aligned',
    'alignat*': 'aligned',
    flalign: 'aligned',
    'flalign*': 'aligned',
    split: 'aligned',
    gather: 'gathered',
    'gather*': 'gathered',
    multline: 'gathered',
    'multline*': 'gathered',
    equation: 'aligned',
    'equation*': 'aligned',
    subequations: 'aligned',
  };
  const target = map[env[1]];
  if (!target) return trimmed;
  return trimmed.replace(/^\\begin\{[a-zA-Z*]+\}/, `\\begin{${target}}`).replace(/\\end\{[a-zA-Z*]+\}\s*$/, `\\end{${target}}`);
}

/** User \newcommand definitions, converted for KaTeX. */
function macrosFromDoc(doc) {
  const macros = {};
  try {
    for (const [name, info] of doc.userMacros()) {
      if (info.argCount > 0) macros[`\\${name}`] = info.body;
      else macros[`\\${name}`] = info.body;
    }
  } catch {
    /* a broken macro table must never break rendering */
  }
  return macros;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function assetUrl(ctx, path) {
  if (!ctx.projectId) return '';
  const clean = String(path || '').replace(/^\.\//, '');
  return `/api/projects/${encodeURIComponent(ctx.projectId)}/raw?path=${encodeURIComponent(clean)}`;
}

function renderImageChip(node, ctx, { width = null } = {}) {
  const path = argText(node);
  const wrap = el('span', 'atex-atom atex-inline-image', {
    'data-nid': node.id,
    contenteditable: 'false',
    title: path,
  });
  const img = el('img', 'atex-image', {
    src: assetUrl(ctx, path),
    alt: path,
    loading: 'lazy',
    style: width ? `width:${width}` : undefined,
  });
  img.addEventListener('error', () => {
    wrap.classList.add('atex-image-missing');
    wrap.textContent = `⚠ ${path || 'missing image'}`;
  });
  wrap.appendChild(img);
  ctx.rc.register(node, wrap);
  return wrap;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export function renderBlocks(blocks, container, ctx) {
  const outer = ctx.currentList;
  for (const block of blocks) {
    // Every block knows the CST list its nodes live in — arguments, list items
    // and environments each have their own — so the reconciler always writes
    // back into the right one.
    if (block.list) ctx.currentList = block.list;
    const element = renderBlock(block, container, ctx);
    if (element) annotateSourceRange(element, block);
  }
  ctx.currentList = outer;
}

/**
 * Record the source span a block covers, so structural edits can splice the
 * source at exact offsets (and so the source view can be scrolled to match).
 */
export function annotateSourceRange(element, block) {
  const nodes = block.nodes && block.nodes.length ? block.nodes : block.node ? [block.node] : [];
  let start = Infinity;
  let end = -Infinity;
  for (const node of nodes) {
    if (!node || !Number.isFinite(node.start)) continue;
    start = Math.min(start, node.start);
    end = Math.max(end, node.end);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return element;
  element.dataset.srcStart = String(start);
  element.dataset.srcEnd = String(end);
  return element;
}

export function renderBlock(block, container, ctx) {
  switch (block.type) {
    case BlockType.Paragraph:
      return renderParagraph(block, container, ctx);
    case BlockType.Heading:
      return renderHeading(block, container, ctx);
    case BlockType.List:
      return renderList(block, container, ctx);
    case BlockType.Math:
      return renderMathBlock(block, container, ctx);
    case BlockType.Figure:
      return renderFigure(block, container, ctx);
    case BlockType.Table:
      return renderTable(block, container, ctx);
    case BlockType.Quote:
      return renderQuote(block, container, ctx);
    case BlockType.Code:
      return renderCode(block, container, ctx);
    case BlockType.Raw:
      return renderRaw(block, container, ctx);
    case BlockType.Rule:
      return renderRule(block, container, ctx);
    case BlockType.Macro:
      return renderMacro(block, container, ctx);
    case BlockType.Preamble:
      return renderPreamble(block, container, ctx);
    case BlockType.Empty:
      return renderEmpty(block, container, ctx);
    default:
      return null;
  }
}

function blockShell(block, ctx, className, attrs = {}) {
  const element = el('div', `atex-block ${className}`, attrs);
  element.dataset.blockType = block.type;
  ctx.rc.register(block.nodes?.[0] || block.node, null);
  return element;
}

function renderParagraph(block, container, ctx) {
  if (!block.visible.length && !block.plan.length) return null;
  registerHiddenPieces(block, ctx);
  const div = el('div', 'atex-block atex-paragraph');
  div.dataset.blockType = BlockType.Paragraph;
  div.appendChild(el('br', 'atex-paragraph-anchor'));
  const inner = el('p', 'atex-paragraph-content');
  attachSlots(inner, block.plan, ctx.listFor ? ctx.listFor(block) : ctx.currentList, ctx.currentList);
  div.appendChild(inner);
  renderInline(block.visible, inner, ctx);
  if (!block.visible.some((n) => n.kind !== Kind.Text) && !block.visible.map(displayText).join('').trim()) {
    inner.appendChild(el('br', 'atex-empty-anchor'));
  }
  container.appendChild(div);
  return div;
}

function renderHeading(block, container, ctx) {
  const level = Math.min(Math.max(block.level, 1), 6);
  const wrapper = el('section', 'atex-block atex-section');
  wrapper.dataset.blockType = BlockType.Heading;
  wrapper.dataset.level = String(block.level);
  // Explicit: a heading block has no `nodes` list, so the generic range
  // annotation would have to guess.  The caret maths in the editor depend on
  // this being exact.
  if (Number.isFinite(block.node?.start)) {
    wrapper.dataset.srcStart = String(block.node.start);
    wrapper.dataset.srcEnd = String(block.node.end);
  }
  const heading = el(`h${Math.min(level + 1, 6)}`, `atex-heading atex-heading-${block.level}`, {
    'data-nid': block.node.id,
  });
  const title = el('span', 'atex-heading-title');
  const arg = block.arg;
  if (arg) {
    attachSlots(title, arg.children.map((n) => ({ node: n, visible: true })), arg.children, arg.children);
    renderInline(arg.children, title, ctx);
  }
  heading.appendChild(title);
  heading.appendChild(
    el('span', 'atex-heading-tools', {
      'data-atex-tools': block.command,
      contenteditable: 'false',
    })
  );
  wrapper.appendChild(heading);
  ctx.rc.register(block.node, heading);
  wrapper.dataset.srcStart = String(block.node.start);
  wrapper.dataset.srcEnd = String(block.node.end);

  const body = el('div', 'atex-section-body');
  renderBlocks(block.blocks, body, ctx);
  wrapper.appendChild(body);
  container.appendChild(wrapper);
  return wrapper;
}

/**
 * Hidden text (paragraph edges, blank-line separators) is not drawn, but it
 * belongs to a visible text node's original, so it has to be registered as a
 * piece — otherwise editing the paragraph would silently delete it.
 */
function registerHiddenPieces(block, ctx) {
  const plan = block.plan || [];
  for (const entry of plan) {
    if (entry.visible) continue;
    const node = entry.node;
    if (!node || node.kind !== Kind.Text) continue;
    ctx.rc.registerPiece(node, node.sliceOf || node, Number.isFinite(node.order) ? node.order : 0);
  }
}

function renderList(block, container, ctx) {
  const wrapper = el('div', 'atex-block atex-list');
  wrapper.dataset.blockType = BlockType.List;
  wrapper.dataset.env = block.env;
  wrapper.setAttribute('data-nid', String(block.node.id));
  const listEl = el(block.listType === 'enumerate' ? 'ol' : 'ul', `atex-list-items atex-list-${block.listType}`);
  const start = listStart(block.args);
  if (start) listEl.setAttribute('start', String(start));

  block.items.forEach((item, index) => {
    const li = el('li', 'atex-li', { 'data-nid': String(item.node.id), 'data-item-index': String(index) });
    const handle = el('span', 'atex-li-handle', { contenteditable: 'false' });
    handle.innerHTML = icon('grip', 12);
    li.appendChild(handle);
    if (block.listType === 'description' && item.label) {
      li.appendChild(el('span', 'atex-li-label', { 'data-nid': String(item.optionalArg.id), contenteditable: 'false', text: item.label }));
      ctx.rc.register(item.optionalArg, li.querySelector('.atex-li-label'));
    }
    const content = el('div', 'atex-li-content');
    // Everything the item holds (paragraphs and nested lists) goes in one slot
    // list, so the reconciler sees one contiguous CST range.
    const nested = [];
    const plans = [];
    for (const inner of item.blocks) {
      if (inner.type === BlockType.Paragraph) plans.push(...inner.plan);
      else nested.push(inner);
    }
    const list = ctx.currentList;
    attachSlots(content, plans, list, list);
    for (const entry of plans) {
      if (entry.visible) continue;
      const node = entry.node;
      if (node && node.kind === Kind.Text) {
        ctx.rc.registerPiece(node, node.sliceOf || node, Number.isFinite(node.order) ? node.order : 0);
      }
    }
    li.appendChild(content);
    const visible = plans.filter((entry) => entry.visible).map((entry) => entry.node);
    renderInline(visible, content, ctx);
    if (!visible.length) content.appendChild(el('br', 'atex-empty-anchor'));
    ctx.rc.register(item.node, li);

    for (const inner of nested) renderBlock(inner, li, ctx);
    listEl.appendChild(li);
  });

  wrapper.appendChild(listEl);
  // Registering the environment is what lets structural commands find the list
  // behind a given item (indent, outdent, change type).
  ctx.rc.register(block.node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function listStart(args) {
  const opt = (args || []).find((a) => a.optional);
  if (!opt) return null;
  const text = ast.plainText(opt.children);
  const m = /start\s*=\s*(\d+)/.exec(text) || /^\s*(\d+)\s*$/.exec(text);
  return m ? Number(m[1]) : null;
}

function renderMathBlock(block, container, ctx) {
  const wrapper = el('div', 'atex-block atex-display-math', { 'data-nid': String(block.node.id) });
  wrapper.dataset.blockType = BlockType.Math;
  const latex = mathSourceOf(block);
  renderMathInto(wrapper, sanitizeMathForDisplay(latex), { display: true, ctx });
  wrapper.setAttribute('contenteditable', 'false');
  const tools = el('div', 'atex-math-tools', { contenteditable: 'false' });
  const labelKey = mathLabelOf(latex);
  if (labelKey) {
    const chip = el('span', 'atex-atom atex-label', { title: `\\label{${labelKey}}` });
    chip.innerHTML = `${icon('tag', 11)}<span>${escapeHtml(labelKey)}</span>`;
    tools.appendChild(chip);
  }
  tools.appendChild(el('span', 'atex-math-env', { text: mathEnvLabel(block) }));
  wrapper.appendChild(tools);
  ctx.rc.register(block.node, wrapper);
  if (block.node.kind === Kind.Math && block.node.mode === 'display') {
    wrapper.dataset.delim = block.node.delim;
  }
  container.appendChild(wrapper);
  return wrapper;
}

function mathSourceOf(block) {
  if (block.node.kind === Kind.Math) return block.node.value;
  // An environment keeps its `\begin{...}\end{...}` wrapper, because both
  // renderers need the environment name to map `align` -> `aligned`.
  return (block.node.raw || '').trim();
}

function mathEnvLabel(block) {
  if (block.env) return `\\begin{${block.env}}`;
  const delim = block.node.delim || '$';
  return delim === '$$' ? '$$ … $$' : delim === '\\[' ? '\\[ … \\]' : '$ … $';
}

function renderFigure(block, container, ctx) {
  const figure = analyseFigure(block.node);
  const wrapper = el('figure', 'atex-block atex-widget atex-figure', {
    'data-nid': String(block.node.id),
    contenteditable: 'false',
  });
  wrapper.dataset.blockType = BlockType.Figure;

  const bar = el('div', 'atex-widget-bar', { contenteditable: 'false' });
  bar.appendChild(el('span', 'atex-widget-label', { text: `Figure${block.placement ? ` [${block.placement}]` : ''}` }));
  bar.appendChild(widgetButton('align', 'Alignment & size', 'figure-options'));
  bar.appendChild(widgetButton('source', 'Show LaTeX', 'figure-source'));
  wrapper.appendChild(bar);

  const media = el('div', 'atex-figure-media');
  if (figure.graphics) {
    const opts = parseGraphicsOptions(figure.graphics);
    const path = ast.plainText((figure.graphics.args.find((a) => !a.optional) || { children: [] }).children).trim();
    const img = el('img', 'atex-figure-image', {
      src: assetUrl(ctx, path),
      alt: path,
      style: opts.widthFraction ? `width:${Math.round(opts.widthFraction * 100)}%` : 'max-width:100%',
    });
    img.addEventListener('error', () => {
      media.classList.add('atex-image-missing');
      media.innerHTML = '';
      media.appendChild(el('div', 'atex-missing-note', { text: `⚠ Image not found: ${path || '(no path)'}` }));
    });
    media.appendChild(img);
    ctx.rc.register(figure.graphics, img);
  } else {
    media.appendChild(el('div', 'atex-missing-note', { text: 'This figure has no \\includegraphics yet' }));
  }
  wrapper.appendChild(media);

  const caption = el('figcaption', 'atex-figure-caption');
  if (figure.caption) {
    const arg = figure.caption.args[figure.caption.args.length - 1];
    const label = el('span', 'atex-caption-label', { text: `Figure ${ctx.figureNumbers.get(block.node.id) || ''}`.trim() });
    caption.appendChild(label);
    const inner = el('span', 'atex-caption-text', { contenteditable: 'true' });
    if (arg) {
      attachSlots(inner, arg.children.map((n) => ({ node: n, visible: true })), arg.children, arg.children);
      renderInline(arg.children, inner, ctx);
    }
    caption.appendChild(inner);
    ctx.rc.register(figure.caption, caption);
  } else {
    caption.appendChild(el('span', 'atex-caption-placeholder', { text: 'Add a caption…' }));
  }
  wrapper.appendChild(caption);

  if (figure.label) {
    const key = argText(figure.label);
    const chip = el('span', 'atex-atom atex-label atex-figure-label', { 'data-nid': String(figure.label.id), contenteditable: 'false', title: `\\label{${key}}` });
    chip.innerHTML = `${icon('tag', 11)}<span>${escapeHtml(key)}</span>`;
    ctx.rc.register(figure.label, chip);
    caption.appendChild(chip);
  }

  if (figure.rest.length) {
    const extra = el('div', 'atex-widget-extra', { contenteditable: 'false' });
    extra.textContent = figure.rest.map((n) => (n.raw || '').trim()).filter(Boolean).join(' ');
    wrapper.appendChild(extra);
  }

  wrapper.dataset.caption = figure.caption ? 'true' : 'false';
  wrapper.dataset.width = String(parseGraphicsOptions(figure.graphics || { args: [] }).widthFraction ?? '');
  wrapper.dataset.path = figure.graphics ? ast.plainText((figure.graphics.args.find((a) => !a.optional) || { children: [] }).children).trim() : '';
  ctx.rc.register(block.node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function widgetButton(iconName, title, action) {
  const button = el('button', 'atex-widget-btn', { type: 'button', title, 'data-action': action, contenteditable: 'false' });
  button.innerHTML = icon(iconName, 13);
  return button;
}

function renderTable(block, container, ctx) {
  // A `table` float holds a caption, a label and a `tabular` grid; a bare
  // `tabular` is just the grid.  Both render as a real, editable table.
  const floatInfo = block.float ? analyseTableFloat(block.node) : null;
  const gridNode = block.float ? floatInfo.tabular : block.node;
  const wrapper = el('div', 'atex-block atex-widget atex-table-widget', {
    'data-nid': String(block.node.id),
    contenteditable: 'false',
  });
  wrapper.dataset.blockType = BlockType.Table;
  if (gridNode) wrapper.dataset.tabularNid = String(gridNode.id);

  const bar = el('div', 'atex-widget-bar', { contenteditable: 'false' });
  const number = ctx.tableNumbers.get(block.node.id);
  bar.appendChild(
    el('span', 'atex-widget-label', { text: block.float ? `Table ${number || ''}`.trim() : `\\begin{${block.env}}` })
  );
  bar.appendChild(widgetButton('row-plus', 'Add row below', 'table-add-row'));
  bar.appendChild(widgetButton('col-plus', 'Add column', 'table-add-col'));
  bar.appendChild(widgetButton('align', 'Column alignment & rules', 'table-options'));
  if (block.float) bar.appendChild(widgetButton('text', 'Caption & label', 'table-caption'));
  bar.appendChild(widgetButton('source', 'Show LaTeX', 'table-source'));
  wrapper.appendChild(bar);

  if (!gridNode) {
    wrapper.appendChild(el('div', 'atex-missing-note', { text: 'This table float has no tabular grid yet — add one in the source view.' }));
    container.appendChild(wrapper);
    return wrapper;
  }

  const model = readTable(gridNode);
  const { spec } = readColumnSpec(gridNode);
  const table = el('table', 'atex-table');
  const tbody = el('tbody', '');
  const list = gridNode.children;
  const rowsByIndex = model.rows;

  rowsByIndex.forEach((row, rowIndex) => {
    const tr = el('tr', 'atex-tr');
    tr.dataset.row = String(rowIndex);
    if (row.topRule) tr.classList.add(`atex-rule-top-${ruleKind(row.topRule)}`);
    if (row.bottomRule) tr.classList.add(`atex-rule-bottom-${ruleKind(row.bottomRule)}`);
    row.cells.forEach((cell, cellIndex) => {
      const td = el(cellIndex === 0 && isRowLabel(spec, cellIndex) ? 'th' : 'td', 'atex-td');
      td.dataset.row = String(rowIndex);
      td.dataset.col = String(cellIndex);
      const align = columnAlign(spec, cellIndex);
      if (align) td.style.textAlign = align;
      const inner = el('div', 'atex-td-content', { contenteditable: 'true', spellcheck: 'false' });
      attachSlots(inner, cell.nodes.map((n) => ({ node: n, visible: true })), list, list);
      td.appendChild(inner);
      renderInline(cell.nodes, inner, ctx);
      if (!cell.nodes.length) inner.appendChild(el('br', 'atex-empty-anchor'));
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrapper.appendChild(table);

  if (model.preamble.length) {
    const extra = el('div', 'atex-widget-extra', { contenteditable: 'false' });
    extra.textContent = model.preamble.map((n) => (n.raw || '').trim()).filter(Boolean).join(' ');
    wrapper.appendChild(extra);
  }

  wrapper.dataset.width = String(model.width);
  wrapper.dataset.rows = String(model.rows.length);
  wrapper.dataset.cols = String(model.width);
  wrapper.dataset.spec = spec.join('');

  if (block.float) {
    const caption = el('div', 'atex-table-caption atex-figure-caption', { contenteditable: 'false' });
    if (floatInfo.caption) {
      const label = el('span', 'atex-caption-label', { text: `Table ${number || ''}`.trim() });
      caption.appendChild(label);
      const inner = el('span', 'atex-caption-text', { contenteditable: 'true' });
      const arg = floatInfo.caption.args[floatInfo.caption.args.length - 1];
      if (arg) {
        attachSlots(inner, arg.children.map((n) => ({ node: n, visible: true })), arg.children, arg.children);
        renderInline(arg.children, inner, ctx);
      }
      caption.appendChild(inner);
      ctx.rc.register(floatInfo.caption, caption);
    } else {
      caption.appendChild(el('span', 'atex-caption-placeholder', { text: 'Add a caption…' }));
    }
    if (floatInfo.label) {
      const key = ast.plainText(floatInfo.label.args[0].children).trim();
      const chip = el('span', 'atex-atom atex-label', {
        'data-nid': String(floatInfo.label.id),
        contenteditable: 'false',
        title: `\\label{${key}}`,
      });
      chip.innerHTML = `${icon('tag', 11)}<span>${escapeHtml(key)}</span>`;
      ctx.rc.register(floatInfo.label, chip);
      caption.appendChild(chip);
    }
    wrapper.appendChild(caption);
    if (floatInfo.rest.length) {
      const extra = el('div', 'atex-widget-extra', { contenteditable: 'false' });
      extra.textContent = floatInfo.rest.map((n) => (n.raw || '').trim()).filter(Boolean).join(' ');
      wrapper.appendChild(extra);
    }
  }

  ctx.rc.register(block.node, wrapper);
  if (gridNode !== block.node) ctx.rc.register(gridNode, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function ruleKind(rule) {
  switch (rule.name) {
    case 'toprule':
      return 'heavy';
    case 'midrule':
      return 'medium';
    case 'bottomrule':
      return 'heavy';
    case 'hdashline':
      return 'dashed';
    case 'cline':
    case 'cmidrule':
      return 'partial';
    case 'hline':
    default:
      return 'light';
  }
}

function isRowLabel(spec, index) {
  return false;
  void spec;
  void index;
}

function columnAlign(spec, index) {
  const letter = spec[index] || 'l';
  if (letter === 'r') return 'right';
  if (letter === 'c') return 'center';
  return 'left';
}

function renderQuote(block, container, ctx) {
  const wrapper = el('div', `atex-block atex-container atex-env-${cssToken(block.env)}`, {
    'data-nid': String(block.node.id),
  });
  wrapper.dataset.blockType = BlockType.Quote;
  wrapper.dataset.env = block.env;
  if (!block.known) wrapper.classList.add('atex-env-unknown');
  const bar = el('div', 'atex-env-bar', { contenteditable: 'false' });
  bar.appendChild(el('span', 'atex-env-name', { text: `\\begin{${block.env}}` }));
  wrapper.appendChild(bar);
  const body = el('div', 'atex-container-body');
  renderBlocks(block.blocks, body, ctx);
  wrapper.appendChild(body);
  ctx.rc.register(block.node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function renderCode(block, container, ctx) {
  const wrapper = el('div', 'atex-block atex-code-block', {
    'data-nid': String(block.node.id),
    contenteditable: 'false',
  });
  wrapper.dataset.blockType = BlockType.Code;
  const bar = el('div', 'atex-widget-bar', { contenteditable: 'false' });
  bar.appendChild(el('span', 'atex-widget-label', { text: `\\begin{${block.env}}` }));
  bar.appendChild(widgetButton('source', 'Edit verbatim content', 'edit-raw-block'));
  wrapper.appendChild(bar);
  const pre = el('pre', 'atex-code-body');
  pre.textContent = block.node.children.map((n) => n.raw || '').join('').replace(/^\n/, '').replace(/\s+$/, '');
  wrapper.appendChild(pre);
  ctx.rc.register(block.node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function renderRaw(block, container, ctx) {
  const wrapper = el('div', 'atex-block atex-raw-block', {
    'data-nid': String(block.node.id),
    contenteditable: 'false',
  });
  wrapper.dataset.blockType = BlockType.Raw;
  const bar = el('div', 'atex-widget-bar', { contenteditable: 'false' });
  bar.appendChild(el('span', 'atex-widget-label', { text: `\\begin{${block.env}} — not editable here` }));
  bar.appendChild(widgetButton('source', 'Edit in source view', 'goto-source'));
  wrapper.appendChild(bar);
  const body = block.node.children.map((n) => n.raw || '').join('');
  const pre = el('pre', 'atex-raw-body');
  const lines = body.split('\n');
  pre.textContent = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n… ${lines.length - 12} more lines` : '');
  wrapper.appendChild(pre);
  ctx.rc.register(block.node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function renderRule(block, container, ctx) {
  const name = block.node.name;
  const labels = {
    maketitle: 'Title block (\\maketitle)',
    tableofcontents: 'Table of contents',
    listoffigures: 'List of figures',
    listoftables: 'List of tables',
    newpage: 'Page break',
    clearpage: 'Page break (clearpage)',
    cleardoublepage: 'Page break (cleardoublepage)',
    appendix: 'Appendix starts here',
    printbibliography: 'Bibliography',
    bibliography: 'Bibliography',
    printindex: 'Index',
    frontmatter: 'Front matter',
    mainmatter: 'Main matter',
    backmatter: 'Back matter',
  };
  const wrapper = el('div', 'atex-block atex-doc-rule', {
    'data-nid': String(block.node.id),
    contenteditable: 'false',
    title: block.node.raw,
  });
  wrapper.dataset.blockType = BlockType.Rule;
  wrapper.dataset.command = name;
  wrapper.innerHTML = `${icon('rule', 13)}<span>${escapeHtml(labels[name] || `\\${name}`)}</span>`;
  if (name === 'bibliography') {
    const file = ast.plainText(block.node.args[0]?.children || []);
    if (file) wrapper.appendChild(el('span', 'atex-rule-note', { text: `${file}.bib` }));
  }
  ctx.rc.register(block.node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

function renderMacro(block, container, ctx) {
  const node = block.node;
  const name = ast.plainText(node.args[0]?.children || '').trim();
  const wrapper = el('div', 'atex-block atex-macro', {
    'data-nid': String(node.id),
    contenteditable: 'false',
    title: node.raw,
  });
  wrapper.dataset.blockType = BlockType.Macro;
  const body = node.raw.replace(/\s+/g, ' ').trim();
  wrapper.innerHTML = `${icon('macro', 13)}<span class="atex-macro-name">${escapeHtml(name || `\\${node.name}`)}</span><span class="atex-macro-body">${escapeHtml(body.slice(0, 160))}</span>`;
  ctx.rc.register(node, wrapper);
  container.appendChild(wrapper);
  return wrapper;
}

/**
 * The preamble is not part of the document's text, so it collapses into a card.
 * Clicking it opens the source, which is where a preamble is edited — trying to
 * rich-text-edit `\usepackage[...]{...}` would only get in the way.
 */
function renderPreamble(block, container, ctx) {
  const wrapper = el('div', 'atex-block atex-preamble', {
    'data-nid': String(block.nodes[0].id),
    contenteditable: 'false',
  });
  wrapper.dataset.blockType = BlockType.Preamble;
  const source = block.nodes.map((n) => n.raw || '').join('');
  const lines = source.split('\n').length;
  const documentClass = /\documentclass(\[[^\]]*\])?\{([^}]*)\}/.exec(source);
  const packages = Array.from(source.matchAll(/\usepackage(?:\[[^\]]*\])?\{([^}]*)\}/g)).map((m) => m[1]);
  const header = el('div', 'atex-preamble-head');
  header.innerHTML = `${icon('settings', 14)}<strong>Preamble</strong>`;
  header.appendChild(
    el('span', 'atex-preamble-meta', {
      text: [
        documentClass ? documentClass[2] : '',
        packages.length ? `${packages.length} package${packages.length === 1 ? '' : 's'}` : '',
        `${lines} lines`,
      ]
        .filter(Boolean)
        .join(' · '),
    })
  );
  header.appendChild(el('span', 'atex-preamble-hint', { text: 'edit in the source view' }));
  wrapper.appendChild(header);
  wrapper.title = source.slice(0, 1200);
  wrapper.addEventListener('dblclick', () => ctx.onGotoSource?.(block.nodes[0].start));
  ctx.rc.register(block.nodes[0], wrapper);
  container.appendChild(wrapper);
  for (const macro of block.macros || []) renderMacro(macro, container, ctx);
  return wrapper;
}

function renderEmpty(block, container, ctx) {
  if (!block.nodes.length) return null;
  const wrapper = el('div', 'atex-block atex-empty', { contenteditable: 'false' });
  wrapper.dataset.blockType = BlockType.Empty;
  const text = block.nodes.map((n) => n.raw || '').join('').replace(/\s+/g, ' ');
  if (text.trim()) wrapper.textContent = text.trim().slice(0, 80);
  else wrapper.classList.add('atex-empty-blank');
  wrapper.__atexSkip = true;
  container.appendChild(wrapper);
  return wrapper;
}

function cssToken(name) {
  return String(name).replace(/[^a-zA-Z0-9-]/g, '-');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Whole document
// ---------------------------------------------------------------------------

/**
 * Render a document into `target`.
 * @returns {{blocks: object[]}}
 */
export function renderDocument(target, doc, ctx) {
  const fragment = document.createDocumentFragment();
  const blocks = ctx.blocks;
  ctx.currentList = doc.root.children;
  doc.root.children.__parent = doc.root;
  renderBlocks(blocks, fragment, ctx);
  target.replaceChildren(fragment);
  return { blocks };
}

/** Number footnotes, figures and tables in document order. */
export function computeNumbering(doc) {
  const footnoteNumbers = new Map();
  const figureNumbers = new Map();
  const tableNumbers = new Map();
  let footnotes = 0;
  let figures = 0;
  let tables = 0;
  ast.walkAllOf(doc.root.children, (node) => {
    if (node.kind === Kind.Command && (node.name === 'footnote' || node.name === 'thanks')) {
      footnotes += 1;
      footnoteNumbers.set(node.id, footnotes);
    }
    if (node.kind === Kind.Environment && (node.name === 'figure' || node.name === 'figure*')) {
      figures += 1;
      figureNumbers.set(node.id, figures);
    }
    if (node.kind === Kind.Environment && (node.name === 'table' || node.name === 'table*')) {
      tables += 1;
      tableNumbers.set(node.id, tables);
    }
  });
  return { footnoteNumbers, figureNumbers, tableNumbers };
}

// ---------------------------------------------------------------------------
// Caret capture / restore
// ---------------------------------------------------------------------------

/** Text offset within an element's rendered text. */
function textOffsetOf(root, node, offset) {
  let total = 0;
  const walk = (current) => {
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) return total + offset;
      return total;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      total += current.data.length;
      return -1;
    }
    if (current.nodeType === Node.ELEMENT_NODE) {
      if (current.tagName === 'BR') total += 1;
      for (const child of current.childNodes) {
        const found = walk(child);
        if (found >= 0) return found;
      }
    }
    return -1;
  };
  return walk(root);
}

/** Snapshot the caret as (block index, character offset). */
export function captureCaret(root) {
  const selection = globalThis.getSelection?.();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const blockEl = blockElementOf(range.startContainer, root);
  const blocks = Array.from(root.querySelectorAll('[data-block-type]'));
  const index = blockEl ? blocks.indexOf(blockEl) : -1;
  let offset = -1;
  if (blockEl) offset = textOffsetOf(blockEl, range.startContainer, range.startOffset);
  return {
    index,
    offset,
    endIndex: index,
    endOffset: offset,
    collapsed: range.collapsed,
    text: blockEl ? blockEl.textContent : '',
  };
}

function blockElementOf(node, root) {
  let current = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (current && current !== root) {
    if (current.dataset && current.dataset.blockType) return current;
    current = current.parentElement;
  }
  return null;
}

/** Position the caret at (element, character offset). */
function locateOffset(root, offset) {
  let remaining = offset;
  let lastText = null;
  let lastEnd = 0;
  const walk = (current) => {
    if (current.nodeType === Node.TEXT_NODE) {
      if (remaining <= current.data.length) return { node: current, offset: remaining };
      remaining -= current.data.length;
      lastText = current;
      lastEnd = current.data.length;
      return null;
    }
    if (current.nodeType === Node.ELEMENT_NODE) {
      if (current.tagName === 'BR') {
        if (remaining <= 0) return { node: current.parentNode, offset: indexOf(current) };
        remaining -= 1;
      }
      for (const child of current.childNodes) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };
  const found = walk(root);
  if (found) return found;
  if (lastText) return { node: lastText, offset: lastEnd };
  return { node: root, offset: 0 };
}

function indexOf(node) {
  return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
}

/** Restore a caret snapshot. */
export function restoreCaret(root, caret) {
  if (!caret) return false;
  const blocks = Array.from(root.querySelectorAll('[data-block-type]'));
  if (!blocks.length) return false;
  const index = Math.max(0, Math.min(blocks.length - 1, caret.index < 0 ? blocks.length - 1 : caret.index));
  const blockEl = blocks[index];
  const target = blockEl.querySelector('[data-inner]') || blockEl;
  const offset = caret.offset < 0 ? target.textContent.length : Math.min(caret.offset, target.textContent.length);
  const position = locateOffset(target, offset);
  try {
    const range = document.createRange();
    range.setStart(position.node, Math.min(position.offset, position.node.length ?? 0));
    range.collapse(true);
    const selection = globalThis.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}
