/**
 * Inline SVG icons (stroke-based, 24×24 viewBox).
 *
 * Kept as a lookup table rather than a font or sprite sheet so the app has no
 * binary assets to load and icons inherit `currentColor` everywhere.
 */

const PATHS = {
  bold: '<path d="M7 5h6a4 4 0 0 1 0 8H7z"/><path d="M7 13h7a4 4 0 0 1 0 8H7z"/>',
  italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
  underline: '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  superscript: '<path d="M4 19l8-8"/><path d="M12 19l-8-8"/><path d="M20 12h-6l4-5h-4"/>',
  subscript: '<path d="M4 15l8-8"/><path d="M12 15l-8-8"/><path d="M20 20h-6l4-5h-4"/>',
  highlighter: '<path d="M9 11l-6 6v3h3l6-6"/><path d="M14 6l4 4"/><path d="M18 2l4 4-8 8-4-4z"/>',
  'align-left': '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>',
  'align-center': '<line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  'align-right': '<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>',
  'list-bullet': '<line x1="9" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><circle cx="4.5" cy="6" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="4.5" cy="18" r="1.5"/>',
  'list-number': '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 4h1v5"/><path d="M3 9h3"/><path d="M3.5 14h2v2h-2v2h2"/>',
  indent: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="11" y1="12" x2="21" y2="12"/><line x1="11" y1="18" x2="21" y2="18"/><path d="M3 10l4 2-4 2z"/>',
  outdent: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="11" y1="12" x2="21" y2="12"/><line x1="11" y1="18" x2="21" y2="18"/><path d="M7 10l-4 2 4 2z"/>',
  math: '<path d="M4 5h16"/><path d="M4 19h16"/><path d="M8 5l8 14"/>',
  'math-inline': '<path d="M3 12h4l2-5 3 10 2-5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1-1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="10" y1="3" x2="10" y2="21"/>',
  'row-plus': '<rect x="3" y="4" width="18" height="6" rx="1"/><line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="17" x2="15" y2="17"/>',
  'col-plus': '<rect x="4" y="3" width="6" height="18" rx="1"/><line x1="16" y1="12" x2="22" y2="12"/><line x1="19" y1="9" x2="19" y2="15"/>',
  footnote: '<path d="M4 4h3v16H4"/><path d="M13 9h4"/>',
  quote: '<path d="M7 6h4v4a4 4 0 0 1-4 4z"/><path d="M15 6h4v4a4 4 0 0 1-4 4z"/>',
  tag: '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8" r="1"/>',
  section: '<line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="11" x2="14" y2="11"/><line x1="3" y1="17" x2="17" y2="17"/>',
  heading: '<path d="M6 4v16"/><path d="M18 4v16"/><path d="M6 12h12"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-3-7"/>',
  play: '<polygon points="6 4 20 12 6 20"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 21h16"/>',
  upload: '<path d="M12 21V9"/><path d="M7 13l5-5 5 5"/><path d="M4 3h16"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  close: '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
  check: '<polyline points="4 12 9 17 20 6"/>',
  warning: '<path d="M12 3l9 16H3z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="16.5" r=".6"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="10" x2="12" y2="16"/><circle cx="12" cy="7.5" r=".6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M4 4l16 16"/><path d="M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7"/><path d="M6.3 7.3A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.2-.9"/>',
  source: '<polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/>',
  rule: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="8" x2="21" y2="8" stroke-dasharray="3 3"/>',
  macro: '<path d="M4 20l4-16"/><path d="M10 4h8"/><path d="M12 12h6"/>',
  chevron: '<polyline points="9 6 15 12 9 18"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'chevron-right': '<polyline points="9 6 15 12 9 18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  text: '<path d="M4 6h16"/><path d="M4 12h12"/><path d="M4 18h8"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9" cy="15" r="1.2"/><circle cx="15" cy="15" r="1.2"/>',
  wand: '<path d="M15 4l5 5"/><path d="M4 20l11-11"/><path d="M18 2l1 1"/><path d="M21 8l1 1"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4z"/><path d="M20 4h-7a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h7z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7 10 10 12 7 14"/><line x1="12" y1="14" x2="17" y2="14"/>',
  hash: '<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/><line x1="10" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="14" y2="20"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.5" y2="16.5"/><line x1="8" y1="11" x2="14" y2="11"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/>',
  palette2: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.7 1.8-1.7H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7z"/>',
  spell: '<path d="M4 19l5-14 5 14"/><line x1="6" y1="14" x2="12" y2="14"/><path d="M15 13l3 3 5-6"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/><path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9z"/><path d="M9 16v2"/>',
  format: '<path d="M4 20h16"/><path d="M7 16l5-12 5 12"/><path d="M9 11h6"/>',
  arrows: '<polyline points="17 3 21 7 17 11"/><line x1="21" y1="7" x2="7" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="17" y2="17"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3 11.2V16h6v-1.8A6 6 0 0 0 12 3z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3 2.4V13"/><circle cx="12" cy="16.3" r=".6"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/><rect x="8" y="13" width="8" height="8"/>',
  folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v1"/><path d="M3 10h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};

/**
 * @param {string} name icon key
 * @param {number} size pixel size
 * @param {number} [stroke] stroke width
 */
export function icon(name, size = 16, stroke = 1.7) {
  const body = PATHS[name] || PATHS.text;
  return (
    `<svg class="atex-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${body}</svg>`
  );
}

export const ICON_NAMES = Object.keys(PATHS);
