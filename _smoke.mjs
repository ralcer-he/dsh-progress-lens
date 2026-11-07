// Smoke test for the client half: run apply() against a fake Cordis ctx and a
// fake React, then assert the sidebar tab and the header trigger registered.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { loaded = def; },
  },
};

// Minimal DOM / network surface the apply path touches.
const appended = [];
globalThis.document = {
  head: { appendChild: (el) => { appended.push(el); } },
  createElement: (tag) => ({
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    setAttribute(k, v) { (this.attrs ??= {})[k] = v; },
    textContent: '',
    remove() { this.removed = true; },
  }),
  querySelector: () => null,
  body: { appendChild: () => {} },
};
globalThis.EventSource = class { constructor(url) { this.url = url; } close() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
globalThis.setInterval = (fn) => { return { unref() {} }; };
globalThis.clearInterval = () => {};

const React = {
  createElement: (type, props, ...kids) => ({ type, props, kids }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
};

// --- fake Cordis context ---------------------------------------------------
const disposers = [];
const effectLabels = [];
const registrations = { tabs: [], slots: [], locale: [], injects: [] };

const makeCtx = (services) => ({
  effect(fn, label) {
    effectLabels.push(label);
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return d;
  },
  inject(deps, cb) {
    registrations.injects.push(deps.join(','));
    // Simulate the service already being available.
    if (deps.every((d) => services[d] !== undefined)) cb(makeCtx(services));
    return () => {};
  },
  get(name) { return services[name]; },
  locale: {
    register(ns, dicts) { registrations.locale.push(ns); return () => {}; },
    bind() { return (key) => key; },
    getLocale() { return { id: 'zh-CN' }; },
  },
  slots: {
    inject(key, cb) { cb(); return () => {}; },
    register(def, component) {
      registrations.slots.push({ key: def.name, id: def.id, order: def.order, component });
      return () => {};
    },
  },
});

const sidebarTabDefs = [];
const opened = [];
const services = {
  betterSidebar: {
    registerTab(def) {
      // Mirror the real contract: a duplicate id throws, and the caller is
      // expected to treat that as "already registered".
      if (sidebarTabDefs.some((d) => d.id === def.id)) {
        throw new Error(`[dsh-better-sidebar] tab type "${def.id}" already registered`);
      }
      sidebarTabDefs.push(def);
      return () => {};
    },
    openTab(seed, scope) { opened.push({ seed, scope }); },
  },
  layout: {
    openRightbar(track, fullscreen) { opened.push({ rightbar: true, track, fullscreen }); },
    closeRightbar() {},
  },
};

// --- run ------------------------------------------------------------------
new Function('window', source)(globalThis.window);

if (!loaded) throw new Error('client.js never called window.__ModuleLoader__.load');
if (loaded.id !== 'dsh-progress-lens') throw new Error(`module id is ${loaded.id}`);

const mod = loaded.factory(requireStub);
const report = {};
report.moduleId = loaded.id;
report.inject = mod.inject;
report.hasApply = typeof mod.apply === 'function';

mod.apply(makeCtx(services));

report.effectLabels = effectLabels;
report.injects = registrations.injects;
report.localeNamespaces = registrations.locale;
report.tabCount = sidebarTabDefs.length;
report.tabs = sidebarTabDefs.map((d) => ({
  id: d.id,
  titleType: typeof d.title,
  title: typeof d.title === 'function' ? d.title() : d.title,
  iconIsFunction: typeof d.icon === 'function',
  iconNodeType: typeof d.icon === 'function' ? d.icon(14)?.type : null,
  order: d.order,
  single: d.single,
  componentIsFunction: typeof d.component === 'function',
}));
report.slotCount = registrations.slots.length;
report.slots = registrations.slots.map((s) => ({ key: s.key, id: s.id, order: s.order }));

// Render the tab body once to prove the component does not throw before data.
const tabComp = sidebarTabDefs[0]?.component;
if (tabComp) {
  try {
    const tree = tabComp({ scope: { sessionId: 'session-test-1', cwd: 'C:/x' }, ctx: makeCtx(services), store: {} });
    report.renderOk = true;
    report.renderRootClass = tree?.props?.className ?? null;
    report.renderChildren = Array.isArray(tree?.kids) ? tree.kids.length : (tree?.props?.children ? 1 : 0);
  } catch (error) {
    report.renderOk = false;
    report.renderError = String(error && error.message || error);
  }
}

// The header button must be clickable and wired to openTab + openRightbar.
const headerSlot = registrations.slots.find((s) => s.id === 'progress-lens-open');
if (headerSlot) {
  try {
    const tree = headerSlot.component({ sessionId: 'session-test-1' });
    report.headerType = tree?.type;
    tree?.props?.onClick?.();
    report.openedAfterClick = opened;
  } catch (error) {
    report.headerError = String(error && error.message || error);
  }
}

console.log(JSON.stringify(report, null, 2));
