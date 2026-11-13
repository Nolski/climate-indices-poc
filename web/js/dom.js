// Small DOM helpers. Text always goes in through textContent, never through HTML strings,
// because station names, file names and server messages are untrusted input.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  return append(clear(el), children);
}

export const $ = (id) => document.getElementById(id);

// <svg class="icon"><use href="#i-name"></svg>; the symbols are defined once in index.html.
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

export function show(el, visible = true) {
  if (el) el.hidden = !visible;
}

// Offers a Blob to the person as a file download. Works with no connection.
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function saveText(text, filename, type = 'text/plain') {
  saveBlob(new Blob([text], { type: type + ';charset=utf-8' }), filename);
}

// A status line for one long-running action. It always ends in a message: success, a specific
// error, or a time-out explanation with a retry button. It never spins without an elapsed time.
export function createStatus(el, { t, fmt }) {
  let timer = 0;
  let started = 0;
  let base = '';
  let extra = '';
  let slowAfter = 0;
  let slowText = '';

  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
  }
  // The message changes rarely and is announced; the seconds tick in a separate element that is
  // hidden from assistive technology, so a screen reader is not interrupted every second.
  function paint() {
    const secs = Math.floor((Date.now() - started) / 1000);
    const msg = el.querySelector('.status-msg');
    const time = el.querySelector('.status-time');
    if (!msg || !time) return;
    let text = base;
    if (extra) text += ' ' + extra;
    else if (slowAfter && secs >= slowAfter) text += ' ' + slowText;
    if (msg.textContent !== text) msg.textContent = text;
    time.textContent = t('status.elapsed', { n: fmt.int(secs) });
  }
  function frame(kind, iconName, ...children) {
    el.className = 'status status-' + kind;
    el.hidden = false;
    replace(el, icon(iconName, kind === 'busy' ? 'spin' : ''), h('div', { class: 'status-body' }, children));
  }

  return {
    busy(message, opts = {}) {
      stop();
      started = Date.now();
      base = message;
      extra = '';
      slowAfter = opts.slowAfter || 0;
      slowText = opts.slowText || '';
      el.setAttribute('role', 'status');
      frame(
        'busy',
        'spinner',
        h('span', { class: 'status-msg' }),
        h('span', { class: 'status-time', 'aria-hidden': 'true' }),
        opts.onCancel ? h('button', { type: 'button', class: 'btn btn-small', onclick: opts.onCancel }, t('common.cancel')) : null,
      );
      paint();
      timer = setInterval(paint, 1000);
    },
    // Called from the API client's "retry" event.
    retrying(ev) {
      extra = t('status.retrying', { attempt: fmt.int(ev.attempt), of: fmt.int(ev.of), wait: fmt.int(Math.ceil(ev.delayMs / 1000)) });
      paint();
    },
    attempt() {
      extra = '';
      paint();
    },
    note(text) {
      base = text;
      paint();
    },
    ok(message) {
      stop();
      el.setAttribute('role', 'status');
      frame('ok', 'check', h('span', { class: 'status-msg', text: message }));
    },
    // details: list of strings. actions: [{ label, onClick, primary }]
    error(message, { details = [], actions = [], hint = '' } = {}) {
      stop();
      el.setAttribute('role', 'alert');
      frame(
        'error',
        'error',
        h('p', { class: 'status-msg', text: message }),
        details.length ? h('ul', { class: 'status-details' }, details.map((d) => h('li', { text: d }))) : null,
        hint ? h('p', { class: 'hint', text: hint }) : null,
        actions.length
          ? h(
              'div',
              { class: 'status-actions' },
              actions.map((a) =>
                h('button', { type: 'button', class: 'btn btn-small' + (a.primary ? ' btn-primary' : ''), onclick: a.onClick }, a.label),
              ),
            )
          : null,
      );
    },
    clear() {
      stop();
      clear(el);
      el.hidden = true;
    },
    get busyNow() {
      return Boolean(timer);
    },
  };
}
