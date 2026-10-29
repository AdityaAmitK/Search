// Search's developer tools.
//
// Search opens WebKit's own Web Inspector as it always has; this script runs
// inside the inspector's page (DevTools.swift puts it there) and draws a UI
// of its own over it. The inspector's connection to the page stays WebKit's:
// every message the page sends is read here on its way to the inspector, and
// commands go back through the inspector's own agents. WebKit's UI stays
// underneath, hidden, a click away for what this doesn't do (the debugger,
// timelines, audits).
(() => {
'use strict';
if (window.SearchDevTools) return;

/* ---------- Small helpers ---------- */

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) for (const key in props) {
        const value = props[key];
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
        else if (key === 'value' || key === 'checked' || key === 'disabled') el[key] = value;
        else el.setAttribute(key, value === true ? '' : value);
    }
    append(el, kids);
    return el;
}

function append(el, kids) {
    for (const kid of [kids].flat(Infinity)) {
        if (kid == null || kid === false) continue;
        el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
}

const store = {
    get(key, fallback) {
        try { const v = localStorage.getItem('sdt.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem('sdt.' + key, JSON.stringify(value)); } catch {}
    },
};

const copy = text => InspectorFrontendHost.copyText(String(text ?? ''));

function fmtBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtMs(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '—';
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function basename(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return url.slice(0, 48) + (url.length > 48 ? '…' : '');
    try {
        const u = new URL(url);
        const last = u.pathname.split('/').filter(Boolean).pop();
        let name = last || u.host || url;
        try { name = decodeURIComponent(name); } catch {}
        return name + u.search;
    } catch { return url; }
}

const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

const ICONS = {
    picker: '<path d="M2.5 9.5v-6a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3"/><path d="M8 8l6.5 2.5-3 1-1 3z"/>',
    close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    bottom: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 9.5h12"/>',
    right: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>',
    undocked: '<rect x="4.5" y="4.5" width="9" height="9" rx="1.5"/><path d="M2.5 11V3.5a1 1 0 0 1 1-1H11"/>',
    more: '<circle cx="3.5" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.5" cy="8" r=".6"/>',
    clear: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>',
    record: '<circle cx="8" cy="8" r="4" fill="currentColor"/>',
    reload: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5V5h-2.5"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    up: '<path d="M4 10l4-4 4 4"/>',
    down: '<path d="M4 6l4 4 4-4"/>',
};

function icon(name, title, onclick, extra = '') {
    const button = h('button', { class: 'icon ' + extra, title, onclick });
    button.innerHTML = `<svg viewBox="0 0 16 16">${ICONS[name]}</svg>`;
    return button;
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function throttle(fn, ms) {
    let timer = null;
    return () => { if (!timer) timer = setTimeout(() => { timer = null; fn(); }, ms); };
}

/* ---------- The connection ---------- */

const handlers = Object.create(null);
const on = (method, fn) => (handlers[method] ||= []).push(fn);

function deliver(raw) {
    let message;
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (!message) return;
    if (!message.method) {
        // A reply. One holding a whole document means every node id before it
        // is gone, whoever asked.
        const root = message.result?.root;
        if (root?.nodeType === 9) for (const fn of handlers['@document'] || []) fn(root);
        return;
    }
    if (message.method === 'Target.dispatchMessageFromTarget') return deliver(message.params.message);
    for (const fn of handlers[message.method] || []) {
        try { fn(message.params || {}); } catch (error) { console.error('Search DevTools', message.method, error); }
    }
}

function hook(name, fn, { after = false } = {}) {
    const original = InspectorFrontendAPI[name];
    if (typeof original !== 'function') return;
    InspectorFrontendAPI[name] = function (...args) {
        if (!after) fn(...args);
        const result = original.apply(this, args);
        if (after) fn(...args);
        return result;
    };
}

hook('dispatchMessageAsync', deliver);
hook('dispatchMessage', deliver);

const target = () => WI.pageTarget || WI.mainTarget;

async function cmd(method, params = {}) {
    const [domain, name] = method.split('.');
    const agent = target()?.[domain + 'Agent'];
    if (!agent || !agent[name]) throw new Error(`${method} isn't available here`);
    return agent[name].invoke(params);
}

const quiet = (method, params) => cmd(method, params).catch(() => null);

// A function run in the page, its arguments and result passed as JSON.
async function pageCall(fn, ...args) {
    const global = await cmd('Runtime.evaluate', { expression: 'globalThis', objectGroup: 'sdt', doNotPauseOnExceptionsAndMuteConsole: true });
    const result = await cmd('Runtime.callFunctionOn', {
        objectId: global.result.objectId,
        functionDeclaration: String(fn),
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: true,
        doNotPauseOnExceptionsAndMuteConsole: true,
    });
    if (result.wasThrown) throw new Error(result.result.description || 'The page threw');
    return result.result.value;
}

// A function run with a page node as `this`.
async function nodeCall(nodeId, fn, ...args) {
    const { object } = await cmd('DOM.resolveNode', { nodeId, objectGroup: 'sdt' });
    const result = await cmd('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: String(fn),
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        doNotPauseOnExceptionsAndMuteConsole: true,
    });
    return result.result.value;
}

const HIGHLIGHT = {
    showInfo: true,
    contentColor: { r: 111, g: 168, b: 220, a: 0.55 },
    paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
    borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
    marginColor: { r: 246, g: 178, b: 107, a: 0.55 },
};

/* ---------- Shared pieces of UI ---------- */

const root = h('div', { id: 'sdt' });
let openMenu = null;

function closeMenu() { openMenu?.remove(); openMenu = null; }

function menu(event, items) {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
    items = items.filter(Boolean).filter((item, i, all) => item !== '-' || (i > 0 && i < all.length - 1 && all[i - 1] !== '-'));
    const el = h('div', { class: 'menu' }, items.map(item => item === '-'
        ? h('div', { class: 'menu-sep' })
        : h('div', { class: 'menu-item', onmousedown: e => { e.preventDefault(); e.stopPropagation(); closeMenu(); item[1](); } }, item[0])));
    root.append(el);
    const box = el.getBoundingClientRect();
    el.style.left = Math.max(4, Math.min(event.clientX, innerWidth - box.width - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(event.clientY, innerHeight - box.height - 4)) + 'px';
    openMenu = el;
}

addEventListener('mousedown', event => { if (openMenu && !openMenu.contains(event.target)) closeMenu(); }, true);

// Two panes and the line between them. The side pane keeps its size and the
// other takes the rest; below 560 points wide they stack.
function split(main, side, key, size = 320, { first = false } = {}) {
    const handle = h('div', { class: 'handle' });
    main.classList.add('pane', 'grow');
    side.classList.add('pane', 'side');
    const box = h('div', { class: 'split' }, first ? [side, handle, main] : [main, handle, side]);
    const axis = () => box.classList.contains('narrow') ? 'y' : 'x';
    const apply = () => {
        const a = axis();
        side.style.width = a === 'x' ? store.get(key + '.x', size) + 'px' : '';
        side.style.height = a === 'y' ? store.get(key + '.y', 220) + 'px' : '';
    };
    new ResizeObserver(() => {
        const narrow = box.clientWidth > 0 && box.clientWidth < 560;
        if (narrow !== box.classList.contains('narrow')) { box.classList.toggle('narrow', narrow); apply(); }
    }).observe(box);
    apply();
    handle.addEventListener('mousedown', event => {
        event.preventDefault();
        const a = axis();
        const start = a === 'x' ? event.clientX : event.clientY;
        const startSize = a === 'x' ? side.offsetWidth : side.offsetHeight;
        const limit = (a === 'x' ? box.clientWidth : box.clientHeight) - 100;
        document.body.classList.add('sdt-dragging');
        document.body.style.cursor = a === 'x' ? 'col-resize' : 'row-resize';
        const move = e => {
            const delta = (a === 'x' ? e.clientX : e.clientY) - start;
            const next = Math.max(100, Math.min(limit, first ? startSize + delta : startSize - delta));
            side.style[a === 'x' ? 'width' : 'height'] = next + 'px';
        };
        const up = () => {
            removeEventListener('mousemove', move, true);
            removeEventListener('mouseup', up, true);
            document.body.classList.remove('sdt-dragging');
            document.body.style.cursor = '';
            store.set(key + '.' + a, parseInt(side.style[a === 'x' ? 'width' : 'height']));
        };
        addEventListener('mousemove', move, true);
        addEventListener('mouseup', up, true);
    });
    return box;
}

// Text edited in place: Enter or leaving keeps it, Escape puts it back.
function editText(span, initial, { commit, cancel, tab } = {}) {
    const before = span.textContent;
    span.textContent = initial;
    span.contentEditable = 'plaintext-only';
    span.spellcheck = false;
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    let done = false;
    const finish = (keep, how) => {
        if (done) return;
        done = true;
        span.removeAttribute('contenteditable');
        span.removeEventListener('keydown', keys);
        const text = span.textContent;
        if (keep && text !== initial) commit?.(text, how);
        else { span.textContent = before; if (keep && (how === 'next' || how === 'back')) commit?.(text, how); else cancel?.(); }
    };
    const keys = event => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true, 'enter'); }
        else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        else if (event.key === 'Tab' && tab) { event.preventDefault(); finish(true, event.shiftKey ? 'back' : 'next'); }
    };
    span.addEventListener('keydown', keys);
    span.addEventListener('blur', () => finish(true), { once: true });
}

function expandable(head, load, label) {
    const twisty = h('span', { class: 'tw' });
    const headRow = h('span', { class: 'tree-head' }, twisty, label ? [label, ': '] : '', head);
    const kids = h('div', { class: 'tree-kids' });
    const tree = h('span', { class: 'tree' }, headRow, kids);
    let loaded = false;
    tree.toggle = async () => {
        tree.classList.toggle('open');
        if (loaded) return;
        loaded = true;
        try { append(kids, await load()); } catch (error) { kids.append(h('div', { class: 'v-dim' }, String(error.message || error))); }
    };
    headRow.addEventListener('click', event => {
        if (event.target.closest('.v-node')) return;
        event.stopPropagation();
        tree.toggle();
    });
    return tree;
}

function section(title, body, { open = true, key } = {}) {
    const isOpen = key ? store.get('section.' + key, open) : open;
    const el = h('div', { class: 'section' + (isOpen ? ' open' : '') },
        h('div', { class: 'section-title', onclick: () => { el.classList.toggle('open'); if (key) store.set('section.' + key, el.classList.contains('open')); } },
            h('span', { class: 'tw' }), title),
        h('div', { class: 'section-body' }, body));
    return el;
}

function kv(pairs) {
    return h('div', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('div', { class: 'kv-key' }, k), h('div', { class: 'kv-value' }, v)]));
}

/* ---------- Values: what the page's objects look like here ---------- */

function scalar(type, subtype, value) {
    if (type === 'string') return h('span', { class: 'v-str' }, JSON.stringify(String(value)));
    if (type === 'number' || type === 'bigint') return h('span', { class: 'v-num' }, String(value));
    if (type === 'boolean') return h('span', { class: 'v-kw' }, String(value));
    if (type === 'undefined') return h('span', { class: 'v-dim' }, 'undefined');
    if (subtype === 'null') return h('span', { class: 'v-kw' }, 'null');
    if (type === 'function') return h('span', { class: 'v-fn' }, 'ƒ');
    if (subtype === 'node') return h('span', { class: 'v-node' }, String(value));
    if (subtype === 'regexp') return h('span', { class: 'v-str' }, String(value));
    return h('span', { class: 'v-dim' }, String(value ?? ''));
}

function previewDescription(p) {
    if (p.type === 'object' && p.subtype !== 'null' && p.subtype !== 'regexp' && p.subtype !== 'date' && p.subtype !== 'node')
        return h('span', { class: 'v-dim' }, p.subtype === 'array' ? `Array(${p.size ?? ''})` : (p.description || 'Object'));
    return scalar(p.type, p.subtype, p.description ?? p.value);
}

function previewProperty(q) {
    return q.valuePreview ? previewDescription(q.valuePreview) : scalar(q.type, q.subtype, q.value);
}

function summary(obj) {
    const p = obj.preview;
    const out = h('span');
    if (!p && obj.objectId && obj.type === 'object') {
        out.append(h('span', { class: 'v-dim' }, obj.className || obj.description || 'Object'));
        quiet('Runtime.getPreview', { objectId: obj.objectId }).then(result => {
            if (result?.preview) out.replaceWith(summary({ ...obj, preview: result.preview }));
        });
        return out;
    }
    const isArray = obj.subtype === 'array';
    const name = obj.className && obj.className !== 'Object' ? obj.className : '';
    if (isArray) out.append(h('span', { class: 'v-dim' }, `${obj.className || 'Array'}(${obj.size ?? p?.properties?.length ?? ''}) `));
    else if (name) out.append(h('span', { class: 'v-dim' }, name + ' '));
    if (!p) { if (!name && !isArray) out.append(h('span', { class: 'v-dim' }, obj.description || 'Object')); return out; }
    out.append(isArray ? '[' : '{');
    const items = p.entries
        ? p.entries.map(e => [e.key ? [previewDescription(e.key), ' => '] : '', previewDescription(e.value)])
        : (p.properties || []).map(q => isArray && /^\d+$/.test(q.name) ? [previewProperty(q)] : [h('span', { class: 'k dim' }, q.name), ': ', previewProperty(q)]);
    items.forEach((item, i) => { if (i) out.append(', '); append(out, item); });
    if (p.overflow) out.append(items.length ? ', …' : '…');
    out.append(isArray ? ']' : '}');
    return out;
}

function nodeValue(obj) {
    return h('span', {
        class: 'v-node',
        title: 'Click to reveal in Elements',
        onmouseenter: () => quiet('DOM.highlightNode', { objectId: obj.objectId, highlightConfig: HIGHLIGHT }),
        onmouseleave: () => quiet('DOM.hideHighlight'),
        onclick: async event => {
            event.stopPropagation();
            const result = await quiet('DOM.requestNode', { objectId: obj.objectId });
            if (result?.nodeId) { show('elements'); elements.reveal(result.nodeId); }
        },
    }, obj.preview?.description || obj.description || 'node');
}

function functionName(description = '') {
    const m = /^(?:async\s+)?(?:function\s*\*?\s*([\w$]*)|class\s+([\w$]+))/.exec(description);
    if (m) return (m[1] || m[2] || '') + (m[2] ? '' : '()');
    return description.split('\n')[0].slice(0, 60);
}

function renderValue(obj, { top = false, open = false, label = null } = {}) {
    if (!obj) return h('span', { class: 'v-dim' }, 'undefined');
    const { type, subtype } = obj;
    let leaf = null;
    if (type === 'string') leaf = top ? h('span', null, obj.value) : h('span', { class: 'v-str' }, JSON.stringify(obj.value));
    else if (type === 'number' || type === 'bigint') leaf = h('span', { class: 'v-num' }, obj.description ?? String(obj.value));
    else if (type === 'boolean') leaf = h('span', { class: 'v-kw' }, String(obj.value));
    else if (type === 'undefined') leaf = h('span', { class: 'v-dim' }, 'undefined');
    else if (type === 'symbol') leaf = h('span', { class: 'v-str' }, obj.description);
    else if (subtype === 'null') leaf = h('span', { class: 'v-kw' }, 'null');
    else if (subtype === 'node') leaf = nodeValue(obj);
    else if (subtype === 'regexp') leaf = h('span', { class: 'v-str' }, obj.description);
    else if (subtype === 'date') leaf = h('span', { class: 'v-num' }, obj.description);
    else if (!obj.objectId) leaf = summary(obj);
    if (leaf) return label ? h('span', null, label, ': ', leaf) : leaf;
    const head = type === 'function'
        ? h('span', { class: 'v-fn' }, h('span', { class: 'v-kw' }, 'ƒ '), functionName(obj.description))
        : subtype === 'error' ? h('span', { class: 'v-err' }, top ? obj.description : (obj.description || '').split('\n')[0]) : summary(obj);
    const tree = expandable(head, () => properties(obj), label);
    if (open) tree.toggle();
    return tree;
}

async function properties(obj) {
    const kids = [];
    if (['map', 'set', 'weakmap', 'weakset'].includes(obj.subtype)) {
        const result = await quiet('Runtime.getCollectionEntries', { objectId: obj.objectId, objectGroup: 'console', fetchStart: 0, fetchCount: 200 });
        (result?.entries || []).forEach((entry, i) => kids.push(h('div', { class: 'prop' },
            h('span', { class: 'tw none' }), h('span', { class: 'k' }, String(i)), ': ',
            entry.key ? [renderValue(entry.key), ' => '] : '', renderValue(entry.value))));
    }
    const { properties: props = [], internalProperties = [] } = await cmd('Runtime.getDisplayableProperties', { objectId: obj.objectId, generatePreview: true });
    for (const p of props) kids.push(propertyRow(p.name, p, !p.enumerable));
    for (const p of internalProperties) kids.push(propertyRow(`[[${p.name}]]`, p, true));
    return kids;
}

function propertyRow(name, p, dim) {
    const label = h('span', { class: dim ? 'k dim' : 'k' }, name);
    if (!p.value) return h('div', { class: 'prop' }, h('span', { class: 'tw none' }), label, ': ',
        p.get ? h('span', { class: 'v-dim', title: 'A getter, not run' }, '(…)') : h('span', { class: 'v-dim' }, 'undefined'));
    const value = renderValue(p.value, { label });
    return h('div', { class: 'prop' }, value.classList.contains('tree') ? value : [h('span', { class: 'tw none' }), value]);
}

function jsonScalar(value) {
    if (value === null) return h('span', { class: 'v-kw' }, 'null');
    if (typeof value === 'string') return h('span', { class: 'v-str' }, JSON.stringify(value));
    if (typeof value === 'number') return h('span', { class: 'v-num' }, String(value));
    return h('span', { class: 'v-kw' }, String(value));
}

function jsonTree(value, name = null, open = false) {
    const label = name != null ? h('span', { class: 'k' }, name) : null;
    if (value === null || typeof value !== 'object')
        return h('div', { class: 'prop' }, h('span', { class: 'tw none' }), label ? [label, ': '] : '', jsonScalar(value));
    const isArray = Array.isArray(value);
    const keys = Object.keys(value);
    const head = h('span', { class: 'v-dim' }, isArray ? `Array(${value.length})` : `{${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}}`);
    const tree = expandable(head, () => keys.map(k => jsonTree(value[k], k)), label);
    if (open) tree.toggle();
    return h('div', { class: 'prop' }, tree);
}

function parseJSON(text) {
    if (typeof text !== 'string') return undefined;
    const t = text.trim();
    if (!t || !'{["'.includes(t[0]) && !/^-?\d/.test(t) && t !== 'true' && t !== 'false' && t !== 'null') return undefined;
    try { return JSON.parse(t); } catch { return undefined; }
}

/* ---------- Elements ---------- */

const elements = (() => {
    const VOID = new Set('area base br col embed hr img input link meta source track wbr'.split(' '));
    const nodes = new Map();
    let rootId = null;
    let selected = null;
    let pending = null;
    let hovered = null;
    const rowsById = new Map();

    const tree = h('div', { class: 'dom', tabindex: '0' });
    const crumbs = h('div', { class: 'crumbs' });
    const findInput = h('input', { class: 'filter', placeholder: 'Find by text, selector or XPath', spellcheck: 'false' });
    const findCount = h('span', { class: 'find-count' });
    let search = null;
    const findBar = h('div', { class: 'bar sub' }, findInput, findCount,
        icon('up', 'Previous match (⇧↩)', () => find(-1)), icon('down', 'Next match (↩)', () => find(1)));

    const styles = stylesPane();
    const left = h('div', null, findBar, tree, crumbs);
    const el = h('div', { class: 'panel' }, split(left, styles.el, 'elements', 340));

    function ingest(payload, parent) {
        let n = nodes.get(payload.nodeId);
        if (!n) { n = { id: payload.nodeId, expanded: false }; nodes.set(n.id, n); }
        n.type = payload.nodeType;
        n.name = payload.nodeName;
        n.local = payload.localName;
        n.value = payload.nodeValue ?? '';
        n.count = payload.childNodeCount ?? payload.children?.length ?? 0;
        n.parent = parent;
        n.pseudo = payload.pseudoType;
        n.shadow = payload.shadowRootType;
        n.url = payload.documentURL;
        n.attrs = [];
        for (let i = 0; payload.attributes && i < payload.attributes.length; i += 2) n.attrs.push([payload.attributes[i], payload.attributes[i + 1]]);
        n.extra = [];
        for (const s of payload.shadowRoots || []) n.extra.push(ingest(s, n.id).id);
        if (payload.templateContent) n.extra.push(ingest(payload.templateContent, n.id).id);
        if (payload.contentDocument) n.extra.push(ingest(payload.contentDocument, n.id).id);
        n.before = n.after = null;
        for (const p of payload.pseudoElements || []) {
            const kid = ingest(p, n.id);
            if (p.pseudoType === 'after') n.after = kid.id; else n.before = kid.id;
        }
        if (payload.children) n.children = payload.children.map(c => ingest(c, n.id).id);
        return n;
    }

    function forget(id) {
        const n = nodes.get(id);
        if (!n) return;
        for (const kid of allKids(n)) forget(kid);
        nodes.delete(id);
    }

    const allKids = n => [n.before, ...n.extra, ...(n.children || []), n.after].filter(Boolean);
    const blank = n => n.type === 3 && !n.value.trim();
    const kidsOf = n => allKids(n).map(id => nodes.get(id)).filter(k => k && !blank(k));

    function hasKids(n) {
        if (n.extra.length || n.before || n.after) return true;
        return n.children ? kidsOf(n).length > 0 : n.count > 0;
    }

    function inlineText(n) {
        if (n.type !== 1 || !n.children || n.extra.length || n.before || n.after) return null;
        const kids = kidsOf(n);
        if (kids.length !== 1 || kids[0].type !== 3 || kids[0].value.length > 80) return null;
        return kids[0];
    }

    const tagName = n => n.local || n.name.toLowerCase();

    function closeTag(n) { return h('span', { class: 't-tag' }, '</', tagName(n), '>'); }

    function attrPair(name, value) {
        const shown = value.length > 120 ? value.slice(0, 120) + '…' : value;
        return h('span', { class: 't-attr-pair', 'data-attr': name }, ' ',
            h('span', { class: 't-attr' }, name),
            value !== '' ? ['=', h('span', { class: 't-val', title: value.length > 120 ? value : null }, `"${shown}"`)] : '');
    }

    function content(n) {
        if (n.pseudo) return h('span', { class: 't-pseudo' }, '::' + n.pseudo);
        switch (n.type) {
        case 1: {
            const parts = [h('span', { class: 't-tag' }, '<', h('span', { 'data-edit': 'name' }, tagName(n))),
                n.attrs.map(([name, value]) => attrPair(name, value)), h('span', { class: 't-tag' }, '>')];
            const text = inlineText(n);
            if (text) parts.push(h('span', { class: 't-text', 'data-edit': 'text', 'data-text': text.id }, text.value), closeTag(n));
            else if (hasKids(n) && !n.expanded) parts.push('…', closeTag(n));
            else if (!hasKids(n) && !VOID.has(tagName(n))) parts.push(closeTag(n));
            return parts;
        }
        case 3: return h('span', { class: 't-text', 'data-edit': 'text', 'data-text': n.id }, n.value.trim().replace(/\s+/g, ' '));
        case 4: return h('span', { class: 't-comment' }, `<![CDATA[${n.value}]]>`);
        case 8: return h('span', { class: 't-comment' }, `<!--${n.value}-->`);
        case 9: return [h('span', { class: 't-pseudo' }, '#document'), n.url ? h('span', { class: 't-comment' }, ' ' + n.url) : ''];
        case 10: return h('span', { class: 't-comment' }, `<!DOCTYPE ${n.name}>`);
        case 11: return h('span', { class: 't-pseudo' }, n.shadow ? `#shadow-root (${n.shadow})` : '#document-fragment');
        default: return h('span', null, n.name);
        }
    }

    function render() {
        const top = tree.scrollTop;
        rowsById.clear();
        const doc = nodes.get(rootId);
        if (!doc) { tree.replaceChildren(h('div', { class: 'empty' }, 'Loading the page…')); return; }
        const frag = document.createDocumentFragment();
        const walk = (n, depth) => {
            for (const kid of kidsOf(n)) {
                const open = kid.expanded && hasKids(kid) && !inlineText(kid);
                const row = h('div', { class: 'dom-row' + (open ? ' open' : '') + (kid.id === selected ? ' on' : ''), 'data-id': kid.id, style: `padding-left:${depth * 14 + 2}px` },
                    h('span', { class: 'tw' + (hasKids(kid) && !inlineText(kid) ? '' : ' none') }), content(kid),
                    kid.id === selected ? h('span', { class: 't-dollar' }, '== $0') : '');
                rowsById.set(kid.id, row);
                frag.append(row);
                if (open) {
                    walk(kid, depth + 1);
                    if (kid.type === 1 && !kid.pseudo) frag.append(h('div', { class: 'dom-row close', 'data-id': kid.id, style: `padding-left:${depth * 14 + 16}px` }, closeTag(kid)));
                }
            }
        };
        walk(doc, 0);
        tree.replaceChildren(frag);
        tree.scrollTop = top;
        renderCrumbs();
    }

    const schedule = throttle(render, 30);

    function renderCrumbs() {
        const path = [];
        for (let n = nodes.get(selected); n; n = nodes.get(n.parent)) if (n.type === 1) path.unshift(n);
        crumbs.replaceChildren(...path.map(n => {
            const id = n.attrs.find(a => a[0] === 'id')?.[1];
            const cls = n.attrs.find(a => a[0] === 'class')?.[1]?.trim().split(/\s+/).filter(Boolean).slice(0, 2);
            return h('span', { class: 'crumb' + (n.id === selected ? ' on' : ''), onclick: () => select(n.id, { scroll: true }) },
                tagName(n) + (id ? '#' + id : '') + (cls?.length ? '.' + cls.join('.') : ''));
        }));
        crumbs.scrollLeft = crumbs.scrollWidth;
    }

    function select(id, { scroll = false, center = false } = {}) {
        if (!nodes.has(id)) return;
        rowsById.get(selected)?.classList.remove('on');
        rowsById.get(selected)?.querySelector('.t-dollar')?.remove();
        selected = id;
        const row = rowsById.get(id);
        if (row) {
            row.classList.add('on');
            row.append(h('span', { class: 't-dollar' }, '== $0'));
            if (scroll) row.scrollIntoView({ block: center ? 'center' : 'nearest' });
        }
        renderCrumbs();
        quiet('DOM.setInspectedNode', { nodeId: id });
        styles.load(nodes.get(id));
    }

    async function toggle(id, open) {
        const n = nodes.get(id);
        if (!n) return;
        n.expanded = open ?? !n.expanded;
        if (n.expanded && !n.children && n.count > 0) await quiet('DOM.requestChildNodes', { nodeId: id, depth: 1 });
        render();
    }

    function reveal(id) {
        const n = nodes.get(id);
        if (!n) { pending = id; return; }
        for (let p = nodes.get(n.parent); p; p = nodes.get(p.parent)) p.expanded = true;
        render();
        select(id, { scroll: true, center: true });
        tree.focus();
    }

    let loading = false;
    let restoring = Promise.resolve();

    async function load(objectId) {
        loading = true;
        try {
            if (!await quiet('DOM.getDocument')) return;
            await restoring;
            const target = objectId ? (await quiet('DOM.requestNode', { objectId }))?.nodeId : null;
            if (target) reveal(target);
        } finally { loading = false; }
    }

    // Where a node sits, as child positions from the document down: the same
    // node keeps its path when the ids are handed out again.
    function pathOf(id) {
        const path = [];
        for (let n = nodes.get(id); n && n.parent != null; n = nodes.get(n.parent)) {
            const at = allKids(nodes.get(n.parent) || { extra: [] }).indexOf(n.id);
            if (at < 0) return null;
            path.unshift(at);
        }
        return path;
    }

    async function follow(path, open) {
        let n = nodes.get(rootId);
        for (const at of path) {
            if (!n) return null;
            if (!n.children && n.count) await quiet('DOM.requestChildNodes', { nodeId: n.id, depth: 1 });
            n = nodes.get(allKids(n)[at]);
            if (open && n) n.expanded = true;
        }
        return n;
    }

    function reseed(root) {
        const keep = rootId != null && nodes.has(rootId) ? {
            open: [...nodes.values()].filter(n => n.expanded).map(n => pathOf(n.id)).filter(Boolean).sort((a, b) => a.length - b.length),
            selected: selected != null ? pathOf(selected) : null,
        } : null;
        nodes.clear();
        rowsById.clear();
        selected = null;
        ingest(root, null);
        rootId = root.nodeId;
        restoring = restore(keep);
    }

    async function restore(keep) {
        if (keep) {
            for (const path of keep.open) {
                const n = await follow(path, false);
                if (n) { n.expanded = true; if (!n.children && n.count) await quiet('DOM.requestChildNodes', { nodeId: n.id, depth: 1 }); }
            }
            const n = keep.selected && await follow(keep.selected, false);
            render();
            if (n) select(n.id);
            return;
        }
        const html = kidsOf(nodes.get(rootId)).find(n => n.type === 1);
        let body = null;
        if (html) {
            html.expanded = true;
            if (!html.children) await quiet('DOM.requestChildNodes', { nodeId: html.id, depth: 2 });
            body = kidsOf(html).find(n => tagName(n) === 'body');
            if (body) {
                body.expanded = true;
                if (!body.children && body.count) await quiet('DOM.requestChildNodes', { nodeId: body.id, depth: 1 });
            }
        }
        if (pending && nodes.has(pending)) { const id = pending; pending = null; reveal(id); return; }
        render();
        if (body) select(body.id);
    }

    on('@document', reseed);

    const reload = debounce(() => load(), 200);

    on('DOM.documentUpdated', () => { nodes.clear(); rootId = null; render(); reload(); });
    on('DOM.setChildNodes', ({ parentId, nodes: kids }) => {
        const parent = nodes.get(parentId);
        if (!parent) return;
        for (const old of parent.children || []) if (!kids.some(k => k.nodeId === old)) forget(old);
        parent.children = kids.map(k => ingest(k, parentId).id);
        if (pending && nodes.has(pending)) { const id = pending; pending = null; reveal(id); }
        schedule();
    });
    on('DOM.childNodeInserted', ({ parentNodeId, previousNodeId, node }) => {
        const parent = nodes.get(parentNodeId);
        if (!parent) return;
        parent.count++;
        if (!parent.children) return schedule();
        const kid = ingest(node, parentNodeId);
        const at = previousNodeId ? parent.children.indexOf(previousNodeId) + 1 : 0;
        parent.children.splice(at, 0, kid.id);
        schedule();
    });
    on('DOM.childNodeRemoved', ({ parentNodeId, nodeId }) => {
        const parent = nodes.get(parentNodeId);
        if (parent) {
            parent.count = Math.max(0, parent.count - 1);
            if (parent.children) parent.children = parent.children.filter(id => id !== nodeId);
        }
        forget(nodeId);
        if (selected === nodeId) { selected = null; styles.load(null); }
        schedule();
    });
    on('DOM.childNodeCountUpdated', ({ nodeId, childNodeCount }) => {
        const n = nodes.get(nodeId);
        if (n) { n.count = childNodeCount; schedule(); }
    });
    on('DOM.attributeModified', ({ nodeId, name, value }) => {
        const n = nodes.get(nodeId);
        if (!n) return;
        const pair = n.attrs.find(a => a[0] === name);
        if (pair) pair[1] = value; else n.attrs.push([name, value]);
        schedule();
        if (nodeId === selected && (name === 'style' || name === 'class' || name === 'id')) styles.refresh();
    });
    on('DOM.attributeRemoved', ({ nodeId, name }) => {
        const n = nodes.get(nodeId);
        if (!n) return;
        n.attrs = n.attrs.filter(a => a[0] !== name);
        schedule();
    });
    on('DOM.characterDataModified', ({ nodeId, characterData }) => {
        const n = nodes.get(nodeId);
        if (n) { n.value = characterData; schedule(); }
    });
    on('DOM.inspect', ({ nodeId }) => { show('elements'); setPicking(false); reveal(nodeId); });
    on('Inspector.inspect', async ({ object }) => {
        if (object?.subtype !== 'node') return;
        const result = await quiet('DOM.requestNode', { objectId: object.objectId });
        if (result?.nodeId) { show('elements'); setPicking(false); reveal(result.nodeId); }
    });

    // Pointing, clicking, editing.

    const rowOf = event => event.target.closest('.dom-row');
    const idOf = row => row ? +row.dataset.id : null;

    tree.addEventListener('mousedown', event => {
        const row = rowOf(event);
        if (!row || event.button !== 0) return;
        const id = idOf(row);
        if (event.target.classList.contains('tw')) { event.preventDefault(); toggle(id); return; }
        select(id);
    });
    tree.addEventListener('dblclick', event => {
        const row = rowOf(event);
        if (!row || row.classList.contains('close')) return;
        const id = idOf(row);
        const n = nodes.get(id);
        const pair = event.target.closest('.t-attr-pair');
        const edit = event.target.closest('[data-edit]');
        if (pair) {
            const [name, value] = n.attrs.find(a => a[0] === pair.dataset.attr) || [pair.dataset.attr, ''];
            editText(pair, `${name}="${value}"`, { commit: text => text.trim()
                ? quiet('DOM.setAttributesAsText', { nodeId: id, text, name })
                : quiet('DOM.removeAttribute', { nodeId: id, name }) });
        } else if (edit?.dataset.edit === 'name') {
            editText(edit, tagName(n), { commit: async name => {
                const result = await quiet('DOM.setNodeName', { nodeId: id, name });
                if (result?.nodeId) setTimeout(() => reveal(result.nodeId), 50);
            } });
        } else if (edit?.dataset.edit === 'text') {
            const textId = +edit.dataset.text;
            editText(edit, nodes.get(textId)?.value ?? '', { commit: value => quiet('DOM.setNodeValue', { nodeId: textId, value }) });
        } else if (hasKids(n)) toggle(id);
    });
    tree.addEventListener('mousemove', event => {
        const id = idOf(rowOf(event));
        if (id === hovered) return;
        hovered = id;
        if (id && nodes.get(id)?.type === 1) quiet('DOM.highlightNode', { nodeId: id, highlightConfig: HIGHLIGHT });
        else quiet('DOM.hideHighlight');
    });
    tree.addEventListener('mouseleave', () => { hovered = null; quiet('DOM.hideHighlight'); });
    tree.addEventListener('contextmenu', event => {
        const row = rowOf(event);
        if (!row) return;
        const id = idOf(row);
        const n = nodes.get(id);
        select(id);
        const isElement = n.type === 1 && !n.pseudo;
        menu(event, [
            isElement && ['Edit as HTML', () => editHTML(id)],
            isElement && ['Add attribute', () => addAttribute(id)],
            '-',
            ['Copy element', async () => copy((await quiet('DOM.getOuterHTML', { nodeId: id }))?.outerHTML)],
            isElement && ['Copy selector', async () => copy(await nodeCall(id, selectorOf))],
            isElement && ['Copy JS path', async () => copy(`document.querySelector(${JSON.stringify(await nodeCall(id, selectorOf))})`)],
            isElement && ['Copy XPath', async () => copy(await nodeCall(id, xpathOf))],
            '-',
            isElement && ['Scroll into view', () => nodeCall(id, function () { this.scrollIntoView({ block: 'center', behavior: 'smooth' }); })],
            isElement && ['Focus', () => nodeCall(id, function () { this.focus(); })],
            hasKids(n) && ['Expand recursively', () => expandAll(id)],
            hasKids(n) && ['Collapse children', () => { collapse(id); render(); }],
            '-',
            ['Delete element', () => quiet('DOM.removeNode', { nodeId: id })],
        ]);
    });

    tree.addEventListener('keydown', event => {
        if (event.target !== tree || !selected) return;
        const ids = [...tree.querySelectorAll('.dom-row:not(.close)')].map(idOf);
        const at = ids.indexOf(selected);
        const n = nodes.get(selected);
        const go = id => { if (id != null) { event.preventDefault(); select(id, { scroll: true }); } };
        switch (event.key) {
        case 'ArrowDown': go(ids[at + 1]); break;
        case 'ArrowUp': go(ids[at - 1]); break;
        case 'ArrowRight':
            event.preventDefault();
            if (hasKids(n) && !n.expanded && !inlineText(n)) toggle(selected, true); else go(ids[at + 1]);
            break;
        case 'ArrowLeft':
            event.preventDefault();
            if (n.expanded && hasKids(n)) toggle(selected, false); else if (rowsById.has(n.parent)) go(n.parent);
            break;
        case 'Backspace':
        case 'Delete': {
            event.preventDefault();
            const next = ids[at + 1] ?? ids[at - 1];
            quiet('DOM.removeNode', { nodeId: selected }).then(() => next && nodes.has(next) && select(next, { scroll: true }));
            break;
        }
        case 'Enter': {
            event.preventDefault();
            const row = rowsById.get(selected);
            row?.querySelector('.t-attr-pair, [data-edit]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            break;
        }
        case 'h':
            event.preventDefault();
            nodeCall(selected, function () { this.style.visibility = this.style.visibility === 'hidden' ? '' : 'hidden'; });
            break;
        }
    });

    function addAttribute(id) {
        const row = rowsById.get(id);
        const tagEnd = row?.querySelectorAll('.t-tag')[1];
        if (!tagEnd) return;
        const span = h('span', { class: 't-attr' });
        tagEnd.before(' ', span);
        editText(span, '', { commit: text => text.trim() && quiet('DOM.setAttributesAsText', { nodeId: id, text }), cancel: () => span.remove() });
    }

    async function editHTML(id) {
        const row = rowsById.get(id);
        const result = await quiet('DOM.getOuterHTML', { nodeId: id });
        if (!row || !result) return;
        const area = h('textarea', { class: 'html-edit mono', spellcheck: 'false' });
        area.value = result.outerHTML;
        row.after(area);
        area.focus();
        let done = false;
        const finish = keep => {
            if (done) return;
            done = true;
            area.remove();
            if (keep && area.value !== result.outerHTML) quiet('DOM.setOuterHTML', { nodeId: id, outerHTML: area.value });
            tree.focus();
        };
        area.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Escape') finish(false);
            if (event.key === 'Enter' && event.metaKey) finish(true);
        });
        area.addEventListener('blur', () => finish(true));
    }

    async function expandAll(id) {
        await quiet('DOM.requestChildNodes', { nodeId: id, depth: -1 });
        setTimeout(() => {
            const open = n => { n.expanded = true; kidsOf(n).forEach(open); };
            const n = nodes.get(id);
            if (n) { open(n); render(); }
        }, 150);
    }

    function collapse(id) {
        const close = n => { kidsOf(n).forEach(k => { k.expanded = false; close(k); }); };
        const n = nodes.get(id);
        if (n) close(n);
    }

    function selectorOf() {
        const path = [];
        for (let el = this; el && el.nodeType === 1; el = el.parentElement) {
            let part = el.localName;
            if (el.id) { path.unshift(part + '#' + CSS.escape(el.id)); break; }
            const parent = el.parentElement;
            if (parent) {
                const same = [...parent.children].filter(c => c.localName === el.localName);
                if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
            }
            path.unshift(part);
        }
        return path.join(' > ');
    }

    function xpathOf() {
        const path = [];
        for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
            if (el.id) { path.unshift(`//*[@id="${el.id}"]`); return path.join('/'); }
            const same = el.parentNode ? [...el.parentNode.children].filter(c => c.localName === el.localName) : [];
            path.unshift(el.localName + (same.length > 1 ? `[${same.indexOf(el) + 1}]` : ''));
        }
        return '/' + path.join('/');
    }

    // Find: WebKit's own search over the page's nodes.
    let findAt = 0;
    async function find(step) {
        const query = findInput.value.trim();
        if (!query) { findCount.textContent = ''; return; }
        if (!search || search.query !== query) {
            if (search) quiet('DOM.discardSearchResults', { searchId: search.id });
            const result = await quiet('DOM.performSearch', { query });
            search = result && { id: result.searchId, count: result.resultCount, query };
            findAt = step > 0 ? -1 : 0;
        }
        if (!search?.count) { findCount.textContent = 'No matches'; return; }
        findAt = (findAt + step + search.count) % search.count;
        findCount.textContent = `${findAt + 1} of ${search.count}`;
        const result = await quiet('DOM.getSearchResults', { searchId: search.id, fromIndex: findAt, toIndex: findAt + 1 });
        const id = result?.nodeIds?.[0];
        if (id) setTimeout(() => { reveal(id); findInput.focus(); }, 30);
    }
    findInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { findInput.value = ''; findCount.textContent = ''; tree.focus(); }
    });

    return {
        el, load, reveal, render,
        node: id => nodes.get(id),
        focusFind: () => { findInput.focus(); findInput.select(); },
        get selected() { return nodes.get(selected); },
        shown: () => { if (!rootId && !loading) load(); },
    };
})();

/* ---------- Styles and computed ---------- */

function stylesPane() {
    const INHERITED = new Set(['azimuth', 'border-collapse', 'border-spacing', 'caption-side', 'color', 'cursor', 'direction', 'empty-cells', 'font', 'font-family', 'font-feature-settings', 'font-kerning', 'font-size', 'font-size-adjust', 'font-stretch', 'font-style', 'font-variant', 'font-weight', 'hyphens', 'letter-spacing', 'line-height', 'list-style', 'list-style-image', 'list-style-position', 'list-style-type', 'orphans', 'quotes', 'tab-size', 'text-align', 'text-indent', 'text-rendering', 'text-shadow', 'text-transform', 'visibility', 'white-space', 'widows', 'word-break', 'word-spacing', 'word-wrap', 'overflow-wrap', 'color-scheme', 'accent-color', 'caret-color', 'pointer-events', 'writing-mode', '-webkit-font-smoothing', 'user-select', '-webkit-user-select']);
    const STATES = ['hover', 'active', 'focus', 'focus-visible', 'focus-within', 'visited'];
    const forced = new Map();
    let node = null;
    let tab = store.get('styles.tab', 'styles');
    let token = 0;

    const tabStyles = h('button', { class: 'tab', onclick: () => setTab('styles') }, 'Styles');
    const tabComputed = h('button', { class: 'tab', onclick: () => setTab('computed') }, 'Computed');
    const filter = h('input', { class: 'filter', placeholder: 'Filter', spellcheck: 'false', style: 'width:120px', oninput: () => paint() });
    const statesButton = h('button', { class: 'chip', title: 'Force element state', onclick: () => { statesRow.hidden = !statesRow.hidden; } }, ':hov');
    const statesRow = h('div', { class: 'pseudo-states', hidden: true });
    const body = h('div', { class: 'styles' });
    const el = h('div', null, h('div', { class: 'bar' }, tabStyles, tabComputed, h('div', { class: 'spacer' }), statesButton, filter), statesRow, body);
    let data = null;

    function setTab(next) {
        tab = next;
        store.set('styles.tab', tab);
        tabStyles.classList.toggle('on', tab === 'styles');
        tabComputed.classList.toggle('on', tab === 'computed');
        statesButton.hidden = tab !== 'styles';
        paint();
    }

    async function load(n) {
        node = n;
        const mine = ++token;
        if (!n || n.type !== 1 || n.pseudo) { data = null; paint(); return; }
        const [matched, inline, computed] = await Promise.all([
            quiet('CSS.getMatchedStylesForNode', { nodeId: n.id, includePseudo: true, includeInherited: true }),
            quiet('CSS.getInlineStylesForNode', { nodeId: n.id }),
            quiet('CSS.getComputedStyleForNode', { nodeId: n.id }),
        ]);
        if (mine !== token) return;
        data = { matched, inline, computed };
        paintStates();
        paint();
    }

    function paintStates() {
        const states = forced.get(node?.id) || new Set();
        statesRow.replaceChildren(...STATES.map(state => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: states.has(state), onchange: event => {
                event.target.checked ? states.add(state) : states.delete(state);
                forced.set(node.id, states);
                quiet('CSS.forcePseudoState', { nodeId: node.id, forcedPseudoClasses: [...states] }).then(() => load(node));
            } }), ':' + state)));
    }

    function authored(style) {
        const props = style?.cssProperties || [];
        const written = props.filter(p => p.text != null);
        const list = written.length ? written : props.filter(p => !p.implicit && p.value !== '');
        return list.map(p => ({
            name: p.name,
            value: p.value,
            important: p.priority === 'important',
            off: p.status === 'disabled',
            inactive: p.status === 'inactive',
            invalid: p.parsedOk === false,
        }));
    }

    const serialize = props => props.filter(p => p.name.trim())
        .map(p => { const d = `${p.name}: ${p.value}${p.important ? ' !important' : ''};`; return p.off ? `/* ${d} */` : d; })
        .join(' ');

    async function save(style, props) {
        await quiet('CSS.setStyleText', { styleId: style.styleId, text: serialize(props) });
        load(node);
    }

    const COLOR = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^)]*\)/gi;

    function valueContent(value) {
        const parts = [];
        let last = 0;
        for (const m of value.matchAll(COLOR)) {
            parts.push(value.slice(last, m.index), h('span', { class: 'swatch', style: `background:${m[0]}` }), m[0]);
            last = m.index + m[0].length;
        }
        parts.push(value.slice(last));
        return parts;
    }

    function declaration(style, props, p, editable) {
        const name = h('span', { class: 'n' }, p.name);
        const value = h('span', { class: 'v' }, valueContent(p.value));
        const row = h('div', { class: 'decl' + (p.off ? ' off' : '') + (p.inactive ? ' inactive' : '') + (p.invalid ? ' invalid' : '') },
            editable ? h('input', { type: 'checkbox', checked: !p.off, title: 'Turn this declaration on or off', onchange: () => { p.off = !p.off; save(style, props); } }) : '',
            name, ': ', value, p.important ? h('span', { class: 'imp' }, ' !important') : '', ';');
        if (editable) {
            const editValue = () => editText(value, p.value + (p.important ? ' !important' : ''), {
                commit: text => {
                    const important = /\s*!important\s*$/i.test(text);
                    p.value = text.replace(/\s*!important\s*$/i, '').trim();
                    p.important = important;
                    if (!p.value) props.splice(props.indexOf(p), 1);
                    save(style, props);
                },
            });
            name.addEventListener('click', () => editText(name, p.name, {
                commit: (text, how) => {
                    p.name = text.trim();
                    if (!p.name) { props.splice(props.indexOf(p), 1); save(style, props); return; }
                    if (how === 'next') editValue(); else save(style, props);
                },
                tab: true,
            }));
            value.addEventListener('click', editValue);
        }
        return row;
    }

    function addDeclaration(style, props, block) {
        const name = h('span', { class: 'n' });
        const value = h('span', { class: 'v' });
        const row = h('div', { class: 'decl' }, name, ': ', value, ';');
        block.before(row);
        const p = { name: '', value: '', important: false, off: false };
        editText(name, '', {
            tab: true,
            cancel: () => row.remove(),
            commit: (text, how) => {
                p.name = text.trim();
                if (!p.name || (how !== 'next' && how !== 'enter')) { row.remove(); return; }
                editText(value, '', { commit: v => { p.value = v.trim(); if (p.value) { props.push(p); save(style, props); } else row.remove(); }, cancel: () => row.remove() });
            },
        });
    }

    function ruleBlock({ selector, source, groupings = [], style, editable, only }) {
        const props = authored(style);
        const shown = only ? props.filter(p => only.has(p.name) || p.name.startsWith('--')) : props;
        if (only && !shown.length) return null;
        const query = filter.value.trim().toLowerCase();
        if (query && !shown.some(p => (p.name + ':' + p.value).toLowerCase().includes(query)) && !String(selector.textContent || '').toLowerCase().includes(query)) return null;
        const close = h('div', { class: 'rule-close' }, '}');
        const block = h('div', { class: 'rule' + (editable ? ' editable' : '') },
            groupings.map(g => h('div', { class: 'rule-group' }, g)),
            h('div', { class: 'rule-head' }, h('div', { class: 'rule-sel' }, selector, ' {'), h('div', { class: 'rule-src', title: source }, source)),
            shown.map(p => declaration(style, props, p, editable)),
            close);
        if (editable) block.addEventListener('click', event => {
            if (event.target === block || event.target === close) addDeclaration(style, props, close);
        });
        return block;
    }

    function selectorFor(rule, matching) {
        const selectors = rule.selectorList?.selectors || [];
        if (!selectors.length) return h('span', null, rule.selectorList?.text || '');
        return h('span', null, selectors.map((s, i) => [i ? ', ' : '', h('span', { class: matching && !matching.includes(i) ? 'unmatched' : '' }, s.text)]));
    }

    function sourceOf(rule) {
        if (rule.origin === 'user-agent') return 'user agent stylesheet';
        if (rule.origin === 'inspector') return 'inspector';
        if (rule.sourceURL) return `${basename(rule.sourceURL)}:${(rule.sourceLine ?? 0) + 1}`;
        return '<style>';
    }

    const groupingText = rule => (rule.groupings || []).filter(g => g.text).map(g => {
        const kind = { 'media-rule': '@media', 'media-import-rule': '@import', 'supports-rule': '@supports', 'layer-rule': '@layer', 'container-rule': '@container', 'scope-rule': '@scope', 'style-rule': '', 'starting-style-rule': '@starting-style' }[g.type] ?? '';
        return `${kind} ${g.text}`.trim();
    });

    function matchedBlocks(rules, only) {
        return [...(rules || [])].reverse().map(({ rule, matchingSelectors }) => ruleBlock({
            selector: selectorFor(rule, matchingSelectors),
            source: sourceOf(rule),
            groupings: groupingText(rule),
            style: rule.style,
            editable: !!rule.style?.styleId && rule.origin !== 'user-agent',
            only,
        }));
    }

    function paintStyles() {
        const { matched, inline } = data;
        const out = [];
        if (inline?.inlineStyle) out.push(ruleBlock({ selector: h('span', null, 'element.style'), source: '', style: inline.inlineStyle, editable: !!inline.inlineStyle.styleId }));
        out.push(...matchedBlocks(matched?.matchedCSSRules));
        if (inline?.attributesStyle && authored(inline.attributesStyle).length)
            out.push(ruleBlock({ selector: h('span', null, tagNameOf(node) + '[Attributes Style]'), source: '', style: inline.attributesStyle, editable: false }));
        for (const pseudo of matched?.pseudoElements || []) {
            const blocks = matchedBlocks(pseudo.matches).filter(Boolean);
            if (blocks.length) out.push(h('div', { class: 'inherit-title' }, `Pseudo-element ::${pseudo.pseudoId}`), blocks);
        }
        let ancestor = nodeParent(node);
        for (const entry of matched?.inherited || []) {
            while (ancestor && ancestor.type !== 1) ancestor = nodeParent(ancestor);
            const blocks = [
                entry.inlineStyle && ruleBlock({ selector: h('span', null, 'style attribute'), source: '', style: entry.inlineStyle, editable: !!entry.inlineStyle.styleId, only: INHERITED }),
                ...matchedBlocks(entry.matchedCSSRules, INHERITED),
            ].filter(Boolean);
            if (blocks.length) out.push(h('div', { class: 'inherit-title' }, 'Inherited from ', h('span', { class: 't-tag' }, ancestor ? describe(ancestor) : 'ancestor')), blocks);
            ancestor = nodeParent(ancestor);
        }
        return out;
    }

    function px(map, name) { return map.get(name) ?? ''; }
    const trim = v => String(v).replace(/px$/, '').replace(/^0$/, '–');

    function boxModel(map) {
        const side = (prefix, suffix = '') => ['top', 'right', 'bottom', 'left'].map(s => trim(px(map, `${prefix}-${s}${suffix}`)));
        const [mt, mr, mb, ml] = side('margin');
        const [bt, br, bb, bl] = side('border', '-width');
        const [pt, pr, pb, pl] = side('padding');
        let w = parseFloat(px(map, 'width')), hgt = parseFloat(px(map, 'height'));
        if (px(map, 'box-sizing') === 'border-box') {
            const n = name => parseFloat(px(map, name)) || 0;
            w -= n('padding-left') + n('padding-right') + n('border-left-width') + n('border-right-width');
            hgt -= n('padding-top') + n('padding-bottom') + n('border-top-width') + n('border-bottom-width');
        }
        const ring = (cls, label, [t, r, b, l], inner) => h('div', { class: 'bm ' + cls },
            h('span', { class: 'bm-label' }, label), h('span', { class: 't' }, t), h('span', { class: 'r' }, r), h('span', { class: 'b' }, b), h('span', { class: 'l' }, l), inner);
        const size = isNaN(w) ? 'auto' : `${Math.round(w * 100) / 100} × ${Math.round(hgt * 100) / 100}`;
        return h('div', { class: 'boxmodel' }, ring('margin', 'margin', [mt, mr, mb, ml], ring('border', 'border', [bt, br, bb, bl], ring('padding', 'padding', [pt, pr, pb, pl], h('div', { class: 'bm content' }, size)))));
    }

    function paintComputed() {
        const list = data.computed?.computedStyle || [];
        const map = new Map(list.map(p => [p.name, p.value]));
        const query = filter.value.trim().toLowerCase();
        const rows = list.filter(p => !query || p.name.includes(query) || p.value.toLowerCase().includes(query))
            .sort((a, b) => (a.name.startsWith('-') - b.name.startsWith('-')) || a.name.localeCompare(b.name))
            .map(p => h('div', { class: 'computed-row' }, h('span', { class: 'n' }, p.name + ':'), h('span', { class: 'v' }, valueContent(p.value))));
        return [query ? '' : boxModel(map), rows];
    }

    function paint() {
        if (!data) { body.replaceChildren(h('div', { class: 'empty' }, node ? 'No styles for this node.' : 'Select an element to see its styles.')); return; }
        const top = body.scrollTop;
        body.replaceChildren(...[tab === 'styles' ? paintStyles() : paintComputed()].flat(Infinity).filter(Boolean));
        body.scrollTop = top;
    }

    on('CSS.styleSheetChanged', debounce(() => node && load(node), 120));
    setTab(tab);
    return { el, load, refresh: () => node && load(node) };
}

function nodeParent(n) { return n && n.parent != null ? elements.node(n.parent) : null; }
function tagNameOf(n) { return n ? (n.local || n.name.toLowerCase()) : ''; }
function describe(n) {
    const id = n.attrs?.find(a => a[0] === 'id')?.[1];
    const cls = n.attrs?.find(a => a[0] === 'class')?.[1]?.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return tagNameOf(n) + (id ? '#' + id : '') + (cls?.length ? '.' + cls.join('.') : '');
}

/* ---------- Console ---------- */

const consolePanel = (() => {
    const LEVELS = [['error', 'Errors'], ['warning', 'Warnings'], ['info', 'Info'], ['log', 'Logs'], ['debug', 'Debug']];
    const levels = new Set(store.get('console.levels', []));
    let preserve = store.get('console.preserve', false);
    let counts = { error: 0, warning: 0 };
    const history = store.get('console.history', []);
    let historyAt = history.length;
    let groups = [];
    let last = null;

    const log = h('div', { class: 'log' });
    const filter = h('input', { class: 'filter', placeholder: 'Filter', spellcheck: 'false', oninput: () => applyFilter() });
    const chips = LEVELS.map(([level, label]) => h('button', { class: 'chip', 'data-level': level, onclick: () => { levels.has(level) ? levels.delete(level) : levels.add(level); store.set('console.levels', [...levels]); paintChips(); applyFilter(); } }, label));
    const all = h('button', { class: 'chip', onclick: () => { levels.clear(); store.set('console.levels', []); paintChips(); applyFilter(); } }, 'All');
    const prompt = h('textarea', { class: 'prompt mono', rows: '1', spellcheck: 'false', placeholder: 'Evaluate in the page' });
    const complete = h('div', { class: 'complete', hidden: true });
    const el = h('div', { class: 'panel' },
        h('div', { class: 'bar sub' },
            icon('clear', 'Clear console (⌘K)', () => clear(true)), filter, all, chips, h('div', { class: 'spacer' }),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: preserve, onchange: e => { preserve = e.target.checked; store.set('console.preserve', preserve); } }), 'Preserve log')),
        log,
        h('div', { class: 'prompt-row' }, h('span', { class: 'msg-icon' }, '›'), prompt, complete));

    function paintChips() {
        all.classList.toggle('on', !levels.size);
        for (const chip of chips) chip.classList.toggle('on', levels.has(chip.dataset.level));
    }

    const visible = row => {
        const level = row.dataset.level;
        if (levels.size && level && !levels.has(level)) return false;
        const query = filter.value.trim().toLowerCase();
        return !query || row.textContent.toLowerCase().includes(query);
    };

    function applyFilter() {
        for (const row of log.querySelectorAll('.msg[data-level]')) row.hidden = !visible(row);
    }

    const container = () => groups.at(-1) || log;

    function add(row) {
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
        if (row.dataset.level) row.hidden = !visible(row);
        container().append(row);
        while (log.childElementCount > 5000) log.firstElementChild.remove();
        if (atBottom) log.scrollTop = log.scrollHeight;
        return row;
    }

    function formatted(parameters) {
        const out = [];
        let rest = parameters;
        const first = parameters[0];
        if (first?.type === 'string' && parameters.length > 1 && /%[sdifoOc]/.test(first.value)) {
            rest = parameters.slice(1);
            let span = h('span');
            out.push(span);
            for (const part of first.value.split(/(%[sdifoOc])/)) {
                if (!/^%[sdifoOc]$/.test(part) || !rest.length) { span.append(part); continue; }
                const arg = rest.shift();
                switch (part[1]) {
                case 's': span.append(arg.type === 'string' ? arg.value : renderValue(arg)); break;
                case 'd': case 'i': span.append(h('span', { class: 'v-num' }, String(parseInt(arg.value ?? arg.description)))); break;
                case 'f': span.append(h('span', { class: 'v-num' }, String(parseFloat(arg.value ?? arg.description)))); break;
                case 'o': case 'O': span.append(renderValue(arg)); break;
                case 'c':
                    span = h('span', { style: String(arg.value || '').replace(/url\([^)]*\)/gi, '') });
                    out.push(span);
                    break;
                }
            }
        }
        rest.forEach((p, i) => { if (out.length || i) out.push(' '); out.push(renderValue(p, { top: true })); });
        return out;
    }

    function frames(stack) {
        if (!stack) return [];
        const list = Array.isArray(stack) ? stack : stack.callFrames || [];
        return list.filter(f => f.url || f.functionName);
    }

    function location(message, stack) {
        const top = stack[0];
        const url = top?.url || message.url;
        const line = top?.lineNumber ?? message.line;
        if (!url) return '';
        return h('span', { class: 'msg-src', title: url }, `${basename(url)}${line ? ':' + line : ''}`);
    }

    function table(obj) {
        if (obj && !obj.preview && obj.objectId) {
            const holder = h('div', null, renderValue(obj, { top: true }));
            quiet('Runtime.getPreview', { objectId: obj.objectId }).then(result => {
                if (result?.preview) holder.replaceWith(table({ ...obj, preview: result.preview }));
            });
            return holder;
        }
        const p = obj?.preview;
        if (!p?.properties) return renderValue(obj, { top: true });
        const columns = [];
        const rows = p.properties.map(q => {
            const cells = {};
            if (q.valuePreview?.properties) for (const c of q.valuePreview.properties) {
                if (!columns.includes(c.name)) columns.push(c.name);
                cells[c.name] = previewProperty(c);
            } else {
                if (!columns.includes('Value')) columns.push('Value');
                cells.Value = previewProperty(q);
            }
            return [q.name, cells];
        });
        return h('div', null,
            h('table', { class: 'ctable' }, h('tr', null, h('th', null, '(index)'), columns.map(c => h('th', null, c))),
                rows.map(([name, cells]) => h('tr', null, h('td', null, name), columns.map(c => h('td', null, cells[c] ?? ''))))),
            renderValue(obj));
    }

    const ICON = { error: '✕', warning: '!', info: 'i', debug: '·' };

    function message(m) {
        if (m.type === 'clear') { clear(false); add(h('div', { class: 'msg debug' }, h('span', { class: 'msg-icon' }), h('div', { class: 'msg-body v-dim' }, 'Console was cleared'))); return; }
        if (m.type === 'endGroup') { groups.pop(); last = null; return; }
        const level = m.level === 'warning' ? 'warning' : m.level === 'error' ? 'error' : m.level === 'debug' ? 'debug' : m.level === 'info' ? 'info' : 'log';
        if (level === 'error' || level === 'warning') { counts[level]++; updateCounts(); }
        const stack = frames(m.stackTrace);
        let content = m.type === 'table' && m.parameters?.length ? [table(m.parameters[0])]
            : m.parameters?.length ? formatted(m.parameters)
            : [h('span', null, m.text || '')];
        if (m.type === 'assert') content.unshift('Assertion failed: ');
        if (m.source === 'network' && m.url && !m.parameters?.length) content = [h('span', null, m.text)];
        let body = h('div', { class: 'msg-body' + (m.type?.startsWith('startGroup') ? ' group-title' : '') }, content);
        if (stack.length && (m.type === 'trace' || level === 'error' || m.type === 'assert') && !m.parameters?.some(p => p.subtype === 'error')) {
            const tree = expandable(h('span', null, content), () => stack.map(f => h('div', { class: 'stack' }, `${f.functionName || '(anonymous function)'} @ ${f.url ? basename(f.url) : ''}:${f.lineNumber}:${f.columnNumber}`)));
            if (m.type === 'trace') tree.toggle();
            body = h('div', { class: 'msg-body' }, tree);
        }
        const row = h('div', { class: 'msg ' + level, 'data-level': level }, h('span', { class: 'msg-icon' }, ICON[level] || ''), body, location(m, stack));
        if (m.repeatCount > 1) row.append(h('span', { class: 'msg-count' }, String(m.repeatCount)));
        if (m.type === 'startGroup' || m.type === 'startGroupCollapsed') {
            const group = h('div', { class: 'group' + (m.type === 'startGroupCollapsed' ? ' closed' : '') }, row);
            row.addEventListener('click', () => group.classList.toggle('closed'));
            add(group);
            groups.push(group);
            last = null;
            return;
        }
        last = add(row);
    }

    function clear(fromUser) {
        log.replaceChildren();
        groups = [];
        last = null;
        counts = { error: 0, warning: 0 };
        updateCounts();
        if (fromUser) { quiet('Console.clearMessages'); quiet('Runtime.releaseObjectGroup', { objectGroup: 'console' }); }
    }

    on('Console.messageAdded', ({ message: m }) => message(m));
    on('Console.messageRepeatCountUpdated', ({ count }) => {
        if (!last) return;
        let badge = last.querySelector('.msg-count');
        if (!badge) { badge = h('span', { class: 'msg-count' }); last.append(badge); }
        badge.textContent = String(count);
    });
    on('Console.messagesCleared', ({ reason }) => {
        if (reason === 'main-frame-navigation' && preserve) return;
        if (reason === 'console-api') return;
        clear(false);
    });
    on('Page.frameNavigated', ({ frame }) => {
        if (!frame.parentId && preserve) add(h('div', { class: 'msg debug' }, h('span', { class: 'msg-icon' }), h('div', { class: 'msg-body v-dim' }, `Navigated to ${frame.url}`)));
    });

    async function evaluate(expression) {
        if (!expression.trim()) return;
        if (history.at(-1) !== expression) history.push(expression);
        while (history.length > 200) history.shift();
        store.set('console.history', history);
        historyAt = history.length;
        last = null;
        add(h('div', { class: 'msg input' }, h('span', { class: 'msg-icon' }, '›'), h('div', { class: 'msg-body' }, expression)));
        const result = await cmd('Runtime.evaluate', {
            expression,
            objectGroup: 'console',
            includeCommandLineAPI: true,
            generatePreview: true,
            saveResult: true,
            emulateUserGesture: true,
        }).catch(error => ({ result: { type: 'string', value: String(error.message || error) }, wasThrown: true }));
        const value = result.wasThrown
            ? h('span', { class: 'v-err' }, 'Uncaught ', result.result.description || result.result.value || 'error')
            : renderValue(result.result, { open: false });
        add(h('div', { class: 'msg result' + (result.wasThrown ? ' error' : '') }, h('span', { class: 'msg-icon' }, '‹'), h('div', { class: 'msg-body' }, value)));
        log.scrollTop = log.scrollHeight;
    }

    // Completion: the names on the object before the dot, or on the page's global.
    let suggestions = [];
    let pick = 0;
    const cache = new Map();

    async function suggest() {
        const before = prompt.value.slice(0, prompt.selectionStart);
        const m = /(?:^|[^\w$.])((?:[\w$]+\.)*)([\w$]*)$/.exec(before);
        if (!m || (!m[1] && !m[2]) || prompt.selectionStart !== prompt.selectionEnd) { hide(); return; }
        const base = m[1].slice(0, -1);
        const partial = m[2];
        let names = cache.get(base);
        if (!names) {
            const result = await quiet('Runtime.evaluate', {
                expression: `(() => { const o = ${base || 'globalThis'}; if (o == null) return []; const s = new Set(); for (let p = Object(o), i = 0; p && i < 40; p = Object.getPrototypeOf(p), i++) for (const k of Object.getOwnPropertyNames(p)) s.add(k); return [...s]; })()`,
                objectGroup: 'completion',
                includeCommandLineAPI: true,
                returnByValue: true,
                doNotPauseOnExceptionsAndMuteConsole: true,
            });
            names = (result && !result.wasThrown && Array.isArray(result.result.value) ? result.result.value : []).filter(n => /^[A-Za-z_$][\w$]*$/.test(n)).sort();
            cache.set(base, names);
            setTimeout(() => cache.delete(base), 5000);
        }
        if (prompt.value.slice(0, prompt.selectionStart) !== before) return;
        suggestions = names.filter(n => n.startsWith(partial) && n !== partial).slice(0, 60);
        if (!suggestions.length) { hide(); return; }
        pick = 0;
        complete.replaceChildren(...suggestions.map((name, i) => h('div', { class: i === pick ? 'on' : '', onmousedown: e => { e.preventDefault(); pick = i; accept(); } }, name)));
        complete.hidden = false;
        complete.partial = partial;
    }

    function hide() { complete.hidden = true; suggestions = []; }

    function accept() {
        const name = suggestions[pick];
        if (!name) return;
        const at = prompt.selectionStart;
        const start = at - complete.partial.length;
        prompt.value = prompt.value.slice(0, start) + name + prompt.value.slice(at);
        prompt.selectionStart = prompt.selectionEnd = start + name.length;
        hide();
        autosize();
    }

    function move(step) {
        pick = (pick + step + suggestions.length) % suggestions.length;
        [...complete.children].forEach((row, i) => row.classList.toggle('on', i === pick));
        complete.children[pick]?.scrollIntoView({ block: 'nearest' });
    }

    function autosize() { prompt.style.height = 'auto'; prompt.style.height = prompt.scrollHeight + 'px'; }

    prompt.addEventListener('input', () => { autosize(); suggest(); });
    prompt.addEventListener('blur', () => setTimeout(hide, 100));
    prompt.addEventListener('keydown', event => {
        if (!complete.hidden) {
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return; }
            if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey) || event.key === 'ArrowRight') { event.preventDefault(); accept(); return; }
            if (event.key === 'Escape') { event.preventDefault(); hide(); return; }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            const expression = prompt.value;
            prompt.value = '';
            autosize();
            evaluate(expression);
        } else if (event.key === 'ArrowUp' && !prompt.value.slice(0, prompt.selectionStart).includes('\n') && historyAt > 0) {
            event.preventDefault();
            prompt.value = history[--historyAt];
            autosize();
        } else if (event.key === 'ArrowDown' && !prompt.value.slice(prompt.selectionEnd).includes('\n') && historyAt < history.length) {
            event.preventDefault();
            historyAt++;
            prompt.value = history[historyAt] ?? '';
            autosize();
        } else if (event.key === 'l' && event.ctrlKey) {
            event.preventDefault();
            clear(true);
        }
    });
    log.addEventListener('mouseup', () => { if (!getSelection().toString()) prompt.focus(); });

    paintChips();
    return {
        el,
        clear: () => clear(true),
        focus: () => prompt.focus(),
        focusFilter: () => { filter.focus(); filter.select(); },
        shown: () => { log.scrollTop = log.scrollHeight; prompt.focus(); },
        get counts() { return counts; },
    };
})();

/* ---------- Network ---------- */

const network = (() => {
    const TYPES = { Document: 'document', StyleSheet: 'stylesheet', Script: 'script', Image: 'image', Font: 'font', XHR: 'xhr', Fetch: 'fetch', Ping: 'ping', Beacon: 'beacon', WebSocket: 'websocket', EventSource: 'eventsource', Media: 'media', Other: 'other' };
    const CHIPS = [['all', 'All'], ['fetch', 'Fetch/XHR'], ['document', 'Doc'], ['stylesheet', 'CSS'], ['script', 'JS'], ['font', 'Font'], ['image', 'Img'], ['media', 'Media'], ['websocket', 'WS'], ['other', 'Other']];
    const KNOWN = new Set(['fetch', 'xhr', 'eventsource', 'document', 'stylesheet', 'script', 'font', 'image', 'media', 'websocket']);
    const requests = new Map();
    let order = [];
    let recording = true;
    let preserve = store.get('net.preserve', false);
    let noCache = store.get('net.nocache', false);
    let kind = store.get('net.kind', 'all');
    let sort = { key: 'start', dir: 1 };
    let selected = null;
    let tab = store.get('net.tab', 'headers');
    let marks = {};

    const typeOf = r => TYPES[r.type] || (r.mime?.startsWith('image/') ? 'image' : /^(video|audio)\//.test(r.mime || '') ? 'media' : 'other');
    const durationOf = r => r.end != null ? (r.end - r.start) * 1000 : null;
    const sizeOf = r => r.transferred ?? r.encoded ?? r.size ?? 0;

    const filterInput = h('input', { class: 'filter', placeholder: 'Filter  (status:404  method:POST  domain:  -exclude)', spellcheck: 'false', oninput: () => paint() });
    const recordButton = icon('record', 'Record network activity', () => { recording = !recording; recordButton.classList.toggle('on', recording); }, 'rec on');
    const chipEls = CHIPS.map(([key, label]) => h('button', { class: 'chip' + (key === kind ? ' on' : ''), onclick: () => { kind = key; store.set('net.kind', kind); chipEls.forEach((c, i) => c.classList.toggle('on', CHIPS[i][0] === kind)); paint(); } }, label));
    const tableBox = h('div', { class: 'scroll', tabindex: '0' });
    const statusBar = h('div', { class: 'status-bar' });
    const detail = h('div', { class: 'detail' });
    const detailTabs = h('div', { class: 'bar' });
    const list = h('div', null, tableBox, statusBar);
    const detailPane = h('div', null, detailTabs, detail);
    const body = split(detailPane, list, 'network', 320, { first: true });
    body.classList.add('solo');
    const el = h('div', { class: 'panel' },
        h('div', { class: 'bar sub' },
            recordButton,
            icon('clear', 'Clear', () => clear()),
            h('div', { class: 'sep' }),
            filterInput,
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: preserve, onchange: e => { preserve = e.target.checked; store.set('net.preserve', preserve); } }), 'Preserve log'),
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: noCache, onchange: e => { noCache = e.target.checked; store.set('net.nocache', noCache); quiet('Network.setResourceCachingDisabled', { disabled: noCache }); } }), 'Disable cache')),
        h('div', { class: 'bar sub' }, chipEls),
        body);

    function clear() {
        requests.clear();
        order = [];
        marks = {};
        select(null);
        paint();
    }

    function get(id) {
        let r = requests.get(id);
        if (!r) { r = { id, rid: id, frames: [] }; requests.set(id, r); order.push(id); }
        return r;
    }

    const changed = id => { paintSoon(); if (id === selected) paintDetailSoon(); };

    on('Network.requestWillBeSent', p => {
        if (!recording) return;
        let r = requests.get(p.requestId);
        if (r && p.redirectResponse) {
            const hop = { ...r, id: `${r.id}:${r.hops = (r.hops || 0) + 1}`, redirect: true, end: p.timestamp };
            Object.assign(hop, { status: p.redirectResponse.status, statusText: p.redirectResponse.statusText, responseHeaders: p.redirectResponse.headers, mime: p.redirectResponse.mimeType, timing: p.redirectResponse.timing });
            requests.set(hop.id, hop);
            order.splice(order.indexOf(r.id), 0, hop.id);
        }
        r = get(p.requestId);
        Object.assign(r, {
            url: p.request.url, method: p.request.method, requestHeaders: p.request.headers, postData: p.request.postData,
            type: p.type, initiator: p.initiator, start: p.timestamp, wall: p.walltime, loaderId: p.loaderId, frameId: p.frameId,
            status: undefined, statusText: '', responseHeaders: null, mime: '', size: 0, encoded: 0, transferred: undefined,
            end: undefined, respTs: undefined, failed: false, error: '', source: '', metrics: null, body: undefined,
        });
        changed(r.id);
    });
    on('Network.responseReceived', ({ requestId, timestamp, type, response }) => {
        const r = requests.get(requestId);
        if (!r) return;
        Object.assign(r, { status: response.status, statusText: response.statusText, responseHeaders: response.headers, mime: response.mimeType, timing: response.timing, source: response.source, security: response.security, respTs: timestamp });
        if (type) r.type = type;
        changed(requestId);
    });
    on('Network.dataReceived', ({ requestId, dataLength, encodedDataLength }) => {
        const r = requests.get(requestId);
        if (!r) return;
        r.size += dataLength || 0;
        r.encoded += encodedDataLength || 0;
        paintSoon();
    });
    on('Network.loadingFinished', ({ requestId, timestamp, metrics }) => {
        const r = requests.get(requestId);
        if (!r) return;
        r.end = timestamp;
        if (metrics) {
            r.metrics = metrics;
            if (metrics.responseBodyBytesReceived != null) r.transferred = (metrics.responseHeaderBytesReceived || 0) + metrics.responseBodyBytesReceived;
            if (metrics.responseBodyDecodedSize != null) r.size = metrics.responseBodyDecodedSize;
        }
        changed(requestId);
    });
    on('Network.loadingFailed', ({ requestId, timestamp, errorText, canceled }) => {
        const r = requests.get(requestId);
        if (!r) return;
        Object.assign(r, { end: timestamp, failed: true, error: canceled ? 'Canceled' : errorText });
        changed(requestId);
    });
    on('Network.requestServedFromMemoryCache', p => {
        if (!recording) return;
        const r = get(p.requestId);
        const res = p.resource;
        Object.assign(r, {
            url: res.url, method: 'GET', type: res.type, initiator: p.initiator, start: p.timestamp, end: p.timestamp, respTs: p.timestamp,
            loaderId: p.loaderId, status: res.response?.status, statusText: res.response?.statusText, responseHeaders: res.response?.headers,
            mime: res.response?.mimeType || res.mimeType, size: res.bodySize, source: 'memory-cache', requestHeaders: {},
        });
        changed(r.id);
    });
    on('Network.webSocketCreated', ({ requestId, url }) => {
        if (!recording) return;
        const r = get(requestId);
        Object.assign(r, { url, method: 'GET', type: 'WebSocket', start: performance.now() / 1000, requestHeaders: {}, frames: [] });
        changed(requestId);
    });
    on('Network.webSocketWillSendHandshakeRequest', ({ requestId, timestamp, request }) => {
        const r = requests.get(requestId);
        if (r) { r.start = timestamp; r.requestHeaders = request.headers; changed(requestId); }
    });
    on('Network.webSocketHandshakeResponseReceived', ({ requestId, timestamp, response }) => {
        const r = requests.get(requestId);
        if (r) { Object.assign(r, { status: response.status, statusText: response.statusText, responseHeaders: response.headers, respTs: timestamp }); changed(requestId); }
    });
    const frame = out => ({ requestId, timestamp, response }) => {
        const r = requests.get(requestId);
        if (!r) return;
        r.frames.push({ out, time: timestamp, opcode: response.opcode, data: response.payloadData, length: response.payloadLength });
        r.size = (r.size || 0) + (response.payloadLength || 0);
        changed(requestId);
    };
    on('Network.webSocketFrameSent', frame(true));
    on('Network.webSocketFrameReceived', frame(false));
    on('Network.webSocketClosed', ({ requestId, timestamp }) => {
        const r = requests.get(requestId);
        if (r) { r.end = timestamp; changed(requestId); }
    });
    on('Network.webSocketFrameError', ({ requestId, errorMessage }) => {
        const r = requests.get(requestId);
        if (r) { r.failed = true; r.error = errorMessage; changed(requestId); }
    });
    on('Page.frameNavigated', ({ frame: f }) => {
        if (f.parentId || preserve) return;
        const doc = order.map(id => requests.get(id)).find(r => r.loaderId === f.loaderId && r.type === 'Document');
        if (!doc) return;
        for (const id of [...order]) {
            const r = requests.get(id);
            if (r.start < doc.start) { requests.delete(id); if (id === selected) select(null); }
        }
        order = order.filter(id => requests.has(id));
        marks = {};
        paintSoon();
    });
    on('Page.domContentEventFired', ({ timestamp }) => { marks.dcl = timestamp; paintSoon(); });
    on('Page.loadEventFired', ({ timestamp }) => { marks.load = timestamp; paintSoon(); });

    // Which rows show.

    function matches(r) {
        const t = typeOf(r);
        if (kind === 'fetch' && !['fetch', 'xhr', 'eventsource'].includes(t)) return false;
        if (kind === 'other' && KNOWN.has(t)) return false;
        if (kind !== 'all' && kind !== 'fetch' && kind !== 'other' && t !== kind) return false;
        for (const token of filterInput.value.trim().split(/\s+/).filter(Boolean)) {
            const negate = token.startsWith('-') && token.length > 1;
            const word = (negate ? token.slice(1) : token).toLowerCase();
            const [key, ...rest] = word.split(':');
            const value = rest.join(':');
            let hit;
            if (value && key === 'status') hit = String(r.status ?? '').startsWith(value);
            else if (value && key === 'method') hit = (r.method || '').toLowerCase() === value;
            else if (value && key === 'domain') hit = hostOf(r.url).includes(value);
            else if (value && key === 'type') hit = t === value;
            else if (value && key === 'mime') hit = (r.mime || '').includes(value);
            else hit = (r.url || '').toLowerCase().includes(word);
            if (hit === negate) return false;
        }
        return true;
    }

    function rows() {
        const all = order.map(id => requests.get(id)).filter(r => r?.url);
        const shown = all.filter(matches);
        const key = sort.key;
        const value = r => key === 'name' ? basename(r.url).toLowerCase() : key === 'status' ? (r.status ?? 0) : key === 'method' ? r.method
            : key === 'type' ? typeOf(r) : key === 'size' ? sizeOf(r) : key === 'time' ? (durationOf(r) ?? Infinity) : key === 'initiator' ? initiatorText(r) : r.start;
        if (key !== 'start' || sort.dir < 0) shown.sort((a, b) => { const x = value(a), y = value(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
        return { all, shown };
    }

    function initiatorText(r) {
        const i = r.initiator;
        if (!i) return 'Other';
        const top = i.stackTrace ? (Array.isArray(i.stackTrace) ? i.stackTrace : i.stackTrace.callFrames || []).find(f => f.url && f.url !== '[native code]') : null;
        if (top?.url) return `${basename(top.url)}:${top.lineNumber}`;
        if (i.url) return `${basename(i.url)}${i.lineNumber != null ? ':' + (i.lineNumber + 1) : ''}`;
        return i.type === 'parser' ? 'Parser' : i.type === 'script' ? 'Script' : 'Other';
    }

    function sizeText(r) {
        if (r.source === 'memory-cache') return '(memory cache)';
        if (r.source === 'disk-cache') return '(disk cache)';
        if (r.source === 'service-worker') return '(service worker)';
        if (r.end == null && !r.failed) return 'Pending';
        return fmtBytes(sizeOf(r));
    }

    function statusText(r) {
        if (r.failed) return r.error || '(failed)';
        if (r.status == null) return 'Pending';
        return String(r.status);
    }

    const COLUMNS = [
        ['name', 'Name', '32%'], ['status', 'Status', '70px'], ['method', 'Method', '64px'], ['type', 'Type', '84px'],
        ['initiator', 'Initiator', '14%'], ['size', 'Size', '84px'], ['time', 'Time', '70px'], ['waterfall', 'Waterfall', '20%'],
    ];

    function paint() {
        const { all, shown } = rows();
        const solo = selected == null;
        body.classList.toggle('solo', solo);
        const columns = solo ? COLUMNS : COLUMNS.slice(0, 1);
        const starts = shown.map(r => r.start).filter(v => v != null);
        const t0 = Math.min(...starts);
        const t1 = Math.max(...shown.map(r => r.end ?? r.respTs ?? r.start).filter(v => v != null), t0 + 0.001);
        const span = t1 - t0;
        const pct = t => `${((t - t0) / span) * 100}%`;
        const head = h('tr', null, columns.map(([key, label, width]) => h('th', {
            class: key === 'waterfall' ? '' : 'sortable',
            style: `width:${solo ? width : 'auto'}`,
            onclick: key === 'waterfall' ? null : () => { sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: 1 }; paint(); },
        }, label, sort.key === key ? h('span', { class: 'arrow' }, sort.dir > 0 ? '▲' : '▼') : '')));
        const bodyRows = shown.map(r => {
            const t = typeOf(r);
            const cells = {
                name: h('td', { title: r.url }, h('div', { class: 'name-cell' }, h('span', { class: 'dot ' + t }), h('span', { class: 'nm' }, basename(r.url)), solo ? h('span', { class: 'host' }, hostOf(r.url)) : '')),
                status: h('td', { title: r.statusText || r.error }, statusText(r)),
                method: h('td', null, r.method),
                type: h('td', null, t),
                initiator: h('td', { title: r.initiator?.url || '' }, initiatorText(r)),
                size: h('td', { class: 'num', title: `${fmtBytes(r.size)} resource` }, sizeText(r)),
                time: h('td', { class: 'num' }, r.end == null && !r.failed ? '…' : fmtMs(durationOf(r))),
                waterfall: h('td', null, h('div', { class: 'wf' },
                    r.start != null ? h('span', { class: 'wait', style: `left:${pct(r.start)};width:calc(${pct(r.respTs ?? r.end ?? t1)} - ${pct(r.start)})` }) : '',
                    r.respTs != null ? h('span', { class: 'load', style: `left:${pct(r.respTs)};width:calc(${pct(r.end ?? t1)} - ${pct(r.respTs)})` }) : '')),
            };
            const dim = r.redirect || (r.status >= 300 && r.status < 400);
            return h('tr', { class: (r.id === selected ? 'on ' : '') + (r.failed || r.status >= 400 ? 'failed ' : '') + (dim ? 'dim' : ''), 'data-id': r.id }, columns.map(([key]) => cells[key]));
        });
        const top = tableBox.scrollTop;
        const atBottom = tableBox.scrollHeight - top - tableBox.clientHeight < 30;
        tableBox.replaceChildren(shown.length || all.length
            ? h('table', { class: 'grid' }, h('thead', null, head), h('tbody', null, bodyRows))
            : h('div', { class: 'empty' }, 'Recording network activity…', h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => reload(false) }, 'Reload the page'), ' to see its requests')));
        tableBox.scrollTop = atBottom && sort.key === 'start' ? tableBox.scrollHeight : top;
        const transferred = shown.reduce((sum, r) => sum + (r.source && r.source !== 'network' ? 0 : sizeOf(r)), 0);
        const resources = shown.reduce((sum, r) => sum + (r.size || 0), 0);
        const first = Math.min(...all.map(r => r.start).filter(v => v != null));
        const finish = Math.max(...all.map(r => r.end).filter(v => v != null));
        statusBar.replaceChildren(
            h('span', null, `${shown.length}${shown.length !== all.length ? ' / ' + all.length : ''} requests`),
            h('span', null, `${fmtBytes(transferred)} transferred`),
            h('span', null, `${fmtBytes(resources)} resources`),
            isFinite(finish - first) ? h('span', null, `Finish: ${fmtMs((finish - first) * 1000)}`) : '',
            marks.dcl && isFinite(first) ? h('span', { style: 'color:var(--accent)' }, `DOMContentLoaded: ${fmtMs((marks.dcl - first) * 1000)}`) : '',
            marks.load && isFinite(first) ? h('span', { style: 'color:var(--err)' }, `Load: ${fmtMs((marks.load - first) * 1000)}`) : '');
    }

    const paintSoon = throttle(() => { if (current === 'network') paint(); }, 120);

    tableBox.addEventListener('mousedown', event => {
        const row = event.target.closest('tr[data-id]');
        if (row && event.button === 0) select(row.dataset.id);
    });
    tableBox.addEventListener('contextmenu', event => {
        const row = event.target.closest('tr[data-id]');
        if (!row) return;
        const r = requests.get(row.dataset.id);
        const replayable = ['fetch', 'xhr'].includes(typeOf(r));
        menu(event, [
            ['Copy URL', () => copy(r.url)],
            ['Copy as cURL', () => copy(curl(r))],
            ['Copy as fetch', () => copy(asFetch(r))],
            ['Copy response', async () => { const b = await bodyOf(r); copy(b.error ? '' : b.base64Encoded ? atob(b.body) : b.body); }],
            ['Copy request headers', () => copy(headerText(sentHeaders(r)))],
            ['Copy response headers', () => copy(headerText(r.responseHeaders))],
            '-',
            replayable && ['Replay request', () => replay(r)],
            ['Open in new tab', () => InspectorFrontendHost.openURLExternally(r.url)],
            '-',
            ['Clear', () => clear()],
        ]);
    });
    tableBox.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return;
        event.preventDefault();
        if (event.key === 'Escape') { select(null); return; }
        const ids = [...tableBox.querySelectorAll('tr[data-id]')].map(r => r.dataset.id);
        const at = ids.indexOf(selected);
        const next = ids[event.key === 'ArrowDown' ? at + 1 : Math.max(0, at - 1)];
        if (next) { select(next); tableBox.querySelector(`tr[data-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' }); }
    });

    function select(id) {
        selected = id;
        paint();
        paintDetail();
    }

    // The request in detail.

    const sentHeaders = r => r.metrics?.requestHeaders || r.requestHeaders || {};
    const headerText = headers => Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    const shell = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

    function curl(r) {
        const parts = ['curl ' + shell(r.url)];
        if (r.method && r.method !== 'GET') parts.push('-X ' + r.method);
        for (const [k, v] of Object.entries(sentHeaders(r))) if (!/^(content-length|host|connection)$/i.test(k)) parts.push('-H ' + shell(`${k}: ${v}`));
        if (r.postData != null) parts.push('--data-raw ' + shell(r.postData));
        return parts.join(' \\\n  ');
    }

    const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-.*|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|user-agent|via|sec-.*|proxy-.*)$/i;
    const fetchInit = r => ({
        method: r.method,
        headers: Object.fromEntries(Object.entries(sentHeaders(r)).filter(([k]) => !FORBIDDEN.test(k))),
        body: r.postData ?? undefined,
        credentials: 'include',
        mode: 'cors',
    });

    const asFetch = r => `fetch(${JSON.stringify(r.url)}, ${JSON.stringify(fetchInit(r), null, 2)});`;

    function replay(r) {
        pageCall(async (url, init) => { const response = await fetch(url, init); return response.status; }, r.url, fetchInit(r))
            .catch(error => console.warn('Search DevTools: replay failed', error));
    }

    async function bodyOf(r) {
        if (r.body) return r.body;
        if (r.redirect) return (r.body = { error: 'A redirect has no body.' });
        try { r.body = await cmd('Network.getResponseBody', { requestId: r.rid }); }
        catch (error) { r.body = { error: 'No response data is available for this request.' }; }
        return r.body;
    }

    const paintDetailSoon = throttle(() => { if (tab === 'headers' || tab === 'timing' || tab === 'messages') paintDetail(); }, 250);

    function paintDetail() {
        const r = requests.get(selected);
        if (!r) { detail.replaceChildren(); detailTabs.replaceChildren(); return; }
        const t = typeOf(r);
        const query = (() => { try { return [...new URL(r.url).searchParams]; } catch { return []; } })();
        const tabs = [['headers', 'Headers'], (r.postData != null || query.length) && ['payload', 'Payload'],
            t !== 'websocket' && ['preview', 'Preview'], t !== 'websocket' && ['response', 'Response'],
            t === 'websocket' && ['messages', 'Messages'], ['initiator', 'Initiator'], ['timing', 'Timing']].filter(Boolean);
        if (!tabs.some(([key]) => key === tab)) tab = 'headers';
        detailTabs.replaceChildren(icon('close', 'Close (Esc)', () => select(null)),
            ...tabs.map(([key, label]) => h('button', { class: 'tab' + (key === tab ? ' on' : ''), onclick: () => { tab = key; store.set('net.tab', tab); paintDetail(); } }, label)));
        const top = detail.scrollTop;
        detail.replaceChildren(...[({ headers, payload, preview, response, messages, initiator, timing })[tab](r, query)].flat());
        detail.scrollTop = top;
    }

    function headerList(headers) {
        const entries = Object.entries(headers || {});
        if (!entries.length) return h('div', { class: 'v-dim' }, 'None');
        return kv(entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]));
    }

    function headers(r) {
        const status = r.failed ? h('span', null, h('span', { class: 'status-dot bad' }), r.error)
            : r.status != null ? h('span', null, h('span', { class: 'status-dot' + (r.status >= 400 ? ' bad' : r.status >= 300 ? ' redirect' : '') }), `${r.status} ${r.statusText || ''}`) : 'Pending';
        const m = r.metrics || {};
        return [
            section('General', kv([
                ['Request URL', r.url], ['Request Method', r.method], ['Status Code', status],
                m.remoteAddress && ['Remote Address', m.remoteAddress],
                m.protocol && ['Protocol', m.protocol],
                m.priority && ['Priority', m.priority],
                r.source && r.source !== 'network' && ['Served from', r.source],
                m.securityConnection && ['Connection', [m.securityConnection.protocol, m.securityConnection.cipher].filter(Boolean).join(', ')],
            ]), { key: 'net.general' }),
            section('Response Headers', headerList(r.responseHeaders), { key: 'net.response' }),
            section(r.metrics?.requestHeaders ? 'Request Headers' : 'Request Headers (provisional)', headerList(sentHeaders(r)), { key: 'net.request' }),
        ];
    }

    function payload(r, query) {
        const out = [];
        if (query.length) out.push(section('Query String Parameters', kv(query), { key: 'net.query' }));
        if (r.postData != null) {
            const type = Object.entries(r.requestHeaders || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
            const json = parseJSON(r.postData);
            let view;
            if (json !== undefined) view = jsonTree(json, null, true);
            else if (type.includes('x-www-form-urlencoded')) view = kv([...new URLSearchParams(r.postData)]);
            else view = h('pre', { class: 'body' }, r.postData);
            out.push(section('Request Payload', [view, h('div', { style: 'margin-top:6px' }, h('button', { class: 'btn', onclick: () => copy(r.postData) }, 'Copy payload'))], { key: 'net.payload' }));
        }
        return out;
    }

    function preview(r) {
        const box = h('div', null, h('div', { class: 'empty' }, 'Loading…'));
        bodyOf(r).then(b => {
            if (b.error) return box.replaceChildren(h('div', { class: 'empty' }, b.error));
            if (b.base64Encoded && (r.mime || '').startsWith('image/')) return box.replaceChildren(h('img', { class: 'preview-img', src: `data:${r.mime};base64,${b.body}` }));
            if (!b.base64Encoded && (r.mime || '').startsWith('image/svg')) return box.replaceChildren(h('img', { class: 'preview-img', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.body)}` }));
            const json = b.base64Encoded ? undefined : parseJSON(b.body);
            if (json !== undefined) return box.replaceChildren(h('div', { style: 'padding:8px 10px', class: 'mono' }, jsonTree(json, null, true)));
            box.replaceChildren(h('pre', { class: 'body' }, b.base64Encoded ? `Binary data, ${fmtBytes(Math.floor(b.body.length * 3 / 4))}` : b.body.slice(0, 2_000_000)));
        });
        return box;
    }

    function response(r) {
        const box = h('div', null, h('div', { class: 'empty' }, 'Loading…'));
        bodyOf(r).then(b => {
            if (b.error) return box.replaceChildren(h('div', { class: 'empty' }, b.error));
            if (b.base64Encoded) return box.replaceChildren(h('div', { class: 'empty' }, `Binary data, ${fmtBytes(Math.floor(b.body.length * 3 / 4))}`));
            const json = parseJSON(b.body);
            let pretty = store.get('net.pretty', true);
            const pre = h('pre', { class: 'body' });
            const paintBody = () => { pre.textContent = (json !== undefined && pretty ? JSON.stringify(json, null, 2) : b.body).slice(0, 2_000_000); };
            paintBody();
            box.replaceChildren(
                h('div', { class: 'bar sub' },
                    json !== undefined ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: pretty, onchange: e => { pretty = e.target.checked; store.set('net.pretty', pretty); paintBody(); } }), 'Pretty print') : '',
                    h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => copy(b.body) }, 'Copy')),
                pre);
        });
        return box;
    }

    function messages(r) {
        if (!r.frames.length) return h('div', { class: 'empty' }, 'No messages yet.');
        const start = r.start;
        return h('table', { class: 'grid' },
            h('thead', null, h('tr', null, h('th', { style: 'width:28px' }), h('th', null, 'Data'), h('th', { style: 'width:80px' }, 'Length'), h('th', { style: 'width:90px' }, 'Time'))),
            h('tbody', null, r.frames.map(f => h('tr', { title: f.data },
                h('td', { class: f.out ? 'frame-out' : 'frame-in' }, f.out ? '↑' : '↓'),
                h('td', { class: 'mono' }, f.opcode === 2 ? `Binary frame (${f.length} bytes)` : String(f.data).slice(0, 500)),
                h('td', { class: 'num' }, fmtBytes(f.length)),
                h('td', { class: 'num' }, fmtMs((f.time - start) * 1000))))));
    }

    function initiator(r) {
        const i = r.initiator;
        if (!i) return h('div', { class: 'empty' }, 'Nothing recorded the initiator of this request.');
        const stack = i.stackTrace ? (Array.isArray(i.stackTrace) ? i.stackTrace : i.stackTrace.callFrames || []) : [];
        return h('div', { style: 'padding:10px' }, kv([
            ['Type', i.type],
            i.url && ['URL', i.url],
            i.lineNumber != null && ['Line', String(i.lineNumber + 1)],
        ]), stack.length ? h('div', { style: 'margin-top:10px', class: 'mono' }, stack.map(f => h('div', { class: 'stack' }, `${f.functionName || '(anonymous function)'} @ ${f.url}:${f.lineNumber}:${f.columnNumber}`))) : '');
    }

    function timing(r) {
        const t = r.timing;
        const total = durationOf(r);
        const first = Math.min(...order.map(id => requests.get(id)?.start).filter(v => v != null));
        const out = [h('div', { class: 'head' }, `Queued at ${fmtMs((r.start - first) * 1000)}`)];
        const phases = [];
        if (t && t.requestStart >= 0) {
            const end = t.responseEnd > 0 ? t.responseEnd : total;
            const firstOf = (...values) => values.find(v => v >= 0);
            const add = (label, a, b, color) => { if (a >= 0 && b >= a) phases.push([label, a, b, color]); };
            add('Stalled', 0, firstOf(t.domainLookupStart, t.connectStart, t.requestStart), 'var(--fg3)');
            add('DNS lookup', t.domainLookupStart, t.domainLookupEnd, '#2bb3c0');
            add('Initial connection', t.connectStart, t.secureConnectionStart > 0 ? t.secureConnectionStart : t.connectEnd, '#e2a300');
            if (t.secureConnectionStart > 0) add('SSL', t.secureConnectionStart, t.connectEnd, '#9b59d0');
            add('Waiting for server', t.requestStart, t.responseStart, '#35a86b');
            add('Content download', t.responseStart, end, '#4f8cf0');
        }
        const scale = Math.max(1, ...phases.map(p => p[2]), total || 0);
        if (phases.length) out.push(h('div', { class: 'head' }, 'Resource timing'));
        for (const [label, a, b, color] of phases) out.push(
            h('div', null, label),
            h('div', { class: 'track' }, h('span', { style: `left:${a / scale * 100}%;width:${(b - a) / scale * 100}%;background:${color}` })),
            h('div', { class: 'ms' }, fmtMs(b - a)));
        if (!phases.length) out.push(h('div', { style: 'grid-column:1/-1;color:var(--fg2)' }, r.source && r.source !== 'network' ? `Served from ${r.source}.` : 'No detailed timing for this request.'));
        out.push(h('div', { class: 'head' }, `Total ${fmtMs(total)}`));
        return h('div', { class: 'timing' }, out);
    }

    function reload(ignoreCache) { quiet('Page.reload', { ignoreCache }); }

    return {
        el,
        shown: () => paint(),
        focusFilter: () => { filterInput.focus(); filterInput.select(); },
        applyCache: () => quiet('Network.setResourceCachingDisabled', { disabled: noCache }),
        close: () => select(null),
        get open() { return selected != null; },
    };
})();

/* ---------- Storage ---------- */

const storage = (() => {
    let view = null;
    let origins = [];
    let pageOrigin = '';
    let databases = new Map();
    let caches = [];
    let workers = [];

    const nav = h('div', { class: 'nav' });
    const clearButton = h('button', { class: 'btn danger', onclick: () => clearSiteData() }, 'Clear site data');
    const navPane = h('div', null, h('div', { class: 'bar sub' }, icon('reload', 'Refresh', () => refresh()), h('div', { class: 'spacer' }), clearButton), nav);
    const main = h('div');
    const el = h('div', { class: 'panel' }, split(main, navPane, 'storage', 220, { first: true }));

    async function refresh() {
        const tree = await quiet('Page.getResourceTree');
        const set = new Set();
        const walk = node => { if (!node) return; const o = node.frame.securityOrigin; if (o && o !== 'null' && o !== '://') set.add(o); (node.childFrames || []).forEach(walk); };
        walk(tree?.frameTree);
        pageOrigin = tree?.frameTree?.frame?.securityOrigin || '';
        origins = [...set];
        databases = new Map();
        await Promise.all(origins.map(async origin => {
            const result = await quiet('IndexedDB.requestDatabaseNames', { securityOrigin: origin });
            const names = result?.databaseNames || [];
            const dbs = await Promise.all(names.map(async name => (await quiet('IndexedDB.requestDatabase', { securityOrigin: origin, databaseName: name }))?.databaseWithObjectStores || { name, objectStores: [] }));
            databases.set(origin, dbs);
        }));
        caches = await pageCall(async () => {
            if (typeof caches === 'undefined') return [];
            const out = [];
            for (const name of await self.caches.keys()) out.push({ name, count: (await (await self.caches.open(name)).keys()).length });
            return out;
        }).catch(() => []);
        workers = await pageCall(async () => {
            const list = await navigator.serviceWorker?.getRegistrations?.() ?? [];
            return list.map(r => ({ scope: r.scope, script: (r.active || r.waiting || r.installing)?.scriptURL || '', state: (r.active || r.waiting || r.installing)?.state || '' }));
        }).catch(() => []);
        paintNav();
        if (!view && pageOrigin) open({ kind: 'local', origin: pageOrigin });
        else if (view) open(view);
    }

    const same = (a, b) => a && b && a.kind === b.kind && a.origin === b.origin && a.db === b.db && a.store === b.store && a.cache === b.cache;

    function item(label, v, cls = '', sub = '') {
        return h('div', { class: 'nav-item ' + cls + (same(v, view) ? ' on' : ''), title: label, onclick: () => open(v) }, label, sub ? h('span', { class: 'sub' }, sub) : '');
    }

    function paintNav() {
        const top = nav.scrollTop;
        nav.replaceChildren();
        append(nav, [
            h('div', { class: 'nav-group' }, 'Local storage'), origins.map(o => item(o, { kind: 'local', origin: o }, 'indent')),
            h('div', { class: 'nav-group' }, 'Session storage'), origins.map(o => item(o, { kind: 'session', origin: o }, 'indent')),
            h('div', { class: 'nav-group' }, 'Cookies'), pageOrigin ? item(pageOrigin, { kind: 'cookies', origin: pageOrigin }, 'indent') : '',
            h('div', { class: 'nav-group' }, 'IndexedDB'),
            [...databases].map(([origin, dbs]) => dbs.map(db => [
                item(db.name, { kind: 'db', origin, db: db.name }, 'indent', origins.length > 1 ? ' ' + hostOf(origin) : ''),
                (db.objectStores || []).map(s => item(s.name, { kind: 'store', origin, db: db.name, store: s.name }, 'indent2')),
            ])),
            [...databases.values()].every(d => !d.length) ? h('div', { class: 'nav-item indent v-dim' }, 'None') : '',
            h('div', { class: 'nav-group' }, 'Cache storage'),
            caches.length ? caches.map(c => item(c.name, { kind: 'cache', origin: pageOrigin, cache: c.name }, 'indent', ` ${c.count}`)) : h('div', { class: 'nav-item indent v-dim' }, 'None'),
            h('div', { class: 'nav-group' }, 'Service workers'),
            item(workers.length ? `${workers.length} registered` : 'None', { kind: 'workers', origin: pageOrigin }, 'indent'),
        ]);
        nav.scrollTop = top;
    }

    // A table of rows whose cells can be edited in place.
    function grid({ columns, rows, onEdit, onDelete, onAdd, onSelect, onMenu, selectedKey }) {
        let chosen = rows.find(r => r.key === selectedKey) || null;
        const box = h('div', { class: 'scroll', tabindex: '0' });
        const table = h('table', { class: 'grid' },
            h('thead', null, h('tr', null, columns.map(c => h('th', { style: c.width ? `width:${c.width}` : '' }, c.label)))),
            h('tbody', null,
                rows.map(row => {
                    const tr = h('tr', { class: row === chosen ? 'on' : '' }, columns.map(c => {
                        const content = c.render ? c.render(row) : String(row[c.id] ?? '');
                        const td = h('td', { class: (c.cls || '') + ' cell', title: typeof content === 'string' ? content.slice(0, 500) : null }, content);
                        if (c.edit && onEdit) td.addEventListener('dblclick', () => editCell(td, String(row[c.id] ?? ''), value => onEdit(row, c.id, value)));
                        return td;
                    }));
                    tr.row = row;
                    return tr;
                }),
                onAdd ? h('tr', { class: 'add' }, h('td', { colspan: columns.length, ondblclick: () => onAdd() }, 'Double-click to add')) : ''));
        box.append(table);
        const choose = tr => {
            table.querySelector('tr.on')?.classList.remove('on');
            tr?.classList.add('on');
            chosen = tr?.row || null;
            onSelect?.(chosen);
        };
        box.addEventListener('mousedown', event => { const tr = event.target.closest('tr'); if (tr?.row) choose(tr); });
        box.addEventListener('contextmenu', event => {
            const tr = event.target.closest('tr');
            if (!tr?.row) return;
            choose(tr);
            menu(event, [...(onMenu?.(tr.row) || []), onDelete && ['Delete', () => onDelete(tr.row)]]);
        });
        box.addEventListener('keydown', event => {
            if (event.target !== box) return;
            const trs = [...table.querySelectorAll('tbody tr')].filter(tr => tr.row);
            const at = trs.findIndex(tr => tr.row === chosen);
            if ((event.key === 'Delete' || event.key === 'Backspace') && chosen && onDelete) { event.preventDefault(); onDelete(chosen); }
            if (event.key === 'ArrowDown' && trs[at + 1]) { event.preventDefault(); choose(trs[at + 1]); trs[at + 1].scrollIntoView({ block: 'nearest' }); }
            if (event.key === 'ArrowUp' && at > 0) { event.preventDefault(); choose(trs[at - 1]); trs[at - 1].scrollIntoView({ block: 'nearest' }); }
        });
        if (chosen) setTimeout(() => onSelect?.(chosen));
        return box;
    }

    function editCell(td, value, commit) {
        const input = h('input', { value, spellcheck: 'false' });
        const before = [...td.childNodes];
        td.replaceChildren(input);
        input.focus();
        input.select();
        let done = false;
        const finish = keep => {
            if (done) return;
            done = true;
            if (keep && input.value !== value) commit(input.value);
            else td.replaceChildren(...before);
        };
        input.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Enter') finish(true);
            if (event.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
    }

    function valueView(text) {
        const json = parseJSON(text);
        return h('div', { class: 'value-view selectable' }, json !== undefined && typeof json === 'object' ? jsonTree(json, null, true) : h('span', { style: 'white-space:pre-wrap;word-break:break-all' }, text));
    }

    function toolbar(...kids) { return h('div', { class: 'bar sub' }, kids); }

    async function open(v) {
        view = v;
        paintNav();
        const paint = { local: domStorage, session: domStorage, cookies, db: database, store: objectStore, cache: cacheView, workers: workersView }[v.kind];
        main.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
        try { await paint(v); } catch (error) { main.replaceChildren(h('div', { class: 'empty' }, String(error.message || error))); }
    }

    let selectedKey = null;

    async function domStorage(v) {
        const storageId = { securityOrigin: v.origin, isLocalStorage: v.kind === 'local' };
        const result = await cmd('DOMStorage.getDOMStorageItems', { storageId });
        if (!same(v, view)) return;
        const filter = h('input', { class: 'filter', placeholder: 'Filter', spellcheck: 'false' });
        filter.value = v.filter || '';
        const rows = result.entries.map(([key, value]) => ({ key, value }));
        const shown = () => rows.filter(r => !filter.value || (r.key + ' ' + r.value).toLowerCase().includes(filter.value.toLowerCase()));
        const preview = h('div');
        const remove = row => cmd('DOMStorage.removeDOMStorageItem', { storageId, key: row.key }).then(() => open(view));
        const table = () => grid({
            columns: [{ id: 'key', label: 'Key', width: '30%', edit: true, cls: 'mono' }, { id: 'value', label: 'Value', edit: true, cls: 'mono' }],
            rows: shown(),
            selectedKey,
            onSelect: row => { selectedKey = row?.key ?? null; preview.replaceChildren(row ? valueView(row.value) : ''); },
            onEdit: async (row, column, value) => {
                if (column === 'key') { await cmd('DOMStorage.removeDOMStorageItem', { storageId, key: row.key }); await cmd('DOMStorage.setDOMStorageItem', { storageId, key: value, value: row.value }); selectedKey = value; }
                else await cmd('DOMStorage.setDOMStorageItem', { storageId, key: row.key, value });
                open(view);
            },
            onDelete: remove,
            onAdd: async () => {
                let key = 'key';
                for (let i = 1; rows.some(r => r.key === key); i++) key = `key${i}`;
                await cmd('DOMStorage.setDOMStorageItem', { storageId, key, value: '' });
                selectedKey = key;
                open(view);
            },
            onMenu: row => [['Copy key', () => copy(row.key)], ['Copy value', () => copy(row.value)]],
        });
        let tableEl = table();
        filter.addEventListener('input', () => { v.filter = filter.value; const next = table(); tableEl.replaceWith(next); tableEl = next; });
        main.replaceChildren(
            toolbar(icon('reload', 'Refresh', () => open(view)), filter, h('div', { class: 'spacer' }),
                h('span', { class: 'v-dim' }, `${rows.length} item${rows.length === 1 ? '' : 's'}`),
                h('button', { class: 'btn', onclick: () => cmd('DOMStorage.clearDOMStorageItems', { storageId }).then(() => open(view)) }, 'Clear all')),
            tableEl, preview);
    }

    const cookieURL = c => `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;

    async function setCookie(c) {
        await cmd('Page.setCookie', { cookie: {
            name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
            expires: c.session ? 0 : c.expires, session: !!c.session,
            httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'None',
        } });
    }

    async function cookies(v) {
        const result = await cmd('Page.getCookies');
        if (!same(v, view)) return;
        const list = result.cookies.map(c => ({ ...c, key: `${c.name}|${c.domain}|${c.path}` }));
        const filter = h('input', { class: 'filter', placeholder: 'Filter', spellcheck: 'false' });
        filter.value = v.filter || '';
        const preview = h('div');
        const remove = c => cmd('Page.deleteCookie', { cookieName: c.name, url: cookieURL(c) }).then(() => open(view));
        const flag = name => ({ id: name, label: { httpOnly: 'HttpOnly', secure: 'Secure' }[name], width: '70px', render: c => h('input', {
            type: 'checkbox', checked: !!c[name],
            onchange: async e => { c[name] = e.target.checked; await setCookie(c); open(view); },
        }) });
        const table = () => grid({
            columns: [
                { id: 'name', label: 'Name', width: '18%', edit: true, cls: 'mono' },
                { id: 'value', label: 'Value', width: '28%', edit: true, cls: 'mono' },
                { id: 'domain', label: 'Domain', width: '14%', edit: true },
                { id: 'path', label: 'Path', width: '60px', edit: true },
                { id: 'expires', label: 'Expires', width: '150px', render: c => c.session || !c.expires ? 'Session' : new Date(c.expires).toISOString() },
                { id: 'size', label: 'Size', width: '50px', cls: 'num', render: c => String(c.size ?? (c.name.length + c.value.length)) },
                flag('httpOnly'), flag('secure'),
                { id: 'sameSite', label: 'SameSite', width: '74px' },
            ],
            rows: list.filter(c => !filter.value || `${c.name} ${c.value} ${c.domain}`.toLowerCase().includes(filter.value.toLowerCase())),
            selectedKey,
            onSelect: c => { selectedKey = c?.key ?? null; preview.replaceChildren(c ? valueView(c.value) : ''); },
            onEdit: async (c, column, value) => {
                if (column !== 'value') await cmd('Page.deleteCookie', { cookieName: c.name, url: cookieURL(c) });
                const next = { ...c, [column]: value };
                await setCookie(next);
                selectedKey = `${next.name}|${next.domain}|${next.path}`;
                open(view);
            },
            onDelete: remove,
            onAdd: async () => {
                const host = hostOf(pageOrigin);
                await setCookie({ name: 'name', value: 'value', domain: host, path: '/', session: true, secure: pageOrigin.startsWith('https'), sameSite: 'Lax' });
                open(view);
            },
            onMenu: c => [['Copy name', () => copy(c.name)], ['Copy value', () => copy(c.value)], ['Copy as header', () => copy(`${c.name}=${c.value}`)]],
        });
        let tableEl = table();
        filter.addEventListener('input', () => { v.filter = filter.value; const next = table(); tableEl.replaceWith(next); tableEl = next; });
        main.replaceChildren(
            toolbar(icon('reload', 'Refresh', () => open(view)), filter, h('div', { class: 'spacer' }),
                h('span', { class: 'v-dim' }, `${list.length} cookie${list.length === 1 ? '' : 's'}`),
                h('button', { class: 'btn', onclick: async () => { for (const c of list) await quiet('Page.deleteCookie', { cookieName: c.name, url: cookieURL(c) }); open(view); } }, 'Clear all')),
            tableEl, preview);
    }

    const keyPathText = kp => !kp ? '' : kp.type === 'string' ? kp.string : kp.type === 'array' ? `[${kp.array.join(', ')}]` : '';

    async function database(v) {
        const db = (databases.get(v.origin) || []).find(d => d.name === v.db);
        if (!db) return main.replaceChildren(h('div', { class: 'empty' }, 'This database is gone.'));
        main.replaceChildren(
            toolbar(icon('reload', 'Refresh', () => refresh()), h('div', { class: 'spacer' }),
                h('button', { class: 'btn danger', disabled: v.origin !== pageOrigin, title: v.origin !== pageOrigin ? 'Only for the page’s own origin' : null, onclick: () => pageCall(name => new Promise(ok => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => ok(true); }), v.db).then(() => { view = null; refresh(); }) }, 'Delete database')),
            h('div', { class: 'scroll', style: 'padding:10px' },
                kv([['Name', db.name], ['Origin', v.origin], ['Version', String(db.version ?? '')]]),
                h('div', { style: 'height:12px' }),
                h('table', { class: 'grid' },
                    h('thead', null, h('tr', null, h('th', null, 'Object store'), h('th', null, 'Key path'), h('th', null, 'Auto increment'), h('th', null, 'Indexes'))),
                    h('tbody', null, (db.objectStores || []).map(s => h('tr', null,
                        h('td', null, s.name), h('td', { class: 'mono' }, keyPathText(s.keyPath)), h('td', null, s.autoIncrement ? 'Yes' : 'No'),
                        h('td', null, (s.indexes || []).map(i => `${i.name} (${keyPathText(i.keyPath)}${i.unique ? ', unique' : ''})`).join('; '))))))));
    }

    async function objectStore(v) {
        const page = v.page || 0;
        const size = 50;
        const result = await cmd('IndexedDB.requestData', { securityOrigin: v.origin, databaseName: v.db, objectStoreName: v.store, indexName: '', skipCount: page * size, pageSize: size });
        if (!same(v, view)) return;
        const entries = result.objectStoreDataEntries.map((e, i) => ({ ...e, index: page * size + i, key: page * size + i }));
        const preview = h('div');
        const ownOrigin = v.origin === pageOrigin;
        const keyValue = k => k.type === 'number' || k.type === 'string' ? k.value : k.subtype === 'date' ? { date: k.description } : undefined;
        const remove = async e => {
            const key = keyValue(e.primaryKey);
            if (!ownOrigin || key === undefined) return;
            await pageCall((db, store, key) => new Promise((ok, fail) => {
                const k = key && key.date ? new Date(key.date) : key;
                const r = indexedDB.open(db);
                r.onerror = () => fail(r.error);
                r.onsuccess = () => {
                    const tx = r.result.transaction(store, 'readwrite');
                    tx.objectStore(store).delete(k);
                    tx.oncomplete = () => { r.result.close(); ok(true); };
                    tx.onerror = () => fail(tx.error);
                };
            }), v.db, v.store, key);
            open(view);
        };
        main.replaceChildren(
            toolbar(icon('reload', 'Refresh', () => open(view)),
                h('button', { class: 'btn', disabled: page === 0, onclick: () => open({ ...v, page: page - 1 }) }, '‹ Previous'),
                h('button', { class: 'btn', disabled: !result.hasMore, onclick: () => open({ ...v, page: page + 1 }) }, 'Next ›'),
                h('span', { class: 'v-dim' }, `${entries.length ? page * size + 1 : 0}–${page * size + entries.length}`),
                h('div', { class: 'spacer' }),
                h('button', { class: 'btn', onclick: () => cmd('IndexedDB.clearObjectStore', { securityOrigin: v.origin, databaseName: v.db, objectStoreName: v.store }).then(() => open(view)) }, 'Clear object store')),
            grid({
                columns: [
                    { id: 'index', label: '#', width: '44px', cls: 'num' },
                    { id: 'primaryKey', label: 'Key', width: '22%', cls: 'mono', render: e => renderValue(e.primaryKey) },
                    { id: 'value', label: 'Value', cls: 'mono', render: e => renderValue(e.value) },
                ],
                rows: entries,
                onSelect: e => preview.replaceChildren(e ? h('div', { class: 'value-view' }, renderValue(e.value, { open: true })) : ''),
                onDelete: ownOrigin ? remove : null,
            }),
            preview);
    }

    async function cacheView(v) {
        const entries = await pageCall(async name => (await (await caches.open(name)).keys()).slice(0, 1000).map(r => ({ url: r.url, method: r.method })), v.cache);
        if (!same(v, view)) return;
        main.replaceChildren(
            toolbar(icon('reload', 'Refresh', () => open(view)), h('div', { class: 'spacer' }),
                h('button', { class: 'btn danger', onclick: () => pageCall(name => caches.delete(name), v.cache).then(() => { view = null; refresh(); }) }, 'Delete cache')),
            grid({
                columns: [{ id: 'url', label: 'URL', cls: 'mono' }, { id: 'method', label: 'Method', width: '70px' }],
                rows: entries.map(e => ({ ...e, key: e.url })),
                onDelete: e => pageCall((name, url) => caches.open(name).then(c => c.delete(url)), v.cache, e.url).then(() => open(view)),
                onMenu: e => [['Copy URL', () => copy(e.url)]],
            }));
    }

    function workersView() {
        main.replaceChildren(
            toolbar(icon('reload', 'Refresh', () => refresh())),
            workers.length ? grid({
                columns: [
                    { id: 'scope', label: 'Scope', cls: 'mono' },
                    { id: 'script', label: 'Script', cls: 'mono' },
                    { id: 'state', label: 'State', width: '90px' },
                    { id: 'actions', label: '', width: '110px', render: w => h('button', { class: 'btn', onclick: () => pageCall(async scope => { const r = (await navigator.serviceWorker.getRegistrations()).find(x => x.scope === scope); return r ? r.unregister() : false; }, w.scope).then(() => refresh()) }, 'Unregister') },
                ],
                rows: workers.map(w => ({ ...w, key: w.scope })),
            }) : h('div', { class: 'empty' }, 'No service workers are registered for this page.'));
    }

    let armed = null;
    async function clearSiteData() {
        if (!armed) {
            clearButton.textContent = 'Click again to clear';
            armed = setTimeout(() => { armed = null; clearButton.textContent = 'Clear site data'; }, 3000);
            return;
        }
        clearTimeout(armed);
        armed = null;
        clearButton.textContent = 'Clearing…';
        for (const origin of origins) for (const isLocalStorage of [true, false]) await quiet('DOMStorage.clearDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage } });
        const jar = await quiet('Page.getCookies');
        for (const c of jar?.cookies || []) await quiet('Page.deleteCookie', { cookieName: c.name, url: cookieURL(c) });
        await pageCall(async () => {
            for (const d of await indexedDB.databases?.() ?? []) indexedDB.deleteDatabase(d.name);
            if (typeof caches !== 'undefined') for (const name of await caches.keys()) await caches.delete(name);
            for (const r of await navigator.serviceWorker?.getRegistrations?.() ?? []) await r.unregister();
        }).catch(() => {});
        clearButton.textContent = 'Clear site data';
        view = null;
        refresh();
    }

    const refreshView = debounce(() => { if (current === 'storage' && view && (view.kind === 'local' || view.kind === 'session')) open(view); }, 150);
    for (const event of ['domStorageItemsCleared', 'domStorageItemRemoved', 'domStorageItemAdded', 'domStorageItemUpdated']) on('DOMStorage.' + event, refreshView);
    const refreshSoon = debounce(() => { if (current === 'storage') refresh(); }, 300);
    on('Page.frameNavigated', ({ frame }) => { if (!frame.parentId) refreshSoon(); });

    return { el, shown: () => refresh() };
})();

/* ---------- The window ---------- */

const panels = { elements, console: consolePanel, network, storage };
const LABELS = { elements: 'Elements', console: 'Console', network: 'Network', storage: 'Storage' };
let current = null;

const tabs = {};
const errorBadge = h('span', { class: 'badge err', hidden: true, title: 'Errors', onclick: () => show('console') });
const warningBadge = h('span', { class: 'badge warn', hidden: true, title: 'Warnings', onclick: () => show('console') });
let picking = false;
const pickerButton = icon('picker', 'Select an element in the page (⇧⌘C)', () => setPicking(!picking));
const dockButtons = ['bottom', 'right', 'undocked'].map(side => icon(side, { bottom: 'Dock to bottom', right: 'Dock to right', undocked: 'Separate window' }[side], () => InspectorFrontendHost.requestSetDockSide(side)));

function setPicking(on) {
    picking = on;
    pickerButton.classList.toggle('on', on);
    quiet('DOM.setInspectModeEnabled', on ? { enabled: true, highlightConfig: HIGHLIGHT } : { enabled: false });
}

function updateCounts() {
    const { error, warning } = consolePanel?.counts || { error: 0, warning: 0 };
    errorBadge.hidden = !error;
    errorBadge.textContent = '✕ ' + error;
    warningBadge.hidden = !warning;
    warningBadge.textContent = '! ' + warning;
}

function updateDock(side = WI.dockConfiguration) {
    ['bottom', 'right', 'undocked'].forEach((s, i) => dockButtons[i].classList.toggle('on', s === side));
}

function show(name) {
    if (!panels[name]) return;
    current = name;
    for (const [key, panel] of Object.entries(panels)) {
        panel.el.classList.toggle('on', key === name);
        tabs[key].classList.toggle('on', key === name);
    }
    store.set('panel', name);
    panels[name].shown?.();
}

const back = h('button', { id: 'sdt-back', hidden: true, onclick: () => useSafari(false) }, 'Search DevTools');

function useSafari(on) {
    store.set('safari', on);
    root.hidden = on;
    back.hidden = !on;
    document.body.classList.toggle('sdt-on', !on);
    if (on) setPicking(false);
}

function reloadPage(ignoreCache) { quiet('Page.reload', { ignoreCache }); }

const toolbar = h('div', { class: 'bar' },
    pickerButton,
    h('div', { class: 'sep' }),
    Object.keys(panels).map(key => (tabs[key] = h('button', { class: 'tab', onclick: () => show(key) }, LABELS[key]))),
    h('div', { class: 'spacer' }),
    errorBadge, warningBadge,
    h('div', { class: 'sep' }),
    icon('reload', 'Reload the page (⌘R)', () => reloadPage(false)),
    dockButtons,
    icon('more', 'More', event => menu(event, [
        ['Reload page', () => reloadPage(false)],
        ['Reload page without cache', () => reloadPage(true)],
        '-',
        ['Use Safari’s inspector', () => useSafari(true)],
    ])),
    icon('close', 'Close', () => InspectorFrontendHost.closeWindow()));

root.append(toolbar, h('div', { class: 'panels' }, Object.values(panels).map(p => p.el)));

// Keys: these shortcuts first, taken from everything else; then the field
// or panel the key is meant for. WebKit's UI underneath doesn't hear what
// was typed into these tools (the listeners on the tools themselves).
addEventListener('keydown', event => {
    if (root.hidden) return;
    const key = event.key.toLowerCase();
    const where = event.target instanceof Element ? event.target : document.body;
    const command = event.metaKey && !event.ctrlKey && !event.altKey;
    let handled = true;
    if (command && event.shiftKey && key === 'c') setPicking(!picking);
    else if (command && !event.shiftKey && key === 'r') reloadPage(false);
    else if (command && event.shiftKey && key === 'r') reloadPage(true);
    else if (command && key === 'k') consolePanel.clear();
    else if (command && key === 'f') {
        if (current === 'elements') elements.focusFind();
        else if (current === 'console') consolePanel.focusFilter();
        else if (current === 'network') network.focusFilter();
    }
    else if (command && (key === '[' || key === ']')) {
        const keys = Object.keys(panels);
        show(keys[(keys.indexOf(current) + (key === ']' ? 1 : -1) + keys.length) % keys.length]);
    }
    else if (event.key === 'Escape' && openMenu) closeMenu();
    else if (event.key === 'Escape' && picking) setPicking(false);
    else if (event.key === 'Escape' && current === 'network' && network.open && !where.closest('input, textarea')) network.close();
    else handled = false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
}, true);

// Keys, copying, pasting and right-clicks here stay here once handled:
// WebKit's UI listens for them on the document too.
for (const type of ['keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste', 'input']) root.addEventListener(type, event => event.stopPropagation());
root.addEventListener('contextmenu', event => {
    event.stopPropagation();
    const where = event.target instanceof Element ? event.target : root;
    if (!event.defaultPrevented && !where.closest('input, textarea, .selectable, .cell, pre, .msg-body, .kv-value')) event.preventDefault();
});

// What the Mac's menus and keys ask of the inspector arrives here too.
hook('setElementSelectionEnabled', enabled => { picking = enabled; pickerButton.classList.toggle('on', enabled); }, { after: true });
hook('setDockSide', side => updateDock(side), { after: true });
hook('showConsole', () => { if (!root.hidden) { show('console'); consolePanel.focus(); } }, { after: true });
on('Target.didCommitProvisionalTarget', debounce(() => { elements.load(); if (current === 'storage') storage.shown(); }, 100));

window.SearchDevTools = { show, reveal: id => elements.reveal(id) };

async function start() {
    const style = h('style', { id: 'sdt-style' });
    style.textContent = window.__sdtCSS || '';
    document.head.append(style);
    document.body.append(root, back);
    useSafari(store.get('safari', false));
    updateDock();
    updateCounts();
    // A node the inspector was opened onto (Inspect Element) before this
    // script arrived: held as an object, which outlives the node ids that
    // asking for the document again resets.
    let inspected = null;
    const early = WI.domManager?.inspectedNode;
    if (early) inspected = (await quiet('DOM.resolveNode', { nodeId: early.id, objectGroup: 'sdt' }))?.object?.objectId;
    await Promise.all([quiet('CSS.enable'), quiet('DOMStorage.enable'), network.applyCache()]);
    // The console again from the start: WebKit sends what it kept.
    await quiet('Console.disable');
    await quiet('Console.enable');
    await elements.load(inspected);
    show(inspected ? 'elements' : store.get('panel', 'elements'));
}

start();
})();
true;
