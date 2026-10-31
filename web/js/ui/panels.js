/**
 * Sidebar panels: file tree, document outline, build problems.
 * Each is a small renderer with a click callback — no state of its own.
 */

import { icon } from './icons.js';
import { openMenuFor } from './menus.js';

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the project file tree.
 *
 * @param {Element} mount
 * @param {object[]} files flat list of {path, name, type, size, latex, image}
 * @param {object} opts {activePath, mainFile, onOpen, onDelete, onRename, onNewFile, onNewFolder, onUpload}
 */
export function renderFileTree(mount, files, opts) {
  mount.replaceChildren();
  const tree = document.createElement('div');
  tree.className = 'atex-tree';

  // Build a nested structure.
  const root = { children: new Map() };
  for (const file of files) {
    if (file.path.startsWith('.')) continue;
    const parts = file.path.split('/');
    let node = root;
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          isDir: !isLeaf,
          children: new Map(),
          meta: isLeaf ? file : null,
        });
      }
      node = node.children.get(part);
    });
    node.isDir = false;
    node.meta = file;
  }

  const render = (node, container) => {
    const entries = Array.from(node.children.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (entry.isDir) {
        const dirRow = document.createElement('div');
        dirRow.className = 'atex-tree-row is-dir';
        dirRow.innerHTML = `${icon('chevron-down', 12)}${icon('folder', 13)}<span class="atex-tree-name"></span>`;
        dirRow.querySelector('.atex-tree-name').textContent = entry.name;
        container.appendChild(dirRow);
        const children = document.createElement('div');
        children.className = 'atex-tree-children';
        container.appendChild(children);
        let collapsed = false;
        dirRow.addEventListener('click', () => {
          collapsed = !collapsed;
          children.hidden = collapsed;
          dirRow.querySelector('.atex-icon').outerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down', 12);
        });
        attachContextMenu(dirRow, entry);
        render(entry, children);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'atex-tree-row';
      if (entry.path === opts.activePath) row.classList.add('is-active');
      if (entry.path === opts.mainFile) row.classList.add('is-main');
      const iconName = entry.meta?.latex
        ? 'file'
        : entry.meta?.image
        ? 'image'
        : entry.name.endsWith('.bib')
        ? 'book'
        : 'file';
      row.innerHTML = `${icon(iconName, 13)}<span class="atex-tree-name"></span>${icon('settings', 13)}`;
      row.querySelector('.atex-tree-name').textContent = entry.name;
      const size = document.createElement('span');
      size.className = 'atex-tree-size';
      size.textContent = entry.meta?.size && entry.name.endsWith('.tex') ? '' : formatSize(entry.meta?.size);
      const badge =
        entry.path === opts.mainFile
          ? Object.assign(document.createElement('span'), { className: 'atex-tree-badge', textContent: 'main' })
          : null;
      const gear = row.querySelectorAll('.atex-icon')[1];
      const actions = document.createElement('span');
      actions.className = 'atex-tree-actions';
      gear.replaceWith(actions);
      const menuButton = document.createElement('button');
      menuButton.type = 'button';
      menuButton.className = 'atex-icon-btn';
      menuButton.style.width = '18px';
      menuButton.style.height = '18px';
      menuButton.innerHTML = icon('chevron-down', 11);
      menuButton.addEventListener('click', (event) => {
        event.stopPropagation();
        fileMenu(menuButton, entry);
      });
      actions.appendChild(menuButton);
      row.insertBefore(badge || size, actions);
      row.addEventListener('click', () => opts.onOpen?.(entry.path));
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        fileMenu(row, entry);
      });
      container.appendChild(row);
    }
  };

  const fileMenu = (anchor, entry) => {
    openMenuFor(anchor, [
      !entry.isDir && { label: 'Open', icon: icon('source', 13), onClick: () => opts.onOpen?.(entry.path) },
      entry.meta?.base64 === false && { label: 'Download', icon: icon('download', 13), onClick: () => opts.onDownload?.(entry.path) },
      { separator: true },
      { label: 'Rename…', icon: icon('text', 13), onClick: () => opts.onRename?.(entry.path) },
      { label: 'Delete', icon: icon('trash', 13), kind: 'danger', onClick: () => opts.onDelete?.(entry.path) },
    ].filter(Boolean));
  };

  const attachContextMenu = (row, entry) => {
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMenuFor(row, [
        { label: 'New file here…', icon: icon('plus', 13), onClick: () => opts.onNewFile?.(entry.path) },
        { label: 'Upload here…', icon: icon('upload', 13), onClick: () => opts.onUpload?.(entry.path) },
      ]);
    });
  };

  if (!files.length) {
    tree.innerHTML = '<p class="atex-empty-note">This project has no files yet.</p>';
  } else {
    render(root, tree);
  }
  mount.appendChild(tree);
}

/**
 * Render the document outline (sections, with figures/tables/equations folded in
 * as leaves when asked).
 */
export function renderOutline(mount, doc, opts) {
  mount.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'atex-outline';
  const sections = doc.sectionList();
  if (!sections.length) {
    wrap.innerHTML = '<p class="atex-empty-note">No sections yet.<br>Insert one with the toolbar or <kbd>Ctrl</kbd>+<kbd>1</kbd>.</p>';
    mount.appendChild(wrap);
    return;
  }
  for (const entry of sections) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `atex-outline-item level-${Math.min(entry.level, 5)}`;
    button.style.paddingLeft = `${8 + entry.level * 12}px`;
    button.textContent = entry.title;
    button.title = `${entry.level === 0 ? 'part' : `level ${entry.level}`} · line ${
      doc.offsetToPosition(entry.node.start).line
    }`;
    button.addEventListener('click', () => opts.onSelect?.(entry.node));
    wrap.appendChild(button);
  }
  mount.appendChild(wrap);
}

/** Render build diagnostics (errors first, then warnings, then bad boxes). */
export function renderDiagnostics(mount, result, opts) {
  mount.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'atex-diagnostics';

  if (!result) {
    wrap.innerHTML = '<p class="atex-empty-note">No build yet.<br>Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to compile.</p>';
    mount.appendChild(wrap);
    return;
  }
  const diagnostics = result.diagnostics || [];
  if (!diagnostics.length) {
    const ok = document.createElement('p');
    ok.className = 'atex-empty-note';
    ok.innerHTML = `No problems. Compiled in ${result.durationMs} ms with ${result.engine}.`;
    wrap.appendChild(ok);
    mount.appendChild(wrap);
    return;
  }

  const badboxes = diagnostics.filter((item) => item.kind === 'badbox');
  const shown = diagnostics.filter((item) => item.kind !== 'badbox');
  for (const item of shown) {
    wrap.appendChild(diagnosticRow(item, opts));
  }
  if (badboxes.length) {
    const heading = document.createElement('div');
    heading.className = 'atex-menu-label';
    heading.textContent = `${badboxes.length} over/underfull box${badboxes.length === 1 ? '' : 'es'}`;
    wrap.appendChild(heading);
    for (const item of badboxes.slice(0, 30)) wrap.appendChild(diagnosticRow(item, opts));
  }
  mount.appendChild(wrap);
}

function diagnosticRow(item, opts) {
  const row = document.createElement('div');
  row.className = `atex-diagnostic atex-diagnostic-${item.severity}`;
  const iconName = item.severity === 'error' ? 'warning' : item.severity === 'warning' ? 'warning' : 'info';
  row.innerHTML = `<span class="atex-diagnostic-icon">${icon(iconName, 14)}</span>
    <span class="atex-diagnostic-message"><span class="atex-diagnostic-text"></span>
    <span class="atex-diagnostic-where"></span></span>`;
  row.querySelector('.atex-diagnostic-text').textContent = item.message;
  const where = [item.file, item.line ? `line ${item.line}` : ''].filter(Boolean).join(' · ');
  row.querySelector('.atex-diagnostic-where').textContent = where;
  if (item.context) {
    const context = document.createElement('div');
    context.className = 'atex-diagnostic-context';
    context.textContent = item.context;
    row.querySelector('.atex-diagnostic-message').appendChild(context);
  }
  row.addEventListener('click', () => opts.onSelect?.(item));
  return row;
}

/** The raw build log, with a filter box. */
export function renderLog(mount, result) {
  mount.replaceChildren();
  if (!result || !result.log) {
    mount.innerHTML = '<p class="atex-empty-note">The build log will appear here.</p>';
    return;
  }
  const pre = document.createElement('pre');
  pre.className = 'atex-log-view';
  pre.textContent = result.log;
  mount.appendChild(pre);
}

/** The bibliography panel: entries with "cited" markers. */
export function renderBibPanel(mount, entries, opts) {
  mount.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'atex-diagnostics';
  if (!entries.length) {
    wrap.innerHTML = '<p class="atex-empty-note">No .bib entries found.<br>Add a bibliography file to manage citations.</p>';
    mount.appendChild(wrap);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'atex-diagnostic';
    row.innerHTML = `<span class="atex-diagnostic-icon">${icon(entry.type === 'article' ? 'file' : 'book', 14)}</span>
      <span class="atex-diagnostic-message"><span class="atex-diagnostic-text"></span><span class="atex-diagnostic-where"></span></span>`;
    row.querySelector('.atex-diagnostic-text').textContent = opts.format(entry);
    row.querySelector('.atex-diagnostic-where').textContent = `${entry.key} · ${entry.file}${entry.line ? `:${entry.line}` : ''}`;
    if (opts.isCited?.(entry.key)) {
      const badge = document.createElement('span');
      badge.className = 'atex-tree-badge';
      badge.style.background = 'var(--success-soft)';
      badge.style.color = 'var(--success)';
      badge.textContent = 'cited';
      row.querySelector('.atex-diagnostic-message').appendChild(badge);
    }
    row.addEventListener('click', () => opts.onSelect?.(entry));
    wrap.appendChild(row);
  }
  mount.appendChild(wrap);
}
