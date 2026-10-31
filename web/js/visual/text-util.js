/**
 * Shared text helpers for the visual view.
 *
 * The visual view treats whitespace the way LaTeX does: a single newline and a
 * run of spaces are one space, and a blank line is a paragraph break.  Both
 * sides of every comparison therefore run through `normalizeText`, so a
 * paragraph the user did not touch compares equal and is left byte-identical.
 */

/** Text as it should appear (and be compared) in the visual view. */
export function normalizeText(value) {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r]*\n[ \t\r\n]*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

/** The display form of a text node's value. */
export function displayText(node) {
  return normalizeText(node.value);
}

/** Plain text coming out of the DOM, ready to become an AST text node. */
export function textFromDom(value) {
  return normalizeText(String(value).replace(/\u200b/g, ''));
}

/**
 * Map a display offset (whitespace-collapsed) back to a raw offset.
 * Inverse of `normalizeText`, used to place edits precisely.
 */
export function rawOffsetForDisplay(value, displayOffset) {
  let display = 0;
  let i = 0;
  while (i < value.length) {
    if (display >= displayOffset) return i;
    if (/\s/.test(value[i])) {
      while (i < value.length && /\s/.test(value[i])) i++;
    } else {
      i++;
    }
    display++;
  }
  return value.length;
}

/**
 * Apply a visual-view edit to a raw LaTeX text value, keeping everything
 * outside the edit byte for byte.
 *
 * Without this, changing one word would rewrite its whole paragraph onto a
 * single line — semantically identical in LaTeX, but a huge, noisy diff for
 * anyone reading the source or reviewing a change.  The common prefix/suffix
 * are located in display space (where newlines are spaces) and mapped back to
 * raw offsets, so the original line breaks survive.
 *
 * @param {string} rawValue the CST text node's current literal LaTeX
 * @param {string} newText what the visual view now shows
 * @param {(text: string) => string} escape escapes newly typed text
 */
export function patchTextValue(rawValue, newText, escape = (text) => text) {
  const raw = String(rawValue ?? '');
  const next = normalizeText(newText);
  const current = normalizeText(raw);
  if (current === next) return raw;
  let prefix = 0;
  while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++;
  }
  const startRaw = rawOffsetForDisplay(raw, prefix);
  const endRaw = rawOffsetForDisplay(raw, current.length - suffix);
  const inserted = next.slice(prefix, next.length - suffix);
  return raw.slice(0, startRaw) + (inserted ? escape(inserted) : '') + raw.slice(Math.max(startRaw, endRaw));
}

/** Collapse a node list's text content for comparison. */
export function nodesDisplayText(nodes, displayOf) {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += displayOf(node);
  }
  return normalizeText(out);
}
