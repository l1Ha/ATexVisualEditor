/**
 * Dropdown menus anchored to a button — used for the compile menu, project
 * switcher, and context menus.  One implementation so they all behave the same
 * way (escape to close, click-outside, keyboard navigation).
 */

let openMenu = null;

/**
 * @param {Element} anchor
 * @param {Array<{label?:string, icon?:string, hint?:string, onClick?:Function, kind?:string,
 *                checked?:boolean, disabled?:boolean, separator?:boolean, heading?:string}>} items
 * @param {{align?: 'left'|'right', width?: number}} opts
 */
export function openMenuFor(anchor, items, { align = 'left', width = null } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'atex-menu';
  menu.setAttribute('role', 'menu');
  if (width) menu.style.minWidth = `${width}px`;

  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'atex-menu-sep';
      menu.appendChild(separator);
      continue;
    }
    if (item.heading) {
      const heading = document.createElement('div');
      heading.className = 'atex-menu-label';
      heading.textContent = item.heading;
      menu.appendChild(heading);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `atex-menu-item ${item.kind === 'danger' ? 'is-danger' : ''} ${
      item.checked ? 'is-checked' : ''
    }`.trim();
    button.disabled = !!item.disabled;
    if (item.icon) {
      const span = document.createElement('span');
      span.className = 'atex-menu-icon';
      span.innerHTML = item.icon;
      button.appendChild(span);
    } else if (item.checked) {
      // keep the text aligned
      const spacer = document.createElement('span');
      spacer.style.width = '0';
      button.appendChild(spacer);
    }
    const label = document.createElement('span');
    label.textContent = item.label || '';
    button.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'atex-menu-hint';
      hint.textContent = item.hint;
      button.appendChild(hint);
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      item.onClick?.(event);
    });
    menu.appendChild(button);
    buttons.push(button);
  }

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  let left = align === 'right' ? box.right - rect.width : box.left;
  left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
  let top = box.bottom + 6;
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, box.top - rect.height - 6);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;

  const onPointerDown = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    closeMenu();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeMenu();
      anchor.focus?.();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
      const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
      target?.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    buttons[0]?.focus();
  }, 0);

  openMenu = {
    close: () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      menu.remove();
      if (openMenu && openMenu.element === menu) openMenu = null;
    },
    element: menu,
  };
  return openMenu;
}

export function closeMenu() {
  if (openMenu) openMenu.close();
}

export function isMenuOpen() {
  return !!openMenu;
}
