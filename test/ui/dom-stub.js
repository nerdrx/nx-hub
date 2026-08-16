// A deliberately tiny DOM stand-in — just enough of the surface app.js touches
// so the controller can boot under `node --test` and be driven by fake clicks.
//
// It is NOT a browser: innerHTML is stored as a string (never parsed), so the
// smoke test asserts on the markup the renderers produced, not on a live tree.

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(...c) {
    for (const x of c) if (x) this.set.add(x);
  }
  remove(...c) {
    for (const x of c) this.set.delete(x);
  }
  toggle(c, on) {
    if (on === undefined) on = !this.set.has(c);
    if (on) this.set.add(c);
    else this.set.delete(c);
    return on;
  }
  contains(c) {
    return this.set.has(c);
  }
  get value() {
    return [...this.set].join(' ');
  }
}

/** Supports the selector shapes app.js actually uses. */
function matches(el, selector) {
  const sel = String(selector).trim();
  if (sel.startsWith('[')) {
    const m = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (!m) return false;
    const v = el.getAttribute(m[1]);
    return m[2] === undefined ? v !== null : v === m[2];
  }
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

export class StubElement {
  constructor(tagName = 'DIV', doc = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = doc;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList();
    this.style = {};
    this.listeners = new Map();
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.files = null;
    this._html = '';
    this.textContent = '';
    this.clicked = 0;
  }

  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get className() {
    return this.classList.value;
  }
  set className(v) {
    this.classList = new ClassList();
    for (const c of String(v).split(/\s+/)) this.classList.add(c);
  }
  get type() {
    return this.getAttribute('type') || '';
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v === null || v === undefined ? '' : v);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    if (this.ownerDocument) this.ownerDocument._register(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  replaceChild(next, prev) {
    this.children = this.children.map((c) => (c === prev ? next : c));
    return prev;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(fn);
  }
  dispatch(type, ev) {
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  click() {
    this.clicked += 1;
    if (this.ownerDocument) this.ownerDocument.click(this);
  }
  focus() {}
  select() {}
  blur() {}
  scrollIntoView() {}
  getContext() {
    // Canvas calls used by the starfield — all no-ops.
    return {
      setTransform() {},
      clearRect() {},
      beginPath() {},
      arc() {},
      fill() {},
      set fillStyle(_v) {},
      get fillStyle() {
        return '';
      },
    };
  }
}

class StubDocument {
  constructor() {
    this.byId = new Map();
    this.listeners = new Map();
    this.readyState = 'complete';
    this.hidden = false;
    this.documentElement = new StubElement('html', this);
    this.body = new StubElement('body', this);
    this.body.ownerDocument = this;
  }
  _register(el) {
    if (el.id) this.byId.set(el.id, el);
    for (const c of el.children) this._register(c);
  }
  createElement(tag) {
    return new StubElement(tag, this);
  }
  getElementById(id) {
    return this.byId.get(id) || null;
  }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
    return this.body.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.body.querySelectorAll(sel);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    if (this.listeners.has(type)) this.listeners.get(type).delete(fn);
  }
  dispatch(type, ev) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(ev);
  }
  /** Fire a click that bubbles the way app.js expects (target.closest). */
  click(target) {
    this.dispatch('click', { target, preventDefault() {} });
  }
  key(key, target) {
    this.dispatch('keydown', { key, target: target || this.body, preventDefault() {} });
  }
  input(target) {
    this.dispatch('input', { target });
  }
}

const IDS = [
  'header',
  'logo',
  'tabs',
  'filter',
  'filter-icon',
  'device-chip',
  'fleet-chip',
  'refresh',
  'settings-btn',
  'stacks-btn',
  'main',
  'banner',
  'launch',
  'manage-view',
  'grid',
  'unpublished',
  'hidden-apps',
  'footer',
  'panel-root',
  'sheet-root',
  'toasts',
  'import-file',
  'boot-warning',
  'stars',
  'stars-near',
];

/**
 * Build the element graph of index.html (ids + the two tab buttons) and install
 * the globals app.js reads. Returns handles for the test to drive.
 */
export function installDom() {
  const doc = new StubDocument();
  for (const id of IDS) {
    const el = doc.createElement(id === 'stars' || id === 'stars-near' ? 'canvas' : 'div');
    el.id = id;
    doc.body.appendChild(el);
  }
  const tabs = doc.getElementById('tabs');
  for (const view of ['launch', 'manage']) {
    const tab = doc.createElement('button');
    tab.id = `tab-${view}`;
    tab.setAttribute('data-act', 'view');
    tab.setAttribute('data-view', view);
    tabs.appendChild(tab);
  }

  const store = new Map();
  const win = {
    document: doc,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (t) => globalThis.clearTimeout(t),
    // The pairing countdown ticks on an interval; unref'd so a forgotten timer
    // can never be what keeps `node --test` alive.
    setInterval: (fn, ms) => {
      const t = globalThis.setInterval(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearInterval: (t) => globalThis.clearInterval(t),
    requestAnimationFrame: (fn) => globalThis.setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (t) => globalThis.clearTimeout(t),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    confirm: () => win.__confirm,
    __confirm: true,
    location: { search: '' },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    Blob: class {
      constructor(parts) {
        this.parts = parts;
      }
    },
  };

  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    Element: globalThis.Element,
    localStorage: globalThis.localStorage,
  };
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.Element = StubElement;
  if (!globalThis.navigator || !globalThis.navigator.clipboard) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { platform: 'Linux x86_64', userAgent: 'stub', clipboard: { writeText: async () => {} } },
      configurable: true,
      writable: true,
    });
  }

  return {
    doc,
    win,
    store,
    html: (id) => (doc.getElementById(id) || { innerHTML: '' }).innerHTML,
    restore() {
      globalThis.window = prev.window;
      globalThis.document = prev.document;
      globalThis.Element = prev.Element;
      if (prev.navigator) {
        Object.defineProperty(globalThis, 'navigator', { value: prev.navigator, configurable: true, writable: true });
      }
    },
  };
}

/** Fake a click on a `data-act` control the renderers just emitted. */
export function fakeControl(doc, attrs) {
  const el = doc.createElement('button');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  doc.body.appendChild(el);
  return el;
}

/** Let queued microtasks/timers run. */
export function tick(ms = 12) {
  return new Promise((r) => globalThis.setTimeout(r, ms));
}
