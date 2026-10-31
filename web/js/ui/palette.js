/**
 * Command palette (Ctrl/Cmd+K): fuzzy search over commands, sections, labels
 * and files.  Implemented as a modal so it can be opened from anywhere.
 */

import { modal } from './overlays.js';
import { openMenuFor, closeMenu } from './menus.js';

/**
 * A tiny score for fuzzy matching: prefix > substring > subsequence.
 * @returns {number} -1 when there is no match
 */
export function fuzzyScore(needle, haystack) {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 700 - h.length;
  const index = h.indexOf(n);
  if (index >= 0) return 400 - index - h.length * 0.01;
  // subsequence
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of n) {
    const at = h.indexOf(ch, i);
    if (at < 0) return -1;
    if (last >= 0) gaps += at - last - 1;
    last = at;
    i = at + 1;
  }
  return 120 - gaps;
}

/**
 * @param {object[]} items `{label, hint, group, icon, run}`
 * @param {{placeholder?: string, title?: string}} opts
 */
export async function openPalette(items, { placeholder = 'Type a command…', title = 'Commands' } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'atex-palette';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'atex-input atex-palette-input';
    input.placeholder = placeholder;
    input.spellcheck = false;
    wrap.appendChild(input);

    const list = document.createElement('div');
    list.className = 'atex-palette-list';
    wrap.appendChild(list);

    let filtered = items;
    let activeIndex = 0;

    const renderList = () => {
      list.replaceChildren();
      if (!filtered.length) {
        const note = document.createElement('p');
        note.className = 'atex-muted atex-picker-empty';
        note.textContent = 'No matching commands';
        list.appendChild(note);
        return;
      }
      let lastGroup = null;
      filtered.forEach((item, index) => {
        if (item.group && item.group !== lastGroup) {
          const heading = document.createElement('div');
          heading.className = 'atex-palette-section';
          heading.textContent = item.group;
          list.appendChild(heading);
          lastGroup = item.group;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `atex-palette-item ${index === activeIndex ? 'is-active' : ''}`.trim();
        if (item.icon) {
          const span = document.createElement('span');
          span.innerHTML = item.icon;
          button.appendChild(span);
        }
        const label = document.createElement('span');
        label.textContent = item.label;
        button.appendChild(label);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'atex-palette-hint';
          hint.textContent = item.hint;
          button.appendChild(hint);
        }
        button.addEventListener('mouseenter', () => {
          activeIndex = index;
          for (const other of list.querySelectorAll('.atex-palette-item')) other.classList.remove('is-active');
          button.classList.add('is-active');
        });
        button.addEventListener('click', () => choose(index));
        list.appendChild(button);
      });
    };

    const choose = (index) => {
      const item = filtered[index];
      if (!item) return;
      instance.close();
      resolve(item);
      setTimeout(() => item.run?.(), 0);
    };

    const filter = (query) => {
      if (!query.trim()) {
        filtered = items;
      } else {
        filtered = items
          .map((item) => ({ item, score: fuzzyScore(query.trim(), `${item.label} ${item.keywords || ''}`) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.item);
      }
      activeIndex = 0;
      renderList();
    };

    let instance = null;
    instance = modal({
      title,
      content: wrap,
      onMount: () => {
        setTimeout(() => input.focus(), 30);
      },
      onClose: () => resolve(null),
    });

    input.addEventListener('input', () => filter(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
        renderList();
        list.querySelector('.atex-palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        renderList();
        list.querySelector('.atex-palette-item.is-active')?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        choose(activeIndex);
      }
    });

    filter('');
  });
}

/** A compact "insert" menu used by toolbar dropdowns. */
export function openInsertMenu(anchor, items, options) {
  closeMenu();
  return openMenuFor(anchor, items, options);
}
