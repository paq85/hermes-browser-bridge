// Functions in this file are injected with chrome.scripting.executeScript and
// run in the extension's isolated world of the page. Each must be fully
// self-contained (no references to anything outside its own body).

// Orange frame shown on tabs Hermes is working in. aria-hidden and
// pointer-events:none keep it out of snapshots and out of the way of clicks.
export function pageIndicator(show) {
  const ID = '__hermes_bridge_indicator';
  const el = document.getElementById(ID);
  if (!show) { el?.remove(); return; }
  if (el) return;
  const d = document.createElement('div');
  d.id = ID;
  d.setAttribute('aria-hidden', 'true');
  d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;'
    + 'box-shadow:inset 0 0 0 3px rgba(255,140,0,.85),inset 0 0 18px 2px rgba(255,140,0,.4);';
  document.documentElement.appendChild(d);
}

export function pageViewport() {
  const s = document.scrollingElement || document.documentElement;
  return {
    w: document.documentElement.clientWidth || innerWidth, h: innerHeight, dpr: devicePixelRatio || 1,
    scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
    pos: Math.round(s.scrollTop) + ' of ' + Math.max(0, s.scrollHeight - innerHeight),
  };
}

// Marks the referenced element with a one-off attribute so the debugger side
// (which runs in the page's main world and cannot see our refs) can find it.
export function pageTag(arg) {
  const el = window.__hermesBridge?.map.get(arg.ref)?.deref();
  if (!el || !el.isConnected) return { error: `Element ${arg.ref} no longer exists. Take a new snapshot.` };
  if (arg.remove) { el.removeAttribute('data-hermes-bridge-target'); return { ok: true }; }
  el.setAttribute('data-hermes-bridge-target', arg.token);
  return { ok: true, tag: el.tagName, type: (el.type || '').toLowerCase(), inFrame: el.ownerDocument !== document, inShadow: el.getRootNode() !== el.ownerDocument };
}

export function pageSnapshot(opts) {
  const interactiveOnly = !!opts.interactiveOnly;
  const maxChars = opts.maxChars || 30000;
  const store = (window.__hermesBridge ||= { next: 1, byEl: new WeakMap(), map: new Map() });
  for (const [k, w] of store.map) if (!w.deref()?.isConnected) store.map.delete(k);
  const refOf = (el) => {
    let r = store.byEl.get(el);
    if (!r) { r = 'e' + store.next++; store.byEl.set(el, r); }
    store.map.set(r, new WeakRef(el));
    return r;
  };

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg', 'SVG']);
  const ROLE_BY_TAG = {
    BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', IMG: 'image',
    NAV: 'navigation', MAIN: 'main', FORM: 'form', DIALOG: 'dialog', OPTION: 'option',
  };
  const INTERACTIVE = new Set([
    'button', 'link', 'checkbox', 'radio', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'switch', 'textbox', 'searchbox', 'combobox', 'slider', 'spinbutton',
    'treeitem', 'file-input',
  ]);
  const LEAF = new Set([...INTERACTIVE, 'heading', 'image']);
  const INNER = 'a[href],button,input,select,textarea,[role],[onclick],[tabindex],[contenteditable]';
  const clean = (s, n = 120) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  };
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'hidden') return null;
      return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
        image: 'button', range: 'slider', file: 'file-input' })[t] || 'textbox';
    }
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (/^H[1-6]$/.test(tag)) return 'heading';
    return ROLE_BY_TAG[tag] || null;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE.has(role)) return true;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1') return true;
    const view = el.ownerDocument.defaultView;
    if (view && view.getComputedStyle(el).cursor === 'pointer') {
      const p = el.parentElement;
      return !p || view.getComputedStyle(p).cursor !== 'pointer';
    }
    return false;
  }

  function nameOf(el, useText) {
    const doc = el.ownerDocument;
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (el.labels?.length) return clean(el.labels[0].textContent);
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) return clean(el.value);
    const attr = el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title');
    if (attr) return clean(attr);
    if (useText) return clean(el.textContent);
    return '';
  }

  const out = [];
  let size = 0;
  let truncated = false;
  const emit = (depth, s) => {
    if (truncated) return;
    const line = '  '.repeat(depth) + '- ' + s;
    size += line.length + 1;
    if (size > maxChars) { truncated = true; return; }
    out.push(line);
  };

  function walk(node, depth, noText) {
    if (truncated) return;
    if (node.nodeType === 3) {
      if (!interactiveOnly && !noText) {
        const t = clean(node.nodeValue, 300);
        if (t) emit(depth, 'text ' + JSON.stringify(t));
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true' || !visible(el)) return;

    if (tag === 'IFRAME' || tag === 'FRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch { /* cross-origin */ }
      if (doc?.body) { emit(depth, 'iframe'); walk(doc.body, depth + 1, noText); }
      else {
        // The frame's own outline is collected separately and spliced in by token.
        const tok = store.frameTokens?.get(el);
        emit(depth, (tok ? `iframe [frame=${tok}] ` : 'iframe (contents not readable) ') + clean(el.src, 100));
      }
      return;
    }

    const role = roleOf(el);
    const interactive = isInteractive(el, role);
    let childDepth = depth;
    let childNoText = noText;

    if (interactive || (role && !interactiveOnly)) {
      const leaf = (LEAF.has(role) || (interactive && !role)) && !(el.querySelector(INNER) && role !== 'combobox');
      const name = nameOf(el, leaf && tag !== 'SELECT' && tag !== 'INPUT' && tag !== 'TEXTAREA');
      if (role === 'image' && !name && !interactive) return;
      let line = role || 'clickable';
      if (role === 'heading') line += `(${el.getAttribute('aria-level') || tag[1] || ''})`;
      if (name) line += ' ' + JSON.stringify(name);
      if (interactive) line += ` [ref=${refOf(el)}]`;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const type = (el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') { if (el.checked) line += ' [checked]'; }
        else if (type === 'password') { if (el.value) line += ' value="•••"'; }
        else if (el.value) line += ' value=' + JSON.stringify(clean(el.value, 80));
      } else if (tag === 'SELECT') {
        line += ' value=' + JSON.stringify(clean(el.selectedOptions[0]?.textContent, 60));
        const opts = [...el.options].slice(0, 12).map((o) => clean(o.textContent, 40));
        line += ' options=' + JSON.stringify(opts) + (el.options.length > 12 ? '…' : '');
      } else if (el.isContentEditable && leaf === false) {
        line += ' [editable]';
      }
      if (role === 'link' && el.href) line += ' -> ' + clean(el.href, 90);
      const ac = el.getAttribute('aria-checked');
      if (ac === 'true') line += ' [checked]';
      const ex = el.getAttribute('aria-expanded');
      if (ex) line += ex === 'true' ? ' [expanded]' : ' [collapsed]';
      if (el.getAttribute('aria-selected') === 'true') line += ' [selected]';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' [disabled]';
      emit(depth, line);
      if (leaf || tag === 'SELECT') return;
      childDepth = depth + 1;
      if (interactive && !role) childNoText = false;
    }

    if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c, childDepth, childNoText);
    for (const c of el.childNodes) walk(c, childDepth, childNoText);
  }

  walk(document.body || document.documentElement, 0, false);

  const se = document.scrollingElement || document.documentElement;
  const head = [
    `Page: ${clean(document.title, 200)}`,
    `URL: ${location.href}`,
    `Viewport: ${innerWidth}x${innerHeight}, scrolled ${Math.round(se.scrollTop)} of ${Math.max(0, se.scrollHeight - innerHeight)}px`,
    '',
  ];
  if (!out.length) out.push('(no visible content found)');
  if (truncated) out.push(`… snapshot truncated at ${maxChars} characters. Use interactiveOnly, scroll, or get_text.`);
  return { text: head.concat(out).join('\n'), tokens: store.myFrameTokens || [] };
}

// Scrolls the referenced element into view and returns its centre in
// top-level viewport CSS pixels.
export function pageLocate(ref) {
  const el = window.__hermesBridge?.map.get(ref)?.deref();
  if (!el || !el.isConnected) return { error: `Element ${ref} no longer exists. Take a new snapshot.` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return { error: `Element ${ref} is not visible. Take a new snapshot.` };
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  let w = el.ownerDocument.defaultView;
  while (w && w !== window && w.frameElement) {
    const fr = w.frameElement.getBoundingClientRect();
    x += fr.left + w.frameElement.clientLeft;
    y += fr.top + w.frameElement.clientTop;
    w = w.parent;
  }
  const label = (el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { x: Math.round(x), y: Math.round(y), desc: `<${el.tagName.toLowerCase()}>${label ? ' "' + label + '"' : ''}` };
}

export function pageSetValue(arg) {
  const el = window.__hermesBridge?.map.get(arg.ref)?.deref();
  if (!el || !el.isConnected) return { error: `Element ${arg.ref} no longer exists. Take a new snapshot.` };
  const fire = (t) => el.dispatchEvent(new Event(t, { bubbles: true }));
  const tag = el.tagName;
  const v = arg.value;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (tag === 'SELECT') {
    const want = String(v).trim().toLowerCase();
    const opt = [...el.options].find((o) => o.value === String(v))
      || [...el.options].find((o) => o.textContent.trim().toLowerCase() === want);
    if (!opt) return { error: 'No such option. Available: ' + [...el.options].map((o) => o.textContent.trim()).slice(0, 30).join(' | ') };
    el.value = opt.value; fire('input'); fire('change');
    return { ok: `Selected "${opt.textContent.trim()}"` };
  }
  if (tag === 'INPUT' && /^(checkbox|radio)$/i.test(el.type)) {
    const want = v === true || v === 'true' || v === 'on' || v === 1;
    if (el.checked !== want) el.click();
    return { ok: `Now ${el.checked ? 'checked' : 'unchecked'}` };
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const view = el.ownerDocument.defaultView;
    const p = tag === 'INPUT' ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    el.focus();
    (Object.getOwnPropertyDescriptor(p, 'value') || Object.getOwnPropertyDescriptor(proto, 'value')).set.call(el, String(v));
    fire('input'); fire('change');
    return { ok: 'Value set' };
  }
  if (el.isContentEditable) {
    el.focus();
    const doc = el.ownerDocument;
    doc.getSelection().selectAllChildren(el);
    doc.execCommand('insertText', false, String(v));
    return { ok: 'Text set' };
  }
  return { error: `Element ${arg.ref} is a <${tag.toLowerCase()}>, not a form field. Use click or type instead.` };
}

// Wheel events are not always delivered to background tabs. pageScrollProbe
// remembers the element a wheel at (x, y) should scroll; pageScrollFinish
// scrolls it from script if the wheel had no effect.
export function pageScrollProbe(a) {
  const store = (window.__hermesBridge ||= { next: 1, byEl: new WeakMap(), map: new Map() });
  const root = document.scrollingElement || document.documentElement;
  const hasRoom = (el) => {
    const isRoot = el === root;
    const cs = getComputedStyle(el);
    const ch = isRoot ? innerHeight : el.clientHeight;
    const cw = isRoot ? innerWidth : el.clientWidth;
    if (a.dy && (isRoot || /auto|scroll/.test(cs.overflowY))) {
      if (a.dy > 0 ? el.scrollTop + ch < el.scrollHeight - 1 : el.scrollTop > 0) return true;
    }
    if (a.dx && (isRoot || /auto|scroll/.test(cs.overflowX))) {
      if (a.dx > 0 ? el.scrollLeft + cw < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
    }
    return false;
  };
  let el = document.elementFromPoint(a.x, a.y);
  while (el && el !== root && el !== document.body && !hasRoom(el)) el = el.parentElement || el.getRootNode()?.host || null;
  if (!el || el === document.body) el = root;
  store.scrollTarget = hasRoom(el) ? el : null;
  return store.scrollTarget ? [el.scrollLeft, el.scrollTop] : null;
}

export function pageScrollFinish(a) {
  const el = window.__hermesBridge?.scrollTarget;
  if (el && a.before && el.scrollLeft === a.before[0] && el.scrollTop === a.before[1]) {
    el.scrollBy({ left: a.dx, top: a.dy, behavior: 'instant' });
  }
  const s = document.scrollingElement || document.documentElement;
  return Math.round(s.scrollTop) + ' of ' + Math.max(0, s.scrollHeight - innerHeight);
}

export function pageSelectAllInFocused() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  if (typeof el.select === 'function') { el.select(); return true; }
  if (el.isContentEditable) { el.ownerDocument.getSelection().selectAllChildren(el); return true; }
  return false;
}

export function pageText(maxChars) {
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  let t = (root?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  const total = t.length;
  if (t.length > maxChars) t = t.slice(0, maxChars) + `\n… truncated (${total} characters total)`;
  return `Page: ${document.title}\nURL: ${location.href}\n\n${t}`;
}

// ---- cross-origin frames ---------------------------------------------------
// Each frame is injected separately. A parent cannot see into a cross-origin
// child, so it hands the child a token with postMessage; the child reports the
// tokens it received, which lets the outlines be stitched together and click
// coordinates be translated up the frame chain.

export function pageFramePrep() {
  const store = (window.__hermesBridge ||= { next: 1, byEl: new WeakMap(), map: new Map() });
  let fresh = false;
  if (!store.listening) {
    store.listening = true;
    fresh = true;
    store.myFrameTokens = [];
    window.addEventListener('message', (ev) => {
      const tok = ev.data && ev.data.__hermesBridgeFrame;
      if (typeof tok !== 'string' || !/^f[a-z0-9]{6,12}$/.test(tok)) return;
      let ancestor = false;
      for (let w = window; w !== w.parent;) { w = w.parent; if (ev.source === w) { ancestor = true; break; } }
      if (!ancestor) return;
      ev.stopImmediatePropagation();
      if (!store.myFrameTokens.includes(tok)) store.myFrameTokens.push(tok);
      if (store.myFrameTokens.length > 8) store.myFrameTokens.shift();
    }, true);
  }
  store.frameTokens ||= new WeakMap();
  store.frameEls ||= new Map();
  const visit = (doc) => {
    for (const el of doc.querySelectorAll('iframe, frame')) {
      let sub = null;
      try { sub = el.contentDocument; } catch { /* cross-origin */ }
      if (sub) { visit(sub); continue; }
      let tok = store.frameTokens.get(el);
      if (!tok) {
        tok = 'f' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
        store.frameTokens.set(el, tok);
        store.frameEls.set(tok, new WeakRef(el));
      }
      try { el.contentWindow?.postMessage({ __hermesBridgeFrame: tok }, '*'); } catch { /* detached */ }
    }
  };
  visit(document);
  return { fresh };
}

// Top-left corner of the content box of the iframe that carries `token`, in
// this window's viewport CSS pixels.
export function pageFrameOffset(a) {
  const el = window.__hermesBridge?.frameEls?.get(a.token)?.deref();
  if (!el || !el.isConnected) return null;
  // A click lands in top-level viewport coordinates, so the frame has to be on screen.
  if (a.scroll) {
    const v = el.getBoundingClientRect();
    if (v.top < 0 || v.left < 0 || v.bottom > innerHeight || v.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  const r = el.getBoundingClientRect();
  let x = r.left + el.clientLeft;
  let y = r.top + el.clientTop;
  let w = el.ownerDocument.defaultView;
  while (w && w !== window && w.frameElement) {
    const fr = w.frameElement.getBoundingClientRect();
    x += fr.left + w.frameElement.clientLeft;
    y += fr.top + w.frameElement.clientTop;
    w = w.parent;
  }
  return { x, y };
}

export function pageFrameText(maxChars) {
  if (innerWidth < 2 || innerHeight < 2) return null;
  const t = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  return { url: location.href, text: t.length > maxChars ? t.slice(0, maxChars) + '…' : t };
}

// ---- images ----------------------------------------------------------------
// Gives an image to the page the way a user would: into a file input, as a
// paste, or as a drag-and-drop.
export function pagePutImage(a) {
  const bin = atob(a.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], a.name, { type: a.mimeType });
  const transfer = () => { const dt = new DataTransfer(); dt.items.add(file); return dt; };
  let el;
  if (a.ref) {
    el = window.__hermesBridge?.map.get(a.ref)?.deref();
    if (!el || !el.isConnected) return { error: `Element ${a.ref} no longer exists. Take a new snapshot.` };
  } else if (typeof a.x === 'number' && typeof a.y === 'number') {
    el = document.elementFromPoint(a.x, a.y);
  } else {
    el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  }
  if (!el) el = document.body;
  const what = `${a.name} (${Math.round(bytes.length / 1024)} KB)`;
  if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file' && a.mode === 'auto') {
    el.files = transfer().files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: `Attached ${what} to the file input.` };
  }
  if (a.mode !== 'drop') {
    if (typeof el.focus === 'function') el.focus();
    const ev = new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true, composed: true });
    if (!el.dispatchEvent(ev)) return { ok: `Pasted ${what}; the page accepted it.` };
    if (a.mode === 'paste') return { ok: `Sent a paste of ${what}, but the page did not signal that it handled it. Check with snapshot or screenshot.` };
  }
  const r = el.getBoundingClientRect();
  const init = {
    dataTransfer: transfer(), bubbles: true, cancelable: true, composed: true,
    clientX: typeof a.x === 'number' ? a.x : r.left + r.width / 2,
    clientY: typeof a.y === 'number' ? a.y : r.top + r.height / 2,
  };
  el.dispatchEvent(new DragEvent('dragenter', init));
  const over = el.dispatchEvent(new DragEvent('dragover', init));
  const drop = el.dispatchEvent(new DragEvent('drop', init));
  if (!over || !drop) return { ok: `Dropped ${what}; the page accepted it.` };
  return { ok: `Sent ${a.mode === 'drop' ? 'a drop' : 'a paste and a drop'} of ${what}, but the page did not signal that it handled it. Check with snapshot or screenshot; a file input may be the right target instead.` };
}

// Marks this frame's document so the debugger side can tell which of its
// frame sessions belongs to it (the DOM is shared between script worlds).
export function pageFrameMark(mark) {
  if (mark) document.documentElement.setAttribute('data-hermes-bridge-frame', mark);
  else document.documentElement.removeAttribute('data-hermes-bridge-frame');
  return true;
}

// If viewport point (x, y) is over a cross-origin iframe, returns that frame's
// token and the point in the frame's own coordinates.
export function pageFrameAt(a) {
  const el = document.elementFromPoint(a.x, a.y);
  if (!el || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME')) return null;
  const token = window.__hermesBridge?.frameTokens?.get(el);
  if (!token) return null;
  const r = el.getBoundingClientRect();
  return { token, x: a.x - r.left - el.clientLeft, y: a.y - r.top - el.clientTop };
}
