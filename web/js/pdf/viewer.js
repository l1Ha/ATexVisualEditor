/**
 * ATexVisualEditor — PDF preview.
 *
 * Pages are rendered server-side (pdftocairo → SVG) and dropped in as `<img>`:
 * vector output stays crisp at every zoom level, and there is no bundled PDF
 * engine to keep in sync.  Pages load lazily as they scroll into view.
 *
 * Clicking a page asks the server for the SyncTeX inverse mapping and reports
 * the source position, so the preview doubles as a navigation surface.
 */

import { icon } from '../ui/icons.js';

const PT_TO_PX = 96 / 72;

export class PdfViewer {
  constructor({ mount, api, callbacks = {} }) {
    this.mount = mount;
    this.api = api;
    this.callbacks = callbacks;
    this.buildId = null;
    this.pages = [];
    this.zoom = 1;
    this.zoomMode = 'fit-width';
    this.currentPage = 1;
    this.observer = null;
    this.loadedPages = new Set();
    this._build();
  }

  _build() {
    this.mount.replaceChildren();
    this.wrap = document.createElement('div');
    this.wrap.className = 'atex-pdf';

    const bar = document.createElement('div');
    bar.className = 'atex-pdf-toolbar';
    this.wrap.appendChild(bar);
    this.toolbar = bar;

    this.pageLabel = document.createElement('span');
    this.pageLabel.className = 'atex-pdf-page';

    const makeButton = (name, title, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'atex-icon-btn';
      button.title = title;
      button.innerHTML = icon(name, 15);
      button.addEventListener('click', onClick);
      return button;
    };

    bar.append(
      makeButton('chevron', 'Previous page', () => this.goToPage(this.currentPage - 1)),
      this.pageLabel,
      makeButton('chevron-down', 'Next page', () => this.goToPage(this.currentPage + 1)),
      spacer(),
      makeButton('zoomOut', 'Zoom out', () => this.setZoom(this.zoom / 1.2)),
      makeButton('zoomIn', 'Zoom in', () => this.setZoom(this.zoom * 1.2)),
      fitButton('Fit width', () => this.fit('fit-width')),
      fitButton('Fit page', () => this.fit('fit-page')),
      spacer(),
      makeButton('download', 'Download the PDF', () => this.download())
    );

    function spacer() {
      const s = document.createElement('span');
      s.className = 'atex-toolbar-spacer';
      return s;
    }
    function fitButton(title, onClick) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'atex-icon-btn';
      button.title = title;
      button.textContent = title === 'Fit width' ? '⇔' : '⤢';
      button.addEventListener('click', onClick);
      return button;
    }

    this.scroll = document.createElement('div');
    this.scroll.className = 'atex-pdf-scroll';
    this.wrap.appendChild(this.scroll);

    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'atex-pdf-pages';
    this.scroll.appendChild(this.pagesEl);

    this.placeholder = document.createElement('div');
    this.placeholder.className = 'atex-pdf-placeholder';
    this.placeholder.innerHTML = `${icon('pdf', 26)}<p>No PDF yet</p><small>Compile the document to see a preview here.</small>`;
    this.scroll.appendChild(this.placeholder);

    this.mount.appendChild(this.wrap);

    this.scroll.addEventListener('scroll', () => this._onScroll());
    this.scroll.addEventListener('click', (event) => {
      const page = event.target.closest?.('.atex-pdf-page-box');
      if (!page) return;
      this._onPageClick(page, event);
    });
    window.addEventListener('keydown', (event) => {
      if (!this.scroll.offsetParent) return;
      if (document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)) return;
      if (event.key === 'PageDown') this.goToPage(this.currentPage + 1);
      if (event.key === 'PageUp') this.goToPage(this.currentPage - 1);
    });
  }

  /** Load a build: fetches page sizes and (re)creates the page elements. */
  async load(buildId, { pages = null, sizes = null } = {}) {
    this.buildId = buildId;
    this.pages = [];
    this.loadedPages.clear();
    this.pagesEl.replaceChildren();
    this.placeholder.style.display = buildId ? 'none' : '';

    if (!buildId) {
      this._updateLabel();
      return;
    }
    let pageCount = pages;
    let pageSizes = sizes;
    if (!pageCount) {
      try {
        const info = await this.api.get(`/api/projects/${this.api.projectId}/builds`);
        const build = (info.builds || []).find((entry) => entry.buildId === buildId);
        void build;
      } catch {
        /* fall through to a single-page guess */
      }
      pageCount = pageCount || 1;
    }
    if (!pageSizes || !pageSizes.length) {
      pageSizes = new Array(pageCount).fill({ width: 595.276, height: 841.89 });
    }
    for (let index = 0; index < pageCount; index++) {
      const size = pageSizes[index] || pageSizes[0] || { width: 595.276, height: 841.89 };
      this.pages.push({ number: index + 1, size, element: null, image: null, loaded: false });
    }
    this._renderPages();
    this.fit(this.zoomMode);
    this._updateLabel();
  }

  _renderPages() {
    const fragment = document.createDocumentFragment();
    for (const page of this.pages) {
      const box = document.createElement('div');
      box.className = 'atex-pdf-page-box';
      box.dataset.page = String(page.number);
      box.style.width = `${Math.round(page.size.width * PT_TO_PX * this.zoom)}px`;
      box.style.height = `${Math.round(page.size.height * PT_TO_PX * this.zoom)}px`;
      const label = document.createElement('span');
      label.className = 'atex-pdf-page-label';
      label.textContent = String(page.number);
      box.appendChild(label);
      page.element = box;
      fragment.appendChild(box);
    }
    this.pagesEl.replaceChildren(fragment);

    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const number = Number(entry.target.dataset.page);
          this._loadPage(number);
          this.currentPage = number;
          this._updateLabel();
        }
      },
      { root: this.scroll, rootMargin: '600px 0px' }
    );
    for (const page of this.pages) this.observer.observe(page.element);
    // The first pages should not wait for a scroll event.
    this._loadPage(1);
    this._loadPage(2);
  }

  _loadPage(number) {
    const page = this.pages[number - 1];
    if (!page || page.loaded) return;
    page.loaded = true;
    this.loadedPages.add(number);
    const image = document.createElement('img');
    image.className = 'atex-pdf-page-image';
    image.alt = `Page ${number}`;
    image.decoding = 'async';
    image.src = this.api.pageUrl(number, 'svg', this.buildId);
    image.addEventListener('error', () => {
      // SVG may be unavailable; fall back to a high-resolution bitmap.
      if (image.dataset.retried) return;
      image.dataset.retried = '1';
      image.src = this.api.pageUrl(number, 'png', this.buildId, 150);
    });
    image.addEventListener('load', () => {
      page.element.classList.add('is-ready');
      this.callbacks.onPageRendered?.(number);
    });
    page.element.appendChild(image);
    page.image = image;
  }

  setZoom(zoom) {
    this.zoom = Math.max(0.2, Math.min(4, zoom));
    this.zoomMode = 'manual';
    this._applyZoom();
  }

  fit(mode = 'fit-width') {
    this.zoomMode = mode;
    const first = this.pages[0];
    if (!first) return;
    const available = this.scroll.clientWidth - 48;
    const height = this.scroll.clientHeight - 24;
    if (mode === 'fit-width') {
      this.zoom = available / (first.size.width * PT_TO_PX);
    } else {
      this.zoom = Math.min(available / (first.size.width * PT_TO_PX), height / (first.size.height * PT_TO_PX));
    }
    this.zoom = Math.max(0.2, Math.min(3, this.zoom));
    this._applyZoom();
  }

  _applyZoom() {
    for (const page of this.pages) {
      if (!page.element) continue;
      page.element.style.width = `${Math.round(page.size.width * PT_TO_PX * this.zoom)}px`;
      page.element.style.height = `${Math.round(page.size.height * PT_TO_PX * this.zoom)}px`;
    }
  }

  goToPage(number) {
    const page = this.pages[Math.max(0, Math.min(this.pages.length - 1, number - 1))];
    if (!page) return;
    this.currentPage = page.number;
    page.element?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    this._updateLabel();
  }

  /** Scroll to the page that SyncTeX associates with a source position. */
  async scrollToSource(file, line) {
    if (!this.buildId || !this.pages.length) return false;
    try {
      const result = await this.api.post(`/api/projects/${this.api.projectId}/synctex`, {
        direction: 'forward',
        file,
        line,
        build: this.buildId,
      });
      const hit = (result.hits || [])[0];
      if (!hit) return false;
      this.goToPage(hit.page);
      this._flashAt(hit);
      return true;
    } catch {
      return false;
    }
  }

  _flashAt(hit) {
    const page = this.pages[hit.page - 1];
    if (!page || !page.element) return;
    const box = page.element.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.className = 'atex-pdf-marker';
    marker.style.left = `${(hit.x / page.size.width) * 100}%`;
    marker.style.top = `${(hit.y / page.size.height) * 100}%`;
    marker.style.width = `${Math.max(2, (hit.width / page.size.width) * 100)}%`;
    marker.style.height = `${Math.max(1, (hit.height / page.size.height) * 100)}%`;
    page.element.appendChild(marker);
    void box;
    setTimeout(() => marker.classList.add('is-fading'), 900);
    setTimeout(() => marker.remove(), 1600);
  }

  async _onPageClick(box, event) {
    if (!this.buildId) return;
    const page = this.pages[Number(box.dataset.page) - 1];
    if (!page) return;
    const rect = box.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * page.size.width;
    const y = ((event.clientY - rect.top) / rect.height) * page.size.height;
    try {
      const result = await this.api.post(`/api/projects/${this.api.projectId}/synctex`, {
        direction: 'inverse',
        page: page.number,
        x,
        y,
        build: this.buildId,
      });
      if (result.hit) this.callbacks.onSourcePosition?.(result.hit);
    } catch {
      /* clicking a page should never throw */
    }
  }

  _onScroll() {
    if (this.zoomMode !== 'manual') {
      const width = this.scroll.clientWidth;
      if (width && Math.abs(width - this._lastWidth || 0) > 2) {
        this._lastWidth = width;
        this.fit(this.zoomMode);
      }
    }
  }

  _updateLabel() {
    const total = this.pages.length;
    this.pageLabel.textContent = total ? `${this.currentPage} / ${total}` : '—';
  }

  download() {
    if (!this.buildId) return;
    window.open(this.api.pdfUrl(this.buildId, { download: true }), '_blank');
  }

  /** Show the "stale" state while a rebuild is running. */
  setBusy(busy) {
    this.wrap.classList.toggle('is-busy', !!busy);
  }

  setError(message) {
    if (!message) {
      this.placeholder.style.display = this.buildId ? 'none' : '';
      return;
    }
    this.placeholder.style.display = '';
    this.placeholder.innerHTML = `${icon('warning', 26)}<p>Build failed</p><small></small>`;
    this.placeholder.querySelector('small').textContent = message;
  }
}
