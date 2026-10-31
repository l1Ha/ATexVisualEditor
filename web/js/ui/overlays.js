/**
 * Small UI primitives: toasts, popovers, modals, context menus.
 *
 * Plain DOM, no framework — they are used often enough that a shared
 * implementation is worth it, and small enough to stay predictable.
 */

import { icon } from './icons.js';

const ROOT_ID = 'atex-overlays';

function overlayRoot() {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

/**
 * @param {string} message
 * @param {{kind?: 'info'|'success'|'warning'|'error', timeout?: number, action?: {label:string, onClick:Function}}} opts
 */
export function toast(message, { kind = 'info', timeout = 3200, action = null } = {}) {
  const root = document.getElementById('atex-toasts') || (() => {
    const el = document.createElement('div');
    el.id = 'atex-toasts';
    document.body.appendChild(el);
    return el;
  })();

  const node = document.createElement('div');
  node.className = `atex-toast atex-toast-${kind}`;
  const iconName = kind === 'success' ? 'check' : kind === 'error' ? 'warning' : kind === 'warning' ? 'warning' : 'info';
  node.innerHTML = `${icon(iconName, 15)}<span class="atex-toast-message"></span>`;
  node.querySelector('.atex-toast-message').textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'atex-toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    node.appendChild(button);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'atex-toast-close';
  close.innerHTML = icon('close', 13);
  close.addEventListener('click', () => dismiss());
  node.appendChild(close);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    node.classList.add('atex-toast-out');
    setTimeout(() => node.remove(), 200);
  };
  root.appendChild(node);
  if (timeout) setTimeout(dismiss, timeout);
  return { dismiss, node };
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

let openPopover = null;

/**
 * Open a floating panel anchored to an element (or a point).
 *
 * @param {object} opts
 * @param {Element|{x:number,y:number}} opts.anchor
 * @param {string} opts.title
 * @param {Element|string} opts.content
 * @param {Array<{label:string, kind?:string, onClick:Function}>} [opts.actions]
 * @param {boolean} [opts.wide]
 * @param {Function} [opts.onClose]
 * @param {Function} [opts.onMount] called with (panel)
 */
export function popover({
  anchor,
  title = '',
  content,
  actions = [],
  wide = false,
  onClose = null,
  onMount = null,
  className = '',
}) {
  closePopover();
  const root = overlayRoot();
  const panel = document.createElement('div');
  panel.className = `atex-popover ${wide ? 'atex-popover-wide' : ''} ${className}`.trim();
  panel.setAttribute('role', 'dialog');

  const header = document.createElement('div');
  header.className = 'atex-popover-header';
  header.innerHTML = `<span class="atex-popover-title"></span>`;
  header.querySelector('.atex-popover-title').textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'atex-icon-btn';
  closeBtn.innerHTML = icon('close', 14);
  closeBtn.addEventListener('click', () => closePopover());
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'atex-popover-body';
  if (typeof content === 'string') body.innerHTML = content;
  else if (content) body.appendChild(content);
  panel.appendChild(body);

  if (actions.length) {
    const footer = document.createElement('div');
    footer.className = 'atex-popover-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `atex-btn ${action.kind ? `atex-btn-${action.kind}` : ''}`.trim();
      button.textContent = action.label;
      button.addEventListener('click', () => action.onClick(panel));
      footer.appendChild(button);
    }
    panel.appendChild(footer);
  }

  root.appendChild(panel);
  position(panel, anchor);

  openPopover = { panel, onClose, anchor };
  const onPointerDown = (event) => {
    if (panel.contains(event.target)) return;
    if (anchor instanceof Element && anchor.contains(event.target)) return;
    closePopover();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePopover();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  const cleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKey, true);
    panel.remove();
    if (openPopover && openPopover.panel === panel) openPopover = null;
    if (onClose) onClose();
  };
  panel.__atexCleanup = cleanup;

  if (onMount) onMount(panel);
  return { panel, close: closePopover };
}

function position(panel, anchor) {
  const margin = 8;
  panel.style.visibility = 'hidden';
  panel.style.left = '0px';
  panel.style.top = '0px';
  const rect = panel.getBoundingClientRect();
  let x;
  let y;
  if (anchor instanceof Element) {
    const box = anchor.getBoundingClientRect();
    x = box.left;
    y = box.bottom + 6;
    if (y + rect.height > window.innerHeight - margin) {
      y = Math.max(margin, box.top - rect.height - 6);
    }
  } else {
    x = anchor.x;
    y = anchor.y + 6;
    if (y + rect.height > window.innerHeight - margin) y = Math.max(margin, anchor.y - rect.height - 6);
  }
  x = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
  y = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
  panel.style.left = `${Math.round(x)}px`;
  panel.style.top = `${Math.round(y)}px`;
  panel.style.visibility = '';
}

export function closePopover() {
  const current = openPopover;
  if (current && current.panel.__atexCleanup) current.panel.__atexCleanup();
  openPopover = null;
}

export function isPopoverOpen() {
  return !!openPopover;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/**
 * A centred modal dialog.
 * @param {object} opts {title, content, actions, wide, onMount, onClose}
 */
export function modal({ title = '', content = '', actions = [], wide = false, onMount = null, onClose = null, className = '' }) {
  const root = overlayRoot();
  const backdrop = document.createElement('div');
  backdrop.className = 'atex-modal-backdrop';

  const panel = document.createElement('div');
  panel.className = `atex-modal ${wide ? 'atex-modal-wide' : ''} ${className}`.trim();
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const header = document.createElement('div');
  header.className = 'atex-modal-header';
  header.innerHTML = '<span class="atex-modal-title"></span>';
  header.querySelector('.atex-modal-title').textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'atex-icon-btn';
  closeBtn.innerHTML = icon('close', 15);
  closeBtn.addEventListener('click', () => close());
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'atex-modal-body';
  if (typeof content === 'string') body.innerHTML = content;
  else if (content) body.appendChild(content);
  panel.appendChild(body);

  if (actions.length) {
    const footer = document.createElement('div');
    footer.className = 'atex-modal-footer';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `atex-btn ${action.kind ? `atex-btn-${action.kind}` : ''}`.trim();
      button.textContent = action.label;
      button.addEventListener('click', () => action.onClick(panel, close));
      footer.appendChild(button);
    }
    panel.appendChild(footer);
  }

  backdrop.appendChild(panel);
  root.appendChild(backdrop);

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) close();
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('atex-modal-out');
    setTimeout(() => backdrop.remove(), 160);
    if (onClose) onClose();
  }

  if (onMount) onMount(panel, close);
  return { panel, close };
}

/** A modal asking for a single line of text. Returns a promise. */
export function promptModal({ title, label, value = '', placeholder = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'atex-field';
    wrap.innerHTML = `<label class="atex-field-label"></label>`;
    wrap.querySelector('label').textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'atex-input';
    input.value = value;
    input.placeholder = placeholder;
    wrap.appendChild(input);

    let instance;
    const submit = () => {
      const result = input.value;
      instance.close();
      resolve(result);
    };
    instance = modal({
      title,
      content: wrap,
      actions: [
        { label: 'Cancel', onClick: () => { instance.close(); resolve(null); } },
        { label: confirmLabel, kind: 'primary', onClick: submit },
      ],
      onMount: (panel) => {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 30);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        });
      },
      onClose: () => resolve(null),
    });
  });
}

/** A modal asking for several fields. Returns a promise of an object or null. */
export function formModal({ title, fields, confirmLabel = 'Save', description = '' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'atex-form';
    if (description) {
      const note = document.createElement('p');
      note.className = 'atex-form-note';
      note.textContent = description;
      wrap.appendChild(note);
    }
    const inputs = new Map();
    for (const field of fields) {
      const row = document.createElement('div');
      row.className = 'atex-field';
      const label = document.createElement('label');
      label.className = 'atex-field-label';
      label.textContent = field.label;
      row.appendChild(label);
      let input;
      if (field.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = field.rows || 4;
      } else if (field.type === 'select') {
        input = document.createElement('select');
        for (const option of field.options || []) {
          const opt = document.createElement('option');
          opt.value = option.value;
          opt.textContent = option.label;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement('input');
        input.type = field.type || 'text';
      }
      input.className = 'atex-input';
      input.value = field.value ?? '';
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.monospace) input.classList.add('atex-input-mono');
      inputs.set(field.name, input);
      row.appendChild(input);
      if (field.hint) {
        const hint = document.createElement('div');
        hint.className = 'atex-field-hint';
        hint.textContent = field.hint;
        row.appendChild(hint);
      }
      wrap.appendChild(row);
    }

    let instance;
    const submit = () => {
      const result = {};
      for (const [name, input] of inputs) result[name] = input.value;
      instance.close();
      resolve(result);
    };
    instance = modal({
      title,
      content: wrap,
      wide: fields.length > 4,
      actions: [
        { label: 'Cancel', onClick: () => { instance.close(); resolve(null); } },
        { label: confirmLabel, kind: 'primary', onClick: submit },
      ],
      onMount: (panel) => {
        const first = inputs.values().next().value;
        setTimeout(() => {
          if (first) {
            first.focus();
            if (first.select) first.select();
          }
        }, 30);
        panel.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && !(event.target.tagName === 'TEXTAREA')) {
            event.preventDefault();
            submit();
          }
        });
      },
      onClose: () => resolve(null),
    });
  });
}
