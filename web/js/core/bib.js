/**
 * ATexVisualEditor — BibTeX / BibLaTeX parsing.
 *
 * Small and tolerant: the goal is autocomplete and a readable citation list,
 * not a full BibTeX implementation.  Entries that fail to parse are reported
 * rather than silently dropped, so a broken .bib file is visible.
 */

const ENTRY_TYPES = new Set([
  'article', 'book', 'booklet', 'conference', 'inbook', 'incollection',
  'inproceedings', 'manual', 'mastersthesis', 'misc', 'online', 'patent',
  'periodical', 'phdthesis', 'proceedings', 'report', 'standard', 'techreport',
  'thesis', 'unpublished', 'collection', 'dataset', 'software', 'suppbook',
  'suppcollection', 'suppperiodical', 'www', 'electronic',
]);

/**
 * Parse a .bib file.
 * @returns {{entries: object[], errors: Array<{line:number, message:string}>}}
 */
export function parseBib(source, { file = '' } = {}) {
  const entries = [];
  const errors = [];
  let i = 0;
  const n = source.length;

  const lineAt = (offset) => source.slice(0, offset).split('\n').length;

  while (i < n) {
    // Skip to the next '@'
    const at = source.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const typeMatch = /^([A-Za-z]+)\s*[{(]/.exec(source.slice(i, i + 64));
    if (!typeMatch) {
      continue;
    }
    const type = typeMatch[1].toLowerCase();
    i += typeMatch[0].length;
    if (!ENTRY_TYPES.has(type) && type !== 'string' && type !== 'preamble' && type !== 'comment') {
      // Unknown type: still try to read it, BibTeX-like.
    }
    if (type === 'comment') {
      continue;
    }

    // Key up to the first comma
    const comma = source.indexOf(',', i);
    const close = findClosingBrace(source, at + 1 + typeMatch[0].length - 1);
    if (comma < 0 || (close > 0 && comma > close)) {
      i = close > 0 ? close + 1 : n;
      continue;
    }
    const key = source.slice(i, comma).trim();
    i = comma + 1;

    const fields = {};
    let guard = 0;
    while (i < n && guard++ < 200) {
      // Skip whitespace and commas
      while (i < n && /[\s,]/.test(source[i])) i++;
      if (i >= n) break;
      if (source[i] === '}' || source[i] === ')') {
        i++;
        break;
      }
      const nameMatch = /^([A-Za-z][\w:-]*)\s*=\s*/.exec(source.slice(i, i + 80));
      if (!nameMatch) {
        // Not a field: skip a line and retry.
        const nextLine = source.indexOf('\n', i);
        if (nextLine < 0) break;
        i = nextLine + 1;
        continue;
      }
      const fieldName = nameMatch[1].toLowerCase();
      i += nameMatch[0].length;
      const value = readValue(source, i);
      if (!value) {
        errors.push({ line: lineAt(i), message: `could not read the value of "${fieldName}" in @${type}{${key}}`, file });
        const nextLine = source.indexOf('\n', i);
        if (nextLine < 0) break;
        i = nextLine + 1;
        continue;
      }
      fields[fieldName] = value.text;
      i = value.end;
    }

    if (!key) {
      errors.push({ line: lineAt(at), message: `@${type} entry without a key`, file });
      continue;
    }
    entries.push({
      type,
      key,
      fields,
      file,
      line: lineAt(at),
      author: fields.author || fields.editor || '',
      title: fields.title || '',
      year: fields.year || (fields.date || '').slice(0, 4) || '',
    });
  }
  return { entries, errors };
}

/** Read a brace/quoted/bare field value, resolving `#` concatenation. */
function readValue(source, start) {
  let i = start;
  const parts = [];
  for (let round = 0; round < 30; round++) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) return null;
    const c = source[i];
    if (c === '{') {
      const end = findClosingBrace(source, i);
      if (end < 0) return null;
      parts.push(source.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      let depth = 0;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '{') depth++;
        else if (source[j] === '}') depth--;
        else if (source[j] === '"' && depth === 0) break;
        j++;
      }
      parts.push(source.slice(i + 1, j));
      i = j + 1;
    } else {
      const match = /^[^,}\n]+/.exec(source.slice(i));
      if (!match) return null;
      parts.push(match[0].trim());
      i += match[0].length;
    }
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] === '#') {
      i++;
      continue;
    }
    break;
  }
  return { text: cleanValue(parts.join('')), end: i };
}

function findClosingBrace(source, openIndex) {
  const open = source[openIndex];
  if (open !== '{' && open !== '(') return -1;
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Strip outer braces, collapse whitespace and LaTeX accents for display. */
export function cleanValue(value) {
  let text = String(value);
  for (let round = 0; round < 3; round++) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && findClosingBrace(trimmed, 0) === trimmed.length - 1) {
      text = trimmed.slice(1, -1);
    } else {
      break;
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

const ACCENTS = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È', I: 'Ì', O: 'Ò', U: 'Ù' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  'c': { c: 'ç', C: 'Ç' },
};

/** Best-effort LaTeX → unicode for display in the citation list. */
export function latexToUnicode(value) {
  let text = String(value);
  text = text.replace(/\\([`'^"~])\{?([A-Za-z])\}?/g, (match, accent, letter) => ACCENTS[accent]?.[letter] ?? letter);
  text = text.replace(/\\([vHu])?\{?([A-Za-z])\}?/g, '$2');
  const named = {
    '\\ss': 'ß', '\\ae': 'æ', '\\AE': 'Æ', '\\oe': 'œ', '\\OE': 'Œ', '\\o': 'ø', '\\O': 'Ø',
    '\\aa': 'å', '\\AA': 'Å', '\\l': 'ł', '\\L': 'Ł', '\\&': '&', '\\%': '%', '\\$': '$',
  };
  for (const [tex, char] of Object.entries(named)) {
    text = text.split(tex).join(char);
  }
  text = text.replace(/\\[a-zA-Z]+\s?/g, '').replace(/[{}]/g, '');
  text = text.replace(/---/g, '—').replace(/--/g, '–');
  return text.replace(/\s+/g, ' ').trim();
}

/** Format an author field as "Knuth and Others" for the picker. */
export function shortAuthor(authorField, { max = 2 } = {}) {
  const raw = latexToUnicode(authorField || '');
  if (!raw) return '';
  const authors = raw.split(/\s+and\s+/i).map((name) => name.trim()).filter(Boolean);
  const short = authors.map((name) => {
    if (name.includes(',')) return name.split(',')[0].trim();
    const parts = name.split(/\s+/);
    return parts[parts.length - 1];
  });
  if (short.length > max) return `${short.slice(0, max).join(', ')} et al.`;
  if (short.length === 1) return short[0];
  if (short.length === 2) return `${short[0]} & ${short[1]}`;
  return `${short.slice(0, -1).join(', ')} & ${short[short.length - 1]}`;
}

/** A human-readable one-line summary of an entry. */
export function formatEntry(entry) {
  const author = shortAuthor(entry.fields.author || entry.fields.editor);
  const title = latexToUnicode(entry.fields.title || '');
  const year = entry.fields.year || (entry.fields.date || '').slice(0, 4);
  const where = latexToUnicode(entry.fields.journal || entry.fields.booktitle || entry.fields.publisher || '');
  return [author, title ? `“${title}”` : '', where, year].filter(Boolean).join(' · ');
}

/** All `\cite`-like keys used in a document (for the "unused/unresolved" view). */
export function collectCitationKeys(astModule, root) {
  const keys = new Set();
  astModule.walkAllOf(root.children, (node) => {
    if (node.kind !== 'command') return;
    if (!/^(cite|Cite|nocite|citep|citet|citealp|parencite|textcite|footcite)/.test(node.name)) return;
    const arg = node.args[node.args.length - 1];
    if (!arg) return;
    const text = astModule.plainText(arg.children);
    for (const key of text.split(',')) {
      const trimmed = key.trim();
      if (trimmed) keys.add(trimmed);
    }
  });
  return keys;
}
