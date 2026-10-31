/**
 * ATexVisualEditor — application wiring.
 *
 * Owns the shell: project loading, the file tree, the visual/source/PDF panes,
 * compilation, autosave and all the keyboard shortcuts. The editors themselves
 * (`VisualEditor`, `SourceEditor`, `PdfViewer`) are independent modules; this
 * file connects them to the server and to each other.
 */

import { Api } from './api.js';
import { Doc } from './core/doc.js';
import { parseBib, formatEntry, latexToUnicode, shortAuthor } from './core/bib.js';
import { VisualEditor, escapeLatexText } from './visual/editor.js';
import { buildBlocks } from './visual/blocks.js';
import { SourceEditor } from './source/editor.js';
import { PdfViewer } from './pdf/viewer.js';
import { icon } from './ui/icons.js';
import { toast, modal, popover, formModal, promptModal, closePopover } from './ui/overlays.js';
import { openMenuFor, closeMenu } from './ui/menus.js';
import { renderFileTree, renderOutline, renderDiagnostics, renderLog, renderBibPanel } from './ui/panels.js';
import { openPalette } from './ui/palette.js';

const STORAGE_KEY = 'atex.settings.v1';

const api = new Api();

const state = {
  server: null,
  projects: [],
  project: null,
  doc: null,
  activePath: 'main.tex',
  files: [],
  bibEntries: [],
  build: null,
  view: 'visual',
  compiling: false,
  compileTimer: null,
  compileQueued: false,
  savedAt: null,
  dirty: false,
  settings: {
    theme: 'light',
    sidebar: true,
    pdfPane: true,
    autoCompile: true,
    autoCompileDelay: 1400,
    engine: '',
    spellCheck: true,
    serverMathPreview: true,
    fontSize: 16,
    showRefKeys: false,
    autoSave: true,
  },
};

let visual = null;
let source = null;
let pdf = null;

const el = {};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function boot() {
  cacheElements();
  loadSettings();
  applyTheme();
  bindGlobalKeys();
  bindToolbar();
  bindSplitter();

  try {
    state.server = await api.serverStatus();
  } catch (err) {
    showFatal(err.message);
    return;
  }
  if (!state.server.toolchain.hasTex) {
    toast('No LaTeX engine found — the visual editor works, but compiling is disabled.', {
      kind: 'warning',
      timeout: 9000,
    });
  }

  const projects = await api.listProjects();
  state.projects = projects.projects || [];
  const wanted = new URLSearchParams(location.search).get('project') || location.hash.replace('#', '');
  const target = state.projects.find((p) => p.id === wanted) || state.projects[0];
  if (!target) {
    await createProjectDialog({ firstRun: true });
    return;
  }
  await openProject(target.id);
}

function cacheElements() {
  el.topbar = document.getElementById('atex-topbar');
  el.projectChip = document.getElementById('atex-project-chip');
  el.viewSwitch = document.getElementById('atex-view-switch');
  el.compileSplit = document.getElementById('atex-compile-split');
  el.compileBtn = document.getElementById('atex-compile-btn');
  el.compileMenu = document.getElementById('atex-compile-menu');
  el.sidebar = document.getElementById('atex-sidebar');
  el.sidebarBody = document.getElementById('atex-sidebar-body');
  el.sidebarFooter = document.getElementById('atex-sidebar-footer');
  el.tabs = document.getElementById('atex-tabs');
  el.editorPane = document.getElementById('atex-editor-pane');
  el.editorToolbar = document.getElementById('atex-editor-toolbar');
  el.visualScroll = document.getElementById('atex-visual-scroll');
  el.visualMount = document.getElementById('atex-visual');
  el.sourceMount = document.getElementById('atex-source');
  el.pdfPane = document.getElementById('atex-pdf-pane');
  el.pdfMount = document.getElementById('atex-pdf');
  el.splitter = document.getElementById('atex-splitter');
  el.sidebarSplitter = document.getElementById('atex-sidebar-splitter');
  el.statusLeft = document.getElementById('atex-status-left');
  el.statusRight = document.getElementById('atex-status-right');
  el.tabBadgeProblems = document.getElementById('atex-tab-badge-problems');
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    Object.assign(state.settings, saved);
  } catch {
    /* ignore a corrupt settings blob */
  }
  applyPaneVisibility();
  applyFontSize();
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* storage may be unavailable in private mode */
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}

function applyPaneVisibility() {
  el.sidebar.hidden = !state.settings.sidebar;
  el.sidebarSplitter.hidden = !state.settings.sidebar;
  el.pdfPane.hidden = !state.settings.pdfPane;
  el.splitter.hidden = !state.settings.pdfPane;
}

function applyFontSize() {
  document.documentElement.style.setProperty('--doc-font-size', `${state.settings.fontSize}px`);
}

// ---------------------------------------------------------------------------
// Project handling
// ---------------------------------------------------------------------------

async function openProject(id) {
  closePopover();
  closeMenu();
  try {
    state.project = await api.openProject(id);
  } catch (err) {
    toast(`Could not open the project: ${err.message}`, { kind: 'error' });
    return;
  }
  state.files = state.project.files || [];
  state.activePath = state.project.mainFile || state.files.find((file) => file.latex)?.path || 'main.tex';
  state.engine = state.project.settings?.engine || state.server.toolchain.defaultEngine;
  state.settings.autoCompile = state.project.settings?.autoCompile ?? true;

  history.replaceState(null, '', `?project=${encodeURIComponent(id)}`);
  updateProjectChip();

  await loadFiles();
  await loadActiveFile();
  await loadBibliography();
  buildEditors();
  renderSidebar();
  await compile({ reason: 'open' });
  renderStatus();
}

async function loadFiles() {
  const tree = await api.projectTree();
  state.files = tree.files || [];
  state.project.mainFile = tree.mainFile || state.project.mainFile;
  if (!state.files.some((file) => file.path === state.activePath)) {
    state.activePath = state.project.mainFile || state.files.find((file) => file.latex)?.path || '';
  }
}

async function loadActiveFile() {
  if (!state.activePath) {
    state.doc = new Doc('', { path: 'main.tex' });
    return;
  }
  const file = await api.readFile(state.activePath);
  if (file.binary) {
    toast(`“${state.activePath}” is a binary file`, { kind: 'warning' });
    state.doc = new Doc('', { path: state.activePath });
    return;
  }
  state.doc = new Doc(file.content, { path: state.activePath, name: state.project.name });
  state.doc.on('change', onDocChanged);
}

async function loadBibliography() {
  state.bibEntries = [];
  const bibFiles = state.files.filter((file) => file.name?.endsWith('.bib'));
  for (const file of bibFiles) {
    try {
      const data = await api.readFile(file.path);
      const parsed = parseBib(data.content, { file: file.path });
      state.bibEntries.push(...parsed.entries);
      for (const error of parsed.errors) {
        console.warn(`[bib] ${file.path}:${error.line} ${error.message}`);
      }
    } catch (err) {
      console.warn(`[bib] could not read ${file.path}: ${err.message}`);
    }
  }
}

function updateProjectChip() {
  el.projectChip.replaceChildren();
  const name = document.createElement('strong');
  name.textContent = state.project.name || state.project.id;
  const meta = document.createElement('small');
  const engine = state.engine || state.server.toolchain.defaultEngine;
  meta.textContent = `${state.project.mainFile || 'main.tex'} · ${engine}`;
  const chevron = document.createElement('span');
  chevron.innerHTML = icon('chevron-down', 13);
  el.projectChip.append(name, meta, chevron);
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function buildEditors() {
  if (pdf) pdf.load(null);
  if (source) {
    source.setValue(state.doc.source, { preserveCursor: false });
  }
  const commonCallbacks = {
    onFilesChanged: () => refreshFiles({ quiet: true }),
    getFiles: () => state.files,
    getBibEntries: () => state.bibEntries,
    onRevealSource: (offset, end) => revealInSource(offset, end),
    onOpenFile: (path) => openIncludedFile(path),
  };

  if (!visual) {
    visual = new VisualEditor({
      mount: el.visualMount,
      doc: state.doc,
      projectId: state.project.id,
      settings: {
        spellCheck: state.settings.spellCheck,
        serverMathPreview: state.settings.serverMathPreview,
        showRefKeys: state.settings.showRefKeys,
      },
      callbacks: {
        ...commonCallbacks,
        onEdited: ({ origin, source: text }) => {
          state.dirty = true;
          if (origin !== 'source' && source) source.setValue(text, { preserveCursor: true });
          scheduleCompile();
          renderStatus();
        },
        onSelectionChange: (selection) => {
          renderToolbarState(selection);
          renderStatus(selection);
        },
        onRendered: () => {
          /* rendering is intentionally silent */
        },
      },
    });
  } else {
    visual.doc = state.doc;
    visual.projectId = state.project.id;
    visual.settings.spellCheck = state.settings.spellCheck;
    visual.settings.serverMathPreview = state.settings.serverMathPreview;
    visual.settings.showRefKeys = state.settings.showRefKeys;
    visual.render({ preserveCaret: false });
  }

  if (!source) {
    source = new SourceEditor({
      mount: el.sourceMount,
      callbacks: {
        onChange: (text) => {
          if (!state.doc) return;
          state.dirty = true;
          state.doc.setSource(text, { commit: true, kind: 'source', silent: true });
          visual.doc = state.doc;
          visual.render({ preserveCaret: true });
          // No renderSidebar() here: the tree shows names and badges, none of
          // which change while typing — rebuilding it would reset which
          // folders the user had collapsed.
          scheduleCompile();
          renderStatus();
        },
        onCursor: () => renderStatus(),
      },
    });
    // A freshly created editor starts empty: seed it with the document.
    source.setValue(state.doc.source, { preserveCursor: false });
  } else {
    source.setValue(state.doc.source, { preserveCursor: false });
  }

  if (!pdf) {
    pdf = new PdfViewer({
      mount: el.pdfMount,
      api,
      callbacks: {
        onSourcePosition: (hit) => {
          if (!hit) return;
          if (state.view === 'visual') visual.revealOffset(state.doc.positionToOffset(hit.line));
          revealInSource(state.doc.positionToOffset(hit.line));
        },
      },
    });
  }

  setView(state.view, { force: true });
}

function onDocChanged({ origin }) {
  if (origin === 'source' && source) {
    /* the source view already has the text */
  } else if (source && state.doc.source !== source.value) {
    source.setValue(state.doc.source, { preserveCursor: true });
  }
  if (origin === 'undo' || origin === 'redo') {
    visual.doc = state.doc;
    visual.render({ preserveCaret: true });
    if (source) source.setValue(state.doc.source, { preserveCursor: true });
  }
  renderSidebar();
}

function setView(view, { force = false } = {}) {
  if (!force && state.view === view) return;
  state.view = view;
  const visualOn = view === 'visual' || view === 'split' || view === 'source-visual';
  const sourceOn = view === 'source' || view === 'split' || view === 'source-visual';
  el.visualScroll.hidden = !visualOn;
  el.sourceMount.hidden = !sourceOn;
  if (view === 'split' || view === 'source-visual') {
    el.visualScroll.style.flex = '1 1 50%';
    el.visualScroll.style.maxWidth = '50%';
    el.sourceMount.style.flex = '1 1 50%';
    el.sourceMount.style.borderLeft = '1px solid var(--border)';
    el.sourceMount.style.display = 'flex';
  } else {
    el.visualScroll.style.flex = '';
    el.visualScroll.style.maxWidth = '';
    el.sourceMount.style.flex = '';
    el.sourceMount.style.borderLeft = '';
  }
  for (const button of el.viewSwitch.querySelectorAll('button')) {
    button.classList.toggle('is-active', button.dataset.view === view);
  }
  renderToolbar();
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

let activePanel = 'files';

function renderSidebar() {
  for (const button of el.tabs.querySelectorAll('.atex-tab')) {
    button.classList.toggle('is-active', button.dataset.panel === activePanel);
  }
  el.sidebarBody.replaceChildren();
  const mount = document.createElement('div');
  mount.style.height = '100%';
  el.sidebarBody.appendChild(mount);

  if (activePanel === 'files') {
    renderFileTree(mount, state.files, {
      activePath: state.activePath,
      mainFile: state.project?.mainFile,
      onOpen: (path) => switchFile(path),
      onDelete: (path) => deleteFile(path),
      onRename: (path) => renameFile(path),
      onDownload: (path) => window.open(api.rawUrl(path), '_blank'),
      onNewFile: (dir) => newFile(dir),
      onUpload: (dir) => uploadInto(dir),
    });
  } else if (activePanel === 'outline') {
    renderOutline(mount, state.doc, {
      onSelect: (node) => {
        if (state.view === 'source') {
          revealInSource(node.start);
        } else {
          visual.revealOffset(node.start);
          visual.focusOffset(node.start);
          revealInSource(node.start);
        }
      },
    });
  } else if (activePanel === 'problems') {
    renderDiagnostics(mount, state.build, {
      onSelect: (diagnostic) => jumpToDiagnostic(diagnostic),
    });
  } else if (activePanel === 'bib') {
    const cited = new Set();
    if (state.doc) {
      for (const match of state.doc.source.matchAll(/\\(?:cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g)) {
        for (const key of match[1].split(',')) cited.add(key.trim());
      }
    }
    renderBibPanel(mount, state.bibEntries, {
      format: formatEntry,
      isCited: (key) => cited.has(key),
      onSelect: (entry) => revealInSource(state.doc.positionToOffset(entry.line)),
    });
  }

  // Footer actions depend on the panel.
  el.sidebarFooter.replaceChildren();
  if (activePanel === 'files') {
    el.sidebarFooter.append(
      iconButton('plus', 'New file', () => newFile('')),
      iconButton('folder', 'New folder', () => newFolder('')),
      iconButton('upload', 'Upload files', () => uploadInto('')),
      iconButton('download', 'Download project as .zip', () => window.open(api.exportUrl(), '_blank'))
    );
  } else if (activePanel === 'bib') {
    el.sidebarFooter.append(
      iconButton('refresh', 'Reload bibliography', () => refreshFiles({ quiet: false }))
    );
  }
  updateTabBadges();
}

function iconButton(name, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'atex-icon-btn';
  button.title = title;
  button.innerHTML = icon(name, 15);
  button.addEventListener('click', onClick);
  return button;
}

function updateTabBadges() {
  const errors = state.build ? (state.build.diagnostics || []).filter((d) => d.severity === 'error').length : 0;
  const warnings = state.build ? (state.build.diagnostics || []).filter((d) => d.severity === 'warning').length : 0;
  const badge = el.tabBadgeProblems;
  if (!errors && !warnings) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = String(errors || warnings);
  badge.classList.toggle('is-warning', !errors && warnings > 0);
}

async function refreshFiles({ quiet = true } = {}) {
  await loadFiles();
  await loadBibliography();
  renderSidebar();
  if (!quiet) toast('Files reloaded', { kind: 'success', timeout: 1400 });
}

async function switchFile(path) {
  if (path === state.activePath) return;
  const entry = state.files.find((file) => file.path === path);
  if (entry && entry.type === 'dir') return; // folders are not documents
  if (state.dirty) await saveActiveFile({ silent: true });
  state.activePath = path;
  const file = state.files.find((entry) => entry.path === path);
  if (file && !file.text && !file.latex) {
    window.open(api.rawUrl(path), '_blank');
    return;
  }
  await loadActiveFile();
  buildEditors();
  renderSidebar();
  if (file?.latex) {
    state.project.mainFile = state.project.mainFile || path;
  }
  await compile({ reason: 'file-switch' });
}

/** Open a file referenced by \input / \include from the visual editor. */
async function openIncludedFile(rawPath) {
  const wanted = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!wanted) return;
  const path = [wanted, `${wanted}.tex`].find((p) => state.files.some((f) => f.path === p));
  if (!path) {
    toast(`“${wanted}” is not in this project yet`, { kind: 'warning' });
    return;
  }
  if (path === state.activePath) return;
  await switchFile(path);
}

async function newFile(dir) {
  const name = await promptModal({
    title: 'New file',
    label: dir ? `Name inside ${dir}/` : 'File name',
    value: '',
    placeholder: 'chapter2.tex',
    confirmLabel: 'Create',
  });
  if (!name) return;
  const path = dir ? `${dir}/${name}` : name;
  const isTex = name.endsWith('.tex');
  const content = isTex
    ? '\\section{New section}\n\nWrite here.\n'
    : '';
  try {
    await api.writeFile(path, content);
    await refreshFiles();
    await switchFile(path);
    toast(`Created ${path}`, { kind: 'success' });
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

async function newFolder(dir) {
  const name = await promptModal({
    title: 'New folder',
    label: dir ? `Name inside ${dir}/` : 'Folder name',
    value: '',
    placeholder: 'chapters',
    confirmLabel: 'Create',
  });
  if (!name) return;
  try {
    await api.mkdir(dir ? `${dir}/${name}` : name);
    await refreshFiles();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

async function renameFile(path) {
  const next = await promptModal({ title: 'Rename', label: 'New name', value: path, confirmLabel: 'Rename' });
  if (!next || next === path) return;
  try {
    await api.rename(path, next);
    if (state.activePath === path) state.activePath = next;
    await refreshFiles();
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

async function deleteFile(path) {
  const confirmed = await modal({
    title: 'Delete file',
    content: `<p>Delete <strong>${path}</strong>? This cannot be undone.</p>`,
    actions: [
      { label: 'Cancel', onClick: (panel, close) => close() },
      {
        label: 'Delete',
        kind: 'danger',
        onClick: async (panel, close) => {
          close();
          try {
            await api.deleteFile(path);
            if (state.activePath === path) {
              state.activePath = state.project.mainFile || '';
              await loadActiveFile();
              buildEditors();
            }
            await refreshFiles();
            toast(`Deleted ${path}`, { kind: 'success' });
          } catch (err) {
            toast(err.message, { kind: 'error' });
          }
        },
      },
    ],
    onClose: () => {},
  });
  void confirmed;
}

function uploadInto(dir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.tex,.bib,.sty,.cls,.txt,.md,.png,.jpg,.jpeg,.pdf,.eps,.svg,.csv,.tikz';
  input.addEventListener('change', async () => {
    for (const file of Array.from(input.files || [])) {
      const path = dir ? `${dir}/${file.name}` : file.name;
      const isImage = /\.(png|jpe?g|pdf|eps|svg|gif|webp)$/i.test(file.name);
      const target = isImage && !dir ? `figures/${file.name}` : path;
      try {
        await api.request(
          `/api/projects/${encodeURIComponent(state.project.id)}/upload?path=${encodeURIComponent(target)}`,
          { method: 'POST', body: await file.arrayBuffer() }
        );
      } catch (err) {
        toast(`Could not upload ${file.name}: ${err.message}`, { kind: 'error' });
      }
    }
    await refreshFiles({ quiet: false });
  });
  input.click();
}

async function saveActiveFile({ silent = false } = {}) {
  if (!state.doc || !state.activePath) return;
  if (!state.dirty) return;
  try {
    await api.writeFile(state.activePath, state.doc.source);
    state.dirty = false;
    state.savedAt = new Date();
    if (!silent) toast('Saved', { kind: 'success', timeout: 1200 });
    renderStatus();
  } catch (err) {
    toast(`Could not save: ${err.message}`, { kind: 'error' });
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

function scheduleCompile() {
  if (!state.settings.autoCompile) return;
  if (state.compileTimer) clearTimeout(state.compileTimer);
  state.compileTimer = setTimeout(() => {
    state.compileTimer = null;
    compile({ reason: 'auto' });
  }, state.settings.autoCompileDelay);
}

async function compile({ reason = 'manual' } = {}) {
  if (!state.server?.toolchain.hasTex) {
    if (reason === 'manual') toast('No LaTeX engine is installed', { kind: 'error' });
    return;
  }
  if (state.compiling) {
    state.compileQueued = true;
    return;
  }
  if (state.dirty && state.settings.autoSave) await saveActiveFile({ silent: true });
  state.compiling = true;
  setCompilingUI(true);
  const started = performance.now();
  try {
    const result = await api.compile({
      main: state.project.mainFile,
      engine: state.engine,
      synctex: true,
      includeLog: true,
    });
    state.build = result;
    if (result.aux) state.doc.applyAux(result.aux);
    if (result.pageSizes) {
      await pdf.load(result.buildId, { pages: result.pages, sizes: result.pageSizes });
    } else if (result.hasPdf) {
      await pdf.load(result.buildId);
    }
    pdf.setError(result.ok ? null : firstErrorMessage(result));
    renderDiagnosticsInto(result);
    updateTabBadges();
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (result.ok) {
      if (reason === 'manual') toast(`Compiled in ${seconds}s · ${result.pages} page(s)`, { kind: 'success' });
      if (state.view === 'visual' || state.view === 'split') visual.render({ preserveCaret: true });
    } else {
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      toast(
        `Build failed: ${errors.length || 1} error${errors.length === 1 ? '' : 's'}. See the Problems panel.`,
        {
          kind: 'error',
          timeout: 6000,
          action: { label: 'Show', onClick: () => selectPanel('problems') },
        }
      );
      if (errors.length) {
        const first = errors[0];
        if (first.file === state.activePath && first.line) {
          revealInSource(state.doc.positionToOffset(first.line));
        }
      }
    }
  } catch (err) {
    state.build = null;
    pdf.setError(err.message);
    toast(`Compilation failed: ${err.message}`, { kind: 'error', timeout: 7000 });
  } finally {
    state.compiling = false;
    setCompilingUI(false);
    renderStatus();
    if (state.compileQueued) {
      state.compileQueued = false;
      compile({ reason: 'queued' });
    }
  }
}

function firstErrorMessage(result) {
  const error = (result.diagnostics || []).find((item) => item.severity === 'error');
  return error ? error.message : 'The document did not produce a PDF.';
}

function renderDiagnosticsInto(result) {
  if (activePanel === 'problems') {
    const mount = el.sidebarBody.firstElementChild;
    if (mount) renderDiagnostics(mount, result, { onSelect: jumpToDiagnostic });
  }
}

function setCompilingUI(busy) {
  el.compileBtn.classList.toggle('is-busy', busy);
  el.compileBtn.innerHTML = busy ? `${icon('refresh', 14)} Compiling…` : `${icon('play', 14)} Compile`;
  el.compileSplit.classList.toggle('is-idle', !busy && state.build?.ok === true);
  pdf?.setBusy(busy);
}

function jumpToDiagnostic(diagnostic) {
  const line = diagnostic.line || 1;
  const offset = state.doc.positionToOffset(line);
  revealInSource(offset);
  if (state.view === 'visual' || state.view === 'split') {
    visual.revealOffset(offset);
    visual.focusOffset(offset);
  }
}

function revealInSource(offset, end = null) {
  if (!source) return;
  if (state.view === 'source' || state.view === 'split') {
    source.revealOffset(offset, end);
  } else {
    source.setCursorOffset(offset);
  }
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function renderToolbar() {
  const wrap = el.editorToolbar;
  wrap.replaceChildren();
  if (state.view === 'source') {
    wrap.append(
      group(
        iconButton('undo', 'Undo (Ctrl+Z)', () => doUndo()),
        iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => doRedo()),
        separator(),
        iconButton('code', 'Wrap in \\texttt', () => source.wrapSelection('\\texttt{', '}')),
        iconButton('bold', 'Wrap in \\textbf', () => source.wrapSelection('\\textbf{', '}')),
        iconButton('italic', 'Wrap in \\emph', () => source.wrapSelection('\\emph{', '}')),
        separator(),
        iconButton('hash', 'Comment / uncomment (Ctrl+/)', () => source.toggleComment()),
        separator(),
        iconButton('math', 'Display math', () => source.insertText('\\[\n  \n\\]\n')),
        iconButton('math-inline', 'Inline math', () => source.wrapSelection('$', '$')),
        iconButton('image', 'Include a graphic', () => source.insertText('\\includegraphics[width=0.8\\textwidth]{}')),
        iconButton('table', 'Table', () => source.insertText(tableSnippet())),
        iconButton('section', 'Section', () => source.insertText(sectionSnippet())),
        iconButton('link', 'Link', () => source.wrapSelection('\\href{}{', '}')),
        iconButton('tag', 'Label', () => source.insertText('\\label{}')),
        iconButton('quote', 'Citation', () => source.insertText('\\cite{}')),
        iconButton('footnote', 'Footnote', () => source.wrapSelection('\\footnote{', '}'))
      ),
      spacer(),
      searchBox()
    );
    return;
  }
  wrap.append(visualToolbar() , spacer(), searchBox());
}

function visualToolbar() {
  const marks = visual?.selectionState?.marks || new Set();
  const heading = visual?.selectionState?.headingLevel ?? 0;
  const listType = visual?.selectionState?.listType || null;

  const headingSelect = document.createElement('select');
  headingSelect.className = 'atex-toolbar-select';
  headingSelect.title = 'Paragraph style';
  const options = [
    ['0', 'Paragraph'],
    ['1', 'Section'],
    ['2', 'Subsection'],
    ['3', 'Subsubsection'],
    ['4', 'Paragraph heading'],
  ];
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (String(heading) === value) option.selected = true;
    headingSelect.appendChild(option);
  }
  headingSelect.addEventListener('change', () => {
    const level = Number(headingSelect.value);
    if (level === 0) visual.setHeadingLevel(0);
    else visual.setHeadingLevel(level);
  });

  const listButton = (type, iconName, title) =>
    toggleButton(iconName, title, listType === type, () => visual.wrapInList(type));

  return group(
    iconButton('undo', 'Undo (Ctrl+Z)', () => doUndo()),
    iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => doRedo()),
    separator(),
    headingSelect,
    separator(),
    toggleButton('bold', 'Bold (Ctrl+B)', marks.has('textbf'), () => visual.toggleInline('textbf')),
    toggleButton('italic', 'Italic (Ctrl+I)', marks.has('emph') || marks.has('textit'), () => visual.toggleInline('emph')),
    toggleButton('underline', 'Underline (Ctrl+U)', marks.has('underline'), () => visual.toggleInline('underline')),
    toggleButton('code', 'Monospace', marks.has('texttt'), () => visual.toggleInline('texttt')),
    toggleButton('strike', 'Strikethrough', marks.has('sout'), () => visual.toggleInline('sout')),
    toggleButton('superscript', 'Superscript', marks.has('textsuperscript'), () => visual.toggleInline('textsuperscript')),
    toggleButton('subscript', 'Subscript', marks.has('textsubscript'), () => visual.toggleInline('textsubscript')),
    colorButton(),
    separator(),
    listButton('itemize', 'list-bullet', 'Bulleted list'),
    listButton('enumerate', 'list-number', 'Numbered list'),
    listButton('description', 'text', 'Description list'),
    iconButton('indent', 'Indent (Tab)', () => visual.listIndent()),
    iconButton('outdent', 'Outdent (Shift+Tab)', () => visual.listOutdent()),
    separator(),
    iconButton('math-inline', 'Inline math (Ctrl+Shift+E)', () => visual.insertMath({ display: false })),
    menuButton('math', 'Display math (Ctrl+Shift+M)', [
      { label: 'Display math \\[ … \\]', onClick: () => visual.insertMath({ display: true }) },
      { label: 'Equation', onClick: () => visual.insertMath({ env: 'equation' }) },
      { label: 'Align', onClick: () => visual.insertMath({ env: 'align' }) },
      { label: 'Gather', onClick: () => visual.insertMath({ env: 'gather' }) },
      { label: 'Cases', onClick: () => visual.insertMath({ env: 'cases' }) },
      { separator: true },
      { label: 'Insert inline math', hint: 'Ctrl+Shift+E', onClick: () => visual.insertMath({ display: false }) },
    ]),
    separator(),
    iconButton('image', 'Insert a figure', () => visual.insertFigure({})),
    iconButton('table', 'Insert a table', () => insertTableDialog()),
    separator(),
    menuButton('quote', 'Insert', [
      { heading: 'Structure' },
      { label: 'Section', hint: 'Ctrl+1', onClick: () => visual.insertSection(1) },
      { label: 'Subsection', hint: 'Ctrl+2', onClick: () => visual.insertSection(2) },
      { label: 'Subsubsection', hint: 'Ctrl+3', onClick: () => visual.insertSection(3) },
      { separator: true },
      { label: 'Bulleted list', onClick: () => visual.wrapInList('itemize') },
      { label: 'Numbered list', onClick: () => visual.wrapInList('enumerate') },
      { label: 'Quote', onClick: () => visual.insertBlockSource('\\begin{quote}\n\n\\end{quote}', { caretOffset: 14 }) },
      { label: 'Theorem', onClick: () => visual.insertBlockSource('\\begin{theorem}\n\n\\end{theorem}', { caretOffset: 17 }) },
      { separator: true },
      { label: 'Page break', onClick: () => visual.insertPageBreak() },
      { label: 'Table of contents', onClick: () => visual.insertTableOfContents() },
      { label: 'Horizontal rule', onClick: () => visual.insertRule() },
    ]),
    iconButton('footnote', 'Footnote (Ctrl+Shift+F)', () => visual.insertFootnote()),
    iconButton('link', 'Link (Ctrl+Shift+K)', () => visual.insertHref()),
    separator(),
    iconButton('tag', 'Insert a label', () => visual.insertLabel()),
    iconButton('link', 'Reference a label (Ctrl+Shift+R)', () => visual.insertRef()),
    iconButton('book', 'Insert a citation (Ctrl+Shift+C)', () => visual.insertCite({})),
    separator(),
    menuButton('wand', 'More', [
      { label: 'Clear formatting', hint: 'Ctrl+0', onClick: () => visual.clearFormatting() },
      { label: 'Duplicate paragraph', onClick: () => duplicateBlock() },
      { separator: true },
      { label: 'Find in document', hint: 'Ctrl+F', onClick: () => focusSearch() },
      { label: 'Command palette', hint: 'Ctrl+K', onClick: () => openCommandPalette() },
      { separator: true },
      { label: state.settings.serverMathPreview ? 'Disable TeX math previews' : 'Enable TeX math previews',
        onClick: () => {
          state.settings.serverMathPreview = !state.settings.serverMathPreview;
          visual.settings.serverMathPreview = state.settings.serverMathPreview;
          saveSettings();
          visual.render({ preserveCaret: true });
        } },
      { label: state.settings.showRefKeys ? 'Show resolved reference numbers' : 'Show reference keys raw',
        onClick: () => {
          state.settings.showRefKeys = !state.settings.showRefKeys;
          visual.settings.showRefKeys = state.settings.showRefKeys;
          saveSettings();
          visual.render({ preserveCaret: true });
        } },
    ])
  );
}

function group(...children) {
  const wrap = document.createElement('div');
  wrap.className = 'atex-toolbar-group';
  for (const child of children) if (child) wrap.appendChild(child);
  return wrap;
}

function separator() {
  const span = document.createElement('span');
  span.className = 'atex-toolbar-sep';
  return span;
}

function spacer() {
  const span = document.createElement('span');
  span.className = 'atex-toolbar-spacer';
  return span;
}

function toggleButton(name, title, active, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `atex-icon-btn ${active ? 'is-active' : ''}`.trim();
  button.title = title;
  button.innerHTML = icon(name, 16);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', onClick);
  return button;
}

function menuButton(name, title, items) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'atex-icon-btn';
  button.title = title;
  button.innerHTML = `${icon(name, 16)}`;
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => openMenuFor(button, items));
  return button;
}

function colorButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'atex-icon-btn';
  button.title = 'Text colour';
  button.innerHTML = icon('palette2', 16);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    openMenuFor(button, [
      { heading: 'Text colour' },
      ...['red', 'blue', 'green', 'teal', 'orange', 'purple', 'magenta', 'gray', 'black'].map((color) => ({
        label: color[0].toUpperCase() + color.slice(1),
        onClick: () => visual.toggleInline('textcolor', { arg: color }),
      })),
      { separator: true },
      { label: 'Custom…', onClick: async () => {
          const value = await promptModal({ title: 'Text colour', label: 'Colour name, hex or rgb()', value: 'teal' });
          if (value) visual.toggleInline('textcolor', { arg: value });
        } },
    ]);
  });
  return button;
}

let searchState = { query: '', lastIndex: null };

function searchBox() {
  const wrap = document.createElement('div');
  wrap.className = 'atex-toolbar-group';
  const box = document.createElement('input');
  box.type = 'search';
  box.id = 'atex-search-box';
  box.className = 'atex-input';
  box.style.width = '140px';
  box.style.height = '28px';
  box.placeholder = 'Find…';
  box.value = searchState.query;
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch(box.value);
    }
    if (event.key === 'Escape') {
      box.value = '';
      searchState.query = '';
      box.blur();
    }
  });
  box.addEventListener('input', () => {
    if (!box.value) {
      searchState.lastIndex = null;
    }
  });
  wrap.appendChild(box);
  return wrap;
}

function focusSearch() {
  const box = document.getElementById('atex-search-box');
  if (box) {
    box.focus();
    box.select();
  }
}

function runSearch(query) {
  if (!query) return;
  searchState.query = query;
  const from = searchState.lastIndex === null ? 0 : searchState.lastIndex + query.length;
  const result = visual.find(query, { from });
  if (result) {
    searchState.lastIndex = result.start;
    if (state.view === 'split' || state.view === 'source') revealInSource(result.start, result.end);
  } else {
    searchState.lastIndex = null;
    toast(`“${query}” not found`, { kind: 'info', timeout: 1600 });
  }
}

async function insertTableDialog() {
  const values = await formModal({
    title: 'Insert a table',
    description: 'A \\begin{table} float with a booktabs tabular inside.',
    fields: [
      { name: 'rows', label: 'Rows (including the header)', type: 'number', value: '4' },
      { name: 'cols', label: 'Columns', type: 'number', value: '3' },
      {
        name: 'spec',
        label: 'Column specification',
        value: 'lrr',
        monospace: true,
        hint: 'l = left, c = centre, r = right, p{3cm} = fixed width',
      },
    ],
    confirmLabel: 'Insert',
  });
  if (!values) return;
  const rows = Math.max(1, Math.min(40, Number(values.rows) || 3));
  const cols = Math.max(1, Math.min(12, Number(values.cols) || 3));
  visual.insertTable({ rows, cols, spec: (values.spec || 'l'.repeat(cols)).replace(/[{}]/g, '') || 'l'.repeat(cols) });
}

function duplicateBlock() {
  const selection = visual.selectionRange();
  if (!selection) return;
  const block = visual.blockInfo(visual._currentBlockElement());
  if (!block || block.start === null) return;
  const text = state.doc.source.slice(block.start, block.end);
  visual.splice([{ start: block.end, end: block.end, text: `\n\n${text}` }], {
    caret: block.end + 2,
    kind: 'structural',
  });
}

function sectionSnippet() {
  return '\\section{Title}\n';
}

function tableSnippet() {
  return [
    '\\begin{table}[htbp]',
    '  \\centering',
    '  \\caption{Caption}',
    '  \\begin{tabular}{lrr}',
    '    \\toprule',
    '    A & B & C \\\\',
    '    \\midrule',
    '    1 & 2 & 3 \\\\',
    '    \\bottomrule',
    '  \\end{tabular}',
    '\\end{table}',
    '',
  ].join('\n');
}

function renderToolbarState() {
  if (state.view === 'source') return;
  const wrap = el.editorToolbar;
  const fresh = visualToolbar();
  const spacerEl = wrap.querySelector('.atex-toolbar-spacer');
  const box = wrap.querySelector('#atex-search-box')?.parentElement;
  wrap.replaceChildren(fresh);
  if (spacerEl) wrap.appendChild(spacerEl);
  else wrap.appendChild(spacer());
  if (box) wrap.appendChild(box);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function renderStatus(selection = null) {
  const parts = [];
  if (state.doc) {
    const stats = state.doc.stats || {};
    const position = selection
      ? state.doc.offsetToPosition(selection.start)
      : source
      ? { line: 1, column: 1 }
      : null;
    if (selection && !selection.collapsed) {
      parts.push(`${selection.words} word${selection.words === 1 ? '' : 's'} selected`);
    } else if (position) {
      parts.push(`Ln ${position.line}, Col ${position.column}`);
    }
    parts.push(`${stats.words || 0} words`);
    parts.push(`${stats.lines || 0} lines`);
    parts.push(`${stats.commands || 0} commands`);
  }
  el.statusLeft.textContent = parts.join('  ·  ');

  el.statusRight.replaceChildren();
  const add = (text, className = '', onClick = null) => {
    const span = document.createElement(onClick ? 'button' : 'span');
    span.className = `atex-status-item ${onClick ? 'atex-status-button' : ''} ${className}`.trim();
    span.textContent = text;
    if (onClick) span.addEventListener('click', onClick);
    el.statusRight.appendChild(span);
    return span;
  };

  if (state.build) {
    const errors = state.build.diagnostics.filter((d) => d.severity === 'error').length;
    const warnings = state.build.diagnostics.filter((d) => d.severity === 'warning').length;
    if (errors) add(`${iconText('warning')} ${errors} error${errors === 1 ? '' : 's'}`, 'atex-status-error', () => selectPanel('problems'));
    else if (warnings) add(`${iconText('warning')} ${warnings} warning${warnings === 1 ? '' : 's'}`, 'atex-status-warn', () => selectPanel('problems'));
    else add(`${iconText('check')} Build OK`, 'atex-status-ok', () => compile({ reason: 'manual' }));
    add(`${state.build.durationMs} ms`);
    add(`${state.build.pages} page${state.build.pages === 1 ? '' : 's'}`);
  } else {
    add('Not built yet');
  }
  add(state.dirty ? 'Unsaved changes' : state.savedAt ? `Saved ${formatTime(state.savedAt)}` : 'Up to date');
  const theme = add(state.settings.theme === 'dark' ? 'Dark' : 'Light', '', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings();
    renderStatus();
  });
  void theme;
}

function iconText(name) {
  return name === 'check' ? '✓' : name === 'warning' ? '⚠' : '•';
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------------
// Panels, tabs, splitters
// ---------------------------------------------------------------------------

function selectPanel(panel) {
  activePanel = panel;
  renderSidebar();
}

function bindToolbar() {
  el.viewSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-view]');
    if (!button) return;
    setView(button.dataset.view);
  });
  el.compileBtn.addEventListener('click', () => compile({ reason: 'manual' }));
  el.compileMenu.addEventListener('click', () => {
    openMenuFor(
      el.compileMenu,
      [
        { heading: 'Build' },
        ...(state.server?.toolchain.engines || []).map((engine) => ({
          label: engine.label,
          checked: (state.engine || state.server.toolchain.defaultEngine) === engine.id,
          disabled: !engine.available,
          hint: engine.available ? '' : 'not installed',
          onClick: () => {
            state.engine = engine.id;
            api.saveSettings(state.project.id, { engine: engine.id }).catch(() => {});
            updateProjectChip();
            compile({ reason: 'engine-change' });
          },
        })),
        { separator: true },
        {
          label: 'Auto-compile on change',
          checked: state.settings.autoCompile,
          onClick: () => {
            state.settings.autoCompile = !state.settings.autoCompile;
            saveSettings();
            api.saveSettings(state.project.id, { autoCompile: state.settings.autoCompile }).catch(() => {});
          },
        },
        {
          label: 'Set as main document',
          icon: icon('target', 13),
          onClick: async () => {
            await api.saveSettings(state.project.id, { mainFile: state.activePath });
            state.project.mainFile = state.activePath;
            state.settings.autoCompile = state.settings.autoCompile;
            updateProjectChip();
            renderSidebar();
            compile({ reason: 'main-change' });
            toast(`${state.activePath} is now the main document`, { kind: 'success' });
          },
        },
        { separator: true },
        { label: 'Download the PDF', icon: icon('download', 13), onClick: () => pdf.download() },
        {
          label: 'Open the raw build log',
          icon: icon('terminal', 13),
          onClick: () => {
            const pre = document.createElement('pre');
            pre.className = 'atex-code-preview';
            pre.textContent = (state.build && state.build.log) || 'No build yet.';
            modal({ title: 'Build log', content: pre, wide: true });
          },
        },
      ],
      { align: 'right', width: 240 }
    );
  });

  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.atex-tab');
    if (!tab) return;
    selectPanel(tab.dataset.panel);
  });

  el.projectChip.addEventListener('click', () => {
    openMenuFor(
      el.projectChip,
      [
        { heading: 'Projects' },
        ...state.projects.slice(0, 14).map((project) => ({
          label: project.name,
          checked: project.id === state.project.id,
          hint: `${project.fileCount} file${project.fileCount === 1 ? '' : 's'}`,
          onClick: () => openProject(project.id),
        })),
        { separator: true },
        { label: 'New project…', icon: icon('plus', 13), onClick: () => createProjectDialog({}) },
        { label: 'Import a .zip…', icon: icon('upload', 13), onClick: () => importProject() },
        {
          label: 'Duplicate this project',
          icon: icon('copy', 13),
          onClick: async () => {
            try {
              const copy = await api.duplicateProject(state.project.id);
              state.projects = (await api.listProjects()).projects;
              await openProject(copy.id);
              toast('Project duplicated', { kind: 'success' });
            } catch (err) {
              toast(err.message, { kind: 'error' });
            }
          },
        },
        { label: 'Download as .zip', icon: icon('download', 13), onClick: () => window.open(api.exportUrl(), '_blank') },
        {
          label: 'Rename this project…',
          icon: icon('text', 13),
          onClick: async () => {
            const name = await promptModal({ title: 'Rename project', label: 'Name', value: state.project.name });
            if (!name) return;
            await api.saveSettings(state.project.id, { name });
            state.project.name = name;
            state.projects = (await api.listProjects()).projects;
            updateProjectChip();
          },
        },
        { separator: true },
        {
          label: 'Delete this project',
          icon: icon('trash', 13),
          kind: 'danger',
          onClick: async () => {
            const confirmed = await confirmDialog(
              'Delete project',
              `Delete “${state.project.name}” and all of its files? This cannot be undone.`,
              'Delete'
            );
            if (!confirmed) return;
            try {
              await api.deleteProject(state.project.id);
              state.projects = (await api.listProjects()).projects;
              if (state.projects.length) await openProject(state.projects[0].id);
              else location.reload();
            } catch (err) {
              toast(err.message, { kind: 'error' });
            }
          },
        },
      ],
      { width: 260 }
    );
  });
}

function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    modal({
      title,
      content: `<p>${message}</p>`,
      actions: [
        { label: 'Cancel', onClick: (panel, close) => { close(); resolve(false); } },
        { label: confirmLabel, kind: 'danger', onClick: (panel, close) => { close(); resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
  });
}

function bindSplitter() {
  const attach = (splitter, target, { side = 'left' } = {}) => {
    if (!splitter || !target) return;
    splitter.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      splitter.classList.add('is-dragging');
      splitter.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = side === 'left' ? target.getBoundingClientRect().width : 0;
      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (side === 'left') {
          const width = Math.max(180, Math.min(520, startWidth + delta));
          document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
          target.style.width = `${width}px`;
        } else {
          const paneRect = el.editorPane.parentElement.getBoundingClientRect();
          const width = Math.max(240, Math.min(paneRect.width - 320, paneRect.right - moveEvent.clientX));
          el.pdfPane.style.flex = `0 0 ${width}px`;
        }
      };
      const onUp = () => {
        splitter.classList.remove('is-dragging');
        splitter.removeEventListener('pointermove', onMove);
        splitter.removeEventListener('pointerup', onUp);
        window.dispatchEvent(new Event('resize'));
      };
      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
    });
  };
  attach(el.sidebarSplitter, el.sidebar, { side: 'left' });
  attach(el.splitter, el.pdfPane, { side: 'right' });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

function doUndo() {
  const entry = state.doc.undo();
  if (!entry) return;
}

function doRedo() {
  state.doc.redo();
}

function bindGlobalKeys() {
  window.addEventListener('keydown', async (event) => {
    if (event.defaultPrevented) return; // an editor already handled this key
    const mod = event.ctrlKey || event.metaKey;
    const target = event.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (!mod) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      compile({ reason: 'manual' });
      return;
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      await saveActiveFile({});
      return;
    }
    if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
      event.preventDefault();
      openCommandPalette();
      return;
    }
    if (event.key.toLowerCase() === 'p') {
      event.preventDefault();
      openQuickSwitch();
      return;
    }
    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      focusSearch();
      return;
    }
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (event.key.toLowerCase() === 'y') {
      event.preventDefault();
      doRedo();
      return;
    }
    if (event.key === '\\') {
      event.preventDefault();
      state.settings.sidebar = !state.settings.sidebar;
      applyPaneVisibility();
      saveSettings();
      return;
    }
    if (event.key.toLowerCase() === 'j') {
      event.preventDefault();
      state.settings.pdfPane = !state.settings.pdfPane;
      applyPaneVisibility();
      saveSettings();
      return;
    }
    if (!inField && ['1', '2', '3', '4'].includes(event.key)) {
      event.preventDefault();
      visual.insertSection(Number(event.key));
      return;
    }
    if (!inField && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      setView(state.view === 'visual' ? 'source' : 'visual');
    }
  });
}

async function openCommandPalette() {
  if (isModalOpen()) return;
  const items = [];
  const add = (group, label, hint, run, keywords = '') => items.push({ group, label, hint, run, keywords });

  add('View', state.view === 'visual' ? 'Switch to source view' : 'Switch to visual view', 'Ctrl+M', () =>
    setView(state.view === 'visual' ? 'source' : 'visual')
  );
  add('View', 'Show visual and source side by side', '', () => setView('split'));
  add('View', state.settings.sidebar ? 'Hide the sidebar' : 'Show the sidebar', 'Ctrl+\\', () => {
    state.settings.sidebar = !state.settings.sidebar;
    applyPaneVisibility();
    saveSettings();
  });
  add('View', state.settings.pdfPane ? 'Hide the PDF preview' : 'Show the PDF preview', 'Ctrl+J', () => {
    state.settings.pdfPane = !state.settings.pdfPane;
    applyPaneVisibility();
    saveSettings();
  });
  add('View', `Switch to the ${state.settings.theme === 'dark' ? 'light' : 'dark'} theme`, '', () => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveSettings();
  });
  add('Build', 'Compile the document', 'Ctrl+Enter', () => compile({ reason: 'manual' }));
  add('Build', 'Compile with XeLaTeX', '', () => { state.engine = 'xelatex'; updateProjectChip(); compile({ reason: 'engine' }); });
  add('Build', 'Compile with pdfLaTeX', '', () => { state.engine = 'pdflatex'; updateProjectChip(); compile({ reason: 'engine' }); });
  add('Build', 'Show the build log', '', () => {
    const pre = document.createElement('pre');
    pre.className = 'atex-code-preview';
    pre.textContent = (state.build && state.build.log) || 'No build yet.';
    modal({ title: 'Build log', content: pre, wide: true });
  });
  add('Insert', 'Section', 'Ctrl+1', () => visual.insertSection(1));
  add('Insert', 'Subsection', 'Ctrl+2', () => visual.insertSection(2));
  add('Insert', 'Bulleted list', '', () => visual.wrapInList('itemize'));
  add('Insert', 'Numbered list', '', () => visual.wrapInList('enumerate'));
  add('Insert', 'Display math', 'Ctrl+Shift+M', () => visual.insertMath({ display: true }));
  add('Insert', 'Inline math', 'Ctrl+Shift+E', () => visual.insertMath({ display: false }));
  add('Insert', 'Figure', '', () => visual.insertFigure({}));
  add('Insert', 'Table', '', () => insertTableDialog());
  add('Insert', 'Citation', 'Ctrl+Shift+C', () => visual.insertCite({}));
  add('Insert', 'Reference', 'Ctrl+Shift+R', () => visual.insertRef());
  add('Insert', 'Footnote', 'Ctrl+Shift+F', () => visual.insertFootnote());
  add('Insert', 'Label', '', () => visual.insertLabel());
  add('Insert', 'Link', 'Ctrl+Shift+K', () => visual.insertHref());
  add('Insert', 'Page break', '', () => visual.insertPageBreak());
  add('Insert', 'Table of contents', '', () => visual.insertTableOfContents());
  add('File', 'Save', 'Ctrl+S', () => saveActiveFile({}));
  add('File', 'New file…', '', () => newFile(''));
  add('File', 'Download the project as .zip', '', () => window.open(api.exportUrl(), '_blank'));
  add('File', 'New project…', '', () => createProjectDialog({}));
  add('File', 'Import a .zip…', '', () => importProject());

  for (const entry of (state.doc?.sectionList() || []).slice(0, 60)) {
    add('Go to section', entry.title, `line ${state.doc.offsetToPosition(entry.node.start).line}`, () => {
      visual.revealOffset(entry.node.start);
      visual.focusOffset(entry.node.start);
      revealInSource(entry.node.start);
    });
  }

  const picked = await openPalette(items, { title: 'Command palette' });
  void picked;
}

function isModalOpen() {
  return !!document.querySelector('.atex-modal-backdrop');
}

async function openQuickSwitch() {
  const items = state.files
    .filter((file) => file.type === 'file')
    .map((file) => ({
      group: 'Files',
      label: file.path,
      hint: file.size ? `${Math.round(file.size / 1024)} kB` : '',
      run: () => switchFile(file.path),
    }));
  await openPalette(items, { title: 'Open a file', placeholder: 'File name…' });
}

// ---------------------------------------------------------------------------
// Project dialog
// ---------------------------------------------------------------------------

function createProjectDialog({ firstRun = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'atex-form';
    const nameField = document.createElement('div');
    nameField.className = 'atex-field';
    nameField.innerHTML = '<label class="atex-field-label">Project name</label>';
    const nameInput = document.createElement('input');
    nameInput.className = 'atex-input';
    nameInput.value = firstRun ? 'My paper' : 'New project';
    nameField.appendChild(nameInput);
    wrap.appendChild(nameField);

    const templateLabel = document.createElement('div');
    templateLabel.className = 'atex-field-label';
    templateLabel.textContent = 'Start from';
    wrap.appendChild(templateLabel);
    const list = document.createElement('div');
    list.className = 'atex-picker-list';
    const templates = state.server?.templates || [];
    let selected = templates[0]?.id || 'article';
    for (const template of templates) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `atex-picker-item ${template.id === selected ? 'is-chosen' : ''}`.trim();
      item.innerHTML = `<span class="atex-picker-kind">${icon('file', 13)}</span><span class="atex-picker-main"><strong>${template.name}</strong><small>${template.description}</small></span>`;
      item.addEventListener('click', () => {
        selected = template.id;
        for (const other of list.querySelectorAll('.atex-picker-item')) other.classList.remove('is-chosen');
        item.classList.add('is-chosen');
      });
      list.appendChild(item);
    }
    wrap.appendChild(list);

    let instance = null;
    instance = modal({
      title: firstRun ? 'Create your first project' : 'New project',
      content: wrap,
      wide: true,
      actions: [
        ...(firstRun ? [] : [{ label: 'Cancel', onClick: () => instance.close() }]),
        {
          label: 'Create',
          kind: 'primary',
          onClick: async () => {
            const name = nameInput.value.trim() || 'Untitled';
            instance.close();
            try {
              const project = await api.createProject(name, selected);
              state.projects = (await api.listProjects()).projects;
              await openProject(project.id);
              toast('Project created', { kind: 'success' });
              resolve(project);
            } catch (err) {
              toast(err.message, { kind: 'error' });
              resolve(null);
            }
          },
        },
      ],
      onMount: () => setTimeout(() => nameInput.select(), 40),
      onClose: () => resolve(null),
    });
  });
}

function importProject() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const response = await fetch(
        `/api/projects/import?name=${encodeURIComponent(file.name.replace(/\.zip$/i, ''))}`,
        { method: 'POST', body: await file.arrayBuffer() }
      );
      if (!response.ok) throw new Error((await response.json()).error || 'import failed');
      const project = await response.json();
      state.projects = (await api.listProjects()).projects;
      await openProject(project.id);
      toast(`Imported ${project.files?.length || 0} files`, { kind: 'success' });
    } catch (err) {
      toast(`Import failed: ${err.message}`, { kind: 'error' });
    }
  });
  input.click();
}

// ---------------------------------------------------------------------------
// Fatal
// ---------------------------------------------------------------------------

function showFatal(message) {
  document.body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid;place-items:center;height:100vh;padding:32px;text-align:center;';
  wrap.innerHTML = `<div style="max-width:520px">
    <h1 style="font-size:20px;margin:0 0 10px">Cannot reach the editor server</h1>
    <p style="color:var(--text-muted);line-height:1.6">${message}</p>
    <p style="color:var(--text-muted);line-height:1.6">Start it with
      <code style="background:var(--bg-sunken);padding:2px 6px;border-radius:4px">python3 atex.py</code>
      and reload this page.</p>
  </div>`;
  document.body.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * A small handle for debugging and for the end-to-end test suite: the editors
 * and the document model are reachable from the console.
 */
function exposeDebugHandles() {
  globalThis.__atex = {
    get visual() {
      return visual;
    },
    get source() {
      return source;
    },
    get pdf() {
      return pdf;
    },
    get doc() {
      return state.doc;
    },
    get state() {
      return state;
    },
    get build() {
      return state.build;
    },
    compile,
    openProject,
    saveActiveFile,
    setView,
    selectPanel,
    /** Rebuild the editors from the current document (used by tests). */
    rebuild: () => buildEditors(),
    /** Inspect the block tree without rendering it. */
    debugBuildBlocks: () => buildBlocks(state.doc.root.children),
  };
}

document.addEventListener('DOMContentLoaded', () => {
  exposeDebugHandles();
  boot().catch((err) => {
    console.error(err);
    (globalThis.__atexErrors || (globalThis.__atexErrors = [])).push(String((err && err.stack) || err));
    toast(`Startup failed: ${err.message}`, { kind: 'error', timeout: 12000 });
    // A failed start must not leave a blank screen: show the reason.
    const mount = document.getElementById('atex-visual');
    if (mount && !mount.textContent.trim()) {
      const box = document.createElement('div');
      box.style.cssText = 'padding:24px;font-family:var(--font-ui);font-size:13px;line-height:1.6';
      box.innerHTML = '<strong>Could not open the project</strong>';
      const pre = document.createElement('pre');
      pre.style.cssText = 'white-space:pre-wrap;color:var(--danger);font-size:12px';
      pre.textContent = String((err && err.stack) || err);
      box.appendChild(pre);
      mount.appendChild(box);
    }
  });
});

export { state, api, escapeLatexText, latexToUnicode, shortAuthor };
