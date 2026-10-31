/**
 * ATexVisualEditor — LaTeX source editor.
 *
 * A `textarea` for input plus a highlighted `<pre>` underneath it, kept in
 * lockstep.  Using a real textarea (rather than a contenteditable pretender)
 * means native undo, IME, spellcheck, find-in-page and platform text navigation
 * all behave exactly as users expect — the only thing layered on top is colour.
 *
 * The highlighter is a small scanner over the LaTeX grammar: control sequences,
 * braces, math, comments, verbatim bodies, citations and references.
 */

import { icon } from '../ui/icons.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeHtml = (value) => String(value).replace(/[&<>]/g, (c) => ESC[c]);

/** Commands worth highlighting differently in the gutter/outline. */
const SECTION_COMMANDS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']);
const REF_COMMANDS = new Set(['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'vref', 'nameof']);
const CITE_COMMANDS = new Set(['cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'parencite', 'textcite', 'footcite', 'nocite']);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'comment', 'Verbatim', 'BVerbatim', 'LVerbatim', 'alltt', 'filecontents', 'filecontents*']);

/**
 * Tokenise LaTeX into `[className, text]` runs.
 * Deliberately independent of the CST parser: highlighting must never fail on
 * half-written source, and it should stay fast on very large files.
 */
export function highlightLatex(source) {
  const out = [];
  let i = 0;
  const n = source.length;
  let plainStart = 0;

  const pushPlain = (end) => {
    if (end > plainStart) out.push(['', source.slice(plainStart, end)]);
  };

  while (i < n) {
    const c = source[i];

    // -- comment ----------------------------------------------------------
    if (c === '%' && (i === 0 || source[i - 1] !== '\\')) {
      pushPlain(i);
      let end = source.indexOf('\n', i);
      if (end < 0) end = n;
      out.push(['tex-comment', source.slice(i, end)]);
      i = end;
      plainStart = end;
      continue;
    }

    // -- control sequence --------------------------------------------------
    if (c === '\\') {
      pushPlain(i);
      let end = i + 1;
      if (end < n && /[a-zA-Z]/.test(source[end])) {
        while (end < n && /[a-zA-Z]/.test(source[end])) end++;
      } else {
        end = Math.min(n, i + 2);
      }
      const name = source.slice(i + 1, end);
      const base = name.replace(/\*$/, '');
      let cls = 'tex-command';
      if (SECTION_COMMANDS.has(base)) cls = 'tex-command tex-command-section';
      else if (REF_COMMANDS.has(base)) cls = 'tex-command tex-command-ref';
      else if (CITE_COMMANDS.has(base)) cls = 'tex-command tex-command-cite';
      else if (base === 'begin' || base === 'end') cls = 'tex-command tex-command-env';
      else if (['textbf', 'textit', 'emph', 'underline', 'texttt', 'textrm', 'textsf', 'textsc'].includes(base)) cls = 'tex-command tex-command-format';
      out.push([cls, source.slice(i, end)]);
      i = end;
      plainStart = end;
      continue;
    }

    // -- verbatim environments --------------------------------------------
    if (c === '{' && source.startsWith('\\begin', Math.max(0, i - 6)) ) {
      // handled below via the environment branch
    }

    // -- environment name --------------------------------------------------
    if (c === '{' ) {
      const before = source.slice(Math.max(0, i - 6), i);
      if (/\\begin$/.test(before) || /\\end$/.test(before)) {
        pushPlain(i);
        const close = source.indexOf('}', i);
        const end = close < 0 ? n : close + 1;
        const name = source.slice(i + 1, end - 1);
        out.push(['tex-envname', source.slice(i, end)]);
        i = end;
        plainStart = end;
        if (VERBATIM_ENVS.has(name) && /\\begin$/.test(before)) {
          const closeTag = `\\end{${name}}`;
          const bodyEnd = source.indexOf(closeTag, i);
          const stop = bodyEnd < 0 ? n : bodyEnd;
          if (stop > i) out.push(['tex-verbatim', source.slice(i, stop)]);
          i = stop;
          plainStart = stop;
        }
        continue;
      }
      pushPlain(i);
      out.push(['tex-brace', '{']);
      i++;
      plainStart = i;
      continue;
    }
    if (c === '}') {
      pushPlain(i);
      out.push(['tex-brace', '}']);
      i++;
      plainStart = i;
      continue;
    }

    // -- math --------------------------------------------------------------
    if (c === '$') {
      const double = source[i + 1] === '$';
      const delim = double ? '$$' : '$';
      const bodyStart = i + delim.length;
      let j = bodyStart;
      let closed = -1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '\n' && !double) {
          let k = j + 1;
          while (k < n && (source[k] === ' ' || source[k] === '\t')) k++;
          if (k < n && source[k] === '\n') break;
        }
        if (double ? source.startsWith('$$', j) : source[j] === '$') {
          closed = j;
          break;
        }
        j++;
      }
      pushPlain(i);
      if (closed < 0) {
        out.push(['tex-math-unclosed', delim]);
        i = bodyStart;
        plainStart = i;
        continue;
      }
      const end = closed + delim.length;
      out.push(['tex-math', source.slice(i, end)]);
      i = end;
      plainStart = end;
      continue;
    }
    if (c === '\\' ) {
      // handled above
    }

    i++;
  }
  pushPlain(n);
  return out;
}

export function highlightToHtml(source) {
  return highlightLatex(source)
    .map(([cls, text]) => (cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text)))
    .join('');
}

export class SourceEditor {
  constructor({ mount, callbacks = {} } = {}) {
    this.mount = mount;
    this.callbacks = callbacks;
    this.value = '';
    this.pendingTimer = null;
    this._build();
  }

  _build() {
    this.mount.replaceChildren();
    this.wrap = document.createElement('div');
    this.wrap.className = 'atex-source-wrap';

    this.gutter = document.createElement('div');
    this.gutter.className = 'atex-gutter';
    this.wrap.appendChild(this.gutter);

    this.scroll = document.createElement('div');
    this.scroll.className = 'atex-source-scroll';
    this.wrap.appendChild(this.scroll);

    this.pre = document.createElement('pre');
    this.pre.className = 'atex-highlight';
    this.pre.setAttribute('aria-hidden', 'true');
    this.scroll.appendChild(this.pre);

    this.code = document.createElement('code');
    this.pre.appendChild(this.code);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'atex-source-input';
    this.textarea.spellcheck = false;
    this.textarea.setAttribute('autocapitalize', 'off');
    this.textarea.setAttribute('autocorrect', 'off');
    this.textarea.setAttribute('wrap', 'off');
    this.scroll.appendChild(this.textarea);

    this.mount.appendChild(this.wrap);

    this.textarea.addEventListener('input', () => this._onInput());
    this.textarea.addEventListener('scroll', () => this._onScroll());
    this.textarea.addEventListener('keydown', (event) => this._onKeyDown(event));
    this.textarea.addEventListener('click', () => this._reportCursor());
    this.textarea.addEventListener('keyup', () => this._reportCursor());
    this.textarea.addEventListener('blur', () => this._flush());
    this.findState = null;
  }

  setValue(source, { preserveCursor = true, silent = false } = {}) {
    if (source === this.value) return;
    const cursor = preserveCursor ? this.cursorOffset() : null;
    const scroll = { top: this.textarea.scrollTop, left: this.textarea.scrollLeft };
    this.value = source;
    this.textarea.value = source;
    this._paint();
    if (cursor !== null) this.setCursorOffset(Math.min(cursor, source.length));
    this.textarea.scrollTop = scroll.top;
    this.textarea.scrollLeft = scroll.left;
    this._onScroll();
    void silent;
  }

  _paint() {
    this.code.innerHTML = highlightToHtml(this.value) + '\n';
    const lines = this.value.split('\n').length;
    this.gutter.textContent = '';
    if (this._lineCount !== lines) {
      this._lineCount = lines;
      const fragment = document.createDocumentFragment();
      for (let i = 1; i <= lines; i++) {
        const div = document.createElement('div');
        div.className = 'atex-gutter-line';
        div.textContent = String(i);
        fragment.appendChild(div);
      }
      this.gutter.appendChild(fragment);
    }
    this._reportCursor();
  }

  _onScroll() {
    const { scrollTop, scrollLeft } = this.textarea;
    this.pre.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    this.gutter.scrollTop = scrollTop;
  }

  _onInput() {
    this.value = this.textarea.value;
    this._paint();
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this._flush(), 220);
  }

  _flush() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.callbacks.onChange?.(this.value);
  }

  _onKeyDown(event) {
    const { key, ctrlKey, metaKey } = event;
    if (key === 'Tab') {
      event.preventDefault();
      this.insertText('  ');
      return;
    }
    if (key === 'Enter' && !event.shiftKey) {
      const offset = this.cursorOffset();
      const lineStart = this.value.lastIndexOf('\n', offset - 1) + 1;
      const line = this.value.slice(lineStart, offset);
      const indent = /^[ \t]*/.exec(line)[0];
      const extra = /[{[]$/.test(line.trim()) ? '  ' : '';
      if (indent || extra) {
        event.preventDefault();
        this.insertText(`\n${indent}${extra}`);
        if (extra) {
          // Place the closing brace on the next line for a block command.
          const at = this.cursorOffset();
          this.textarea.setSelectionRange(at, at);
        }
      }
      return;
    }
    if ((ctrlKey || metaKey) && key === '/') {
      event.preventDefault();
      this.toggleComment();
      return;
    }
    if ((ctrlKey || metaKey) && key.toLowerCase() === 'd') {
      event.preventDefault();
      this.duplicateLine();
      return;
    }
    if ((ctrlKey || metaKey) && key.toLowerCase() === 'f') {
      event.preventDefault();
      this.openFind();
      return;
    }
    if ((ctrlKey || metaKey) && key.toLowerCase() === 'h') {
      event.preventDefault();
      this.openFind({ replace: true });
      return;
    }
    // Keep LaTeX closure comfortable: typing `}` skips it if already there.
    if (key === '}') {
      const offset = this.cursorOffset();
      if (this.value[offset] === '}') {
        event.preventDefault();
        this.textarea.setSelectionRange(offset + 1, offset + 1);
        this._reportCursor();
      }
    }
  }

  insertText(text) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.textarea.value = this.value;
    const caret = start + text.length;
    this.textarea.setSelectionRange(caret, caret);
    this.textarea.focus();
    this._paint();
    this._flush();
  }

  wrapSelection(prefix, suffix = '') {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const selected = this.value.slice(start, end);
    this.value = this.value.slice(0, start) + prefix + selected + suffix + this.value.slice(end);
    this.textarea.value = this.value;
    this.textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    this.textarea.focus();
    this._paint();
    this._flush();
  }

  toggleComment() {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const from = this.value.lastIndexOf('\n', start - 1) + 1;
    let to = this.value.indexOf('\n', end);
    if (to < 0) to = this.value.length;
    const block = this.value.slice(from, to);
    const lines = block.split('\n');
    const commented = lines.every((line) => !line.trim() || line.trimStart().startsWith('%'));
    const next = lines
      .map((line) => (commented ? line.replace(/^(\s*)%/, '$1') : line.trim() ? `%${line}` : line))
      .join('\n');
    this.value = this.value.slice(0, from) + next + this.value.slice(to);
    this.textarea.value = this.value;
    this.textarea.setSelectionRange(from, from + next.length);
    this._paint();
    this._flush();
  }

  duplicateLine() {
    const start = this.textarea.selectionStart;
    const from = this.value.lastIndexOf('\n', start - 1) + 1;
    let to = this.value.indexOf('\n', start);
    if (to < 0) to = this.value.length;
    const line = this.value.slice(from, to);
    this.value = `${this.value.slice(0, to)}\n${line}${this.value.slice(to)}`;
    this.textarea.value = this.value;
    const caret = to + 1 + line.length;
    this.textarea.setSelectionRange(caret, caret);
    this._paint();
    this._flush();
  }

  // -- cursor --------------------------------------------------------------

  cursorOffset() {
    return this.textarea.selectionStart;
  }

  setCursorOffset(offset) {
    this.textarea.selectionStart = offset;
    this.textarea.selectionEnd = offset;
    this._reportCursor();
  }

  selectRange(start, end) {
    this.textarea.focus();
    this.textarea.setSelectionRange(start, end);
    this._revealLine(start);
    this._reportCursor();
  }

  _revealLine(offset) {
    const lines = this.value.slice(0, offset).split('\n');
    const lineHeight = this._lineHeight();
    if (!lineHeight) return;
    const target = (lines.length - 1) * lineHeight - this.textarea.clientHeight / 2;
    this.textarea.scrollTop = Math.max(0, target);
    this._onScroll();
  }

  _lineHeight() {
    if (this._lineHeightCache) return this._lineHeightCache;
    const style = getComputedStyle(this.textarea);
    const parsed = parseFloat(style.lineHeight);
    this._lineHeightCache = Number.isFinite(parsed) ? parsed : parseFloat(style.fontSize) * 1.6;
    return this._lineHeightCache;
  }

  _reportCursor() {
    const offset = this.cursorOffset();
    const before = this.value.slice(0, offset);
    const lines = before.split('\n');
    this.callbacks.onCursor?.({
      offset,
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
      selectionLength: this.textarea.selectionEnd - this.textarea.selectionStart,
    });
  }

  /** Scroll to a source offset and highlight the line. */
  revealOffset(offset, end = null) {
    this.selectRange(offset, end === null ? offset : end);
  }

  // -- find & replace -------------------------------------------------------

  /** Open the find bar (with the current selection as the initial query). */
  openFind({ replace = false } = {}) {
    const selected = this.value.slice(this.textarea.selectionStart, this.textarea.selectionEnd);
    if (!this.findState) {
      this.findState = { query: '', matches: [], index: -1, error: false };
    }
    this._ensureFindBar();
    this.findBar.classList.toggle('with-replace', !!replace);
    if (selected && selected.length <= 200 && selected.indexOf('\n') < 0) {
      this.findInput.value = selected;
    }
    this._onFindInput();
    this.findInput.focus();
    this.findInput.select();
  }

  closeFind() {
    if (this.findBar) this.findBar.remove();
    this.findBar = null;
    this.findState = null;
    this.textarea.focus();
  }

  _ensureFindBar() {
    if (this.findBar) return;
    const bar = document.createElement('div');
    bar.className = 'atex-findbar';
    bar.innerHTML = `
      <div class="atex-find-row">
        <input class="atex-find-input" type="text" placeholder="Find" />
        <button type="button" data-opt="case" title="Match case">Aa</button>
        <button type="button" data-opt="regex" title="Regular expression">.*</button>
        <span class="atex-find-count"></span>
        <button type="button" data-find="prev" title="Previous match (Shift+Enter)">${icon('chevron', 13)}</button>
        <button type="button" data-find="next" title="Next match (Enter)">${icon('chevron-down', 13)}</button>
        <button type="button" data-find="close" title="Close (Escape)">${icon('close', 13)}</button>
      </div>
      <div class="atex-find-row atex-find-replace">
        <input class="atex-replace-input" type="text" placeholder="Replace with" />
        <button type="button" data-find="replace">Replace</button>
        <button type="button" data-find="all">All</button>
      </div>
    `;
    bar.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeFind();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.findNext(event.shiftKey ? -1 : 1);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        bar.classList.add('with-replace');
        bar.querySelector('.atex-replace-input').focus();
      }
    });
    bar.addEventListener('input', (event) => {
      if (event.target.classList.contains('atex-find-input')) this._onFindInput();
    });
    bar.addEventListener('click', (event) => {
      const opt = event.target.closest('[data-opt]');
      if (opt) {
        opt.classList.toggle('on');
        this._onFindInput();
        return;
      }
      const button = event.target.closest('[data-find]');
      if (!button) return;
      const what = button.dataset.find;
      if (what === 'close') this.closeFind();
      else if (what === 'prev') this.findNext(-1);
      else if (what === 'next') this.findNext(1);
      else if (what === 'replace') this.replaceOne();
      else if (what === 'all') this.replaceAll();
    });
    this.wrap.appendChild(bar);
    this.findBar = bar;
    this.findInput = bar.querySelector('.atex-find-input');
    this.replaceInput = bar.querySelector('.atex-replace-input');
  }

  _findOptions() {
    return {
      caseSensitive: this.findBar?.querySelector('[data-opt="case"]')?.classList.contains('on'),
      regex: this.findBar?.querySelector('[data-opt="regex"]')?.classList.contains('on'),
      replaceText: this.replaceInput ? this.replaceInput.value : '',
    };
  }

  _collectMatches(query, { caseSensitive = false, regex = false } = {}) {
    if (!query) return [];
    if (regex) {
      try {
        const re = new RegExp(query, caseSensitive ? 'g' : 'gi');
        const out = [];
        let m;
        while ((m = re.exec(this.value))) {
          out.push([m.index, m.index + m[0].length]);
          if (m.index === re.lastIndex) re.lastIndex++;
          if (out.length >= 10000) break;
        }
        return out;
      } catch {
        return null; // invalid pattern — reported by the count field
      }
    }
    const hay = caseSensitive ? this.value : this.value.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const out = [];
    let at = 0;
    while ((at = hay.indexOf(needle, at)) >= 0) {
      out.push([at, at + needle.length]);
      at += needle.length || 1;
      if (out.length >= 10000) break;
    }
    return out;
  }

  _onFindInput() {
    if (!this.findState) return;
    this.findState.query = this.findInput.value;
    this._refreshMatches();
    this.findNext(1);
  }

  _refreshMatches() {
    if (!this.findState) return;
    const { caseSensitive, regex } = this._findOptions();
    this.findState.error = false;
    this.findState.matches = this._collectMatches(this.findState.query, { caseSensitive, regex });
    if (this.findState.matches === null) {
      this.findState.error = true;
      this.findState.matches = [];
    }
    this.findState.index = -1;
    this._updateFindCount();
  }

  _updateFindCount() {
    if (!this.findBar) return;
    const count = this.findBar.querySelector('.atex-find-count');
    if (this.findState.error) {
      count.textContent = 'bad pattern';
    } else if (!this.findState.query) {
      count.textContent = '';
    } else {
      const n = this.findState.matches.length;
      count.textContent = n ? `${this.findState.index + 1}/${n}` : 'no matches';
    }
    count.classList.toggle('atex-find-error', this.findState.error || (!this.findState.query ? false : this.findState.matches.length === 0));
  }

  /** Move to the next match (dir = 1) or previous (dir = -1), wrapping around. */
  findNext(dir = 1) {
    if (!this.findState || !this.findBar) return;
    const { matches } = this.findState;
    if (!matches.length) {
      this._updateFindCount();
      return;
    }
    // Anchor past the current selection so pressing Enter advances to the
    // *next* match instead of re-selecting the one already highlighted.
    let index;
    if (dir > 0) {
      const cursor = this.textarea.selectionEnd;
      index = matches.findIndex(([start]) => start >= cursor && start !== this.textarea.selectionStart);
      if (index < 0) index = matches.findIndex(([start]) => start >= cursor);
      if (index < 0) index = 0;
    } else {
      const cursor = this.textarea.selectionStart;
      index = -1;
      for (let i = matches.length - 1; i >= 0; i--) {
        if (matches[i][1] <= cursor && matches[i][1] !== this.textarea.selectionEnd) {
          index = i;
          break;
        }
      }
      if (index < 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
          if (matches[i][1] <= cursor) {
            index = i;
            break;
          }
        }
      }
      if (index < 0) index = matches.length - 1;
    }
    this.findState.index = index;
    const [start, end] = matches[index];
    this.selectRange(start, end);
    this._updateFindCount();
  }

  replaceOne() {
    if (!this.findState || !this.findState.query) return;
    const current = this.findState.index >= 0 ? this.findState.matches[this.findState.index] : null;
    const { replaceText, regex, caseSensitive } = this._findOptions();
    let nextFrom = this.textarea.selectionStart;
    if (current) {
      const [start, end] = current;
      let replacement = replaceText;
      if (regex) {
        // Let `$1`, `$2`, … refer to capture groups of the match.
        try {
          const matched = this.value.slice(start, end);
          const flags = caseSensitive ? '' : 'i';
          replacement = matched.replace(new RegExp(this.findInput.value, flags), replaceText);
        } catch {
          replacement = replaceText;
        }
      }
      this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
      this.textarea.value = this.value;
      this._paint();
      nextFrom = start + replacement.length;
      this.textarea.setSelectionRange(nextFrom, nextFrom);
    }
    this._refreshMatches();
    this.findNext(1);
    this._flush();
  }

  replaceAll() {
    if (!this.findState || !this.findState.query) return;
    const { caseSensitive, regex, replaceText } = this._findOptions();
    const query = this.findState.query;
    if (regex) {
      try {
        const re = new RegExp(query, caseSensitive ? 'g' : 'gi');
        this.value = this.value.replace(re, replaceText);
      } catch {
        return;
      }
    } else if (caseSensitive) {
      this.value = this.value.split(query).join(replaceText);
    } else {
      // Case-insensitive literal replace — escape the query so `$` in the
      // replacement-friendly path cannot be read as a group reference.
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      this.value = this.value.replace(re, () => replaceText);
    }
    this.textarea.value = this.value;
    this._paint();
    this._refreshMatches();
    this.findNext(1);
    this._flush();
  }

  focus() {
    this.textarea.focus();
  }

  get element() {
    return this.wrap;
  }
}
