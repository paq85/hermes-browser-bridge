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
// With retarget, a label, button or wrapper that clearly belongs to one file
// input is swapped for that input, so it can be filled without opening a picker.
export function pageTag(arg) {
  const store = (window.__hermesBridge ||= { next: 1, byEl: new WeakMap(), map: new Map() });
  store.tagged ||= new Map();
  if (arg.remove) {
    store.tagged.get(arg.token)?.deref()?.removeAttribute('data-hermes-bridge-target');
    store.tagged.delete(arg.token);
    return { ok: true };
  }
  const el = store.map.get(arg.ref)?.deref();
  if (!el || !el.isConnected) return { error: `Element ${arg.ref} no longer exists. Take a new snapshot.` };
  const isFile = (x) => !!x && x.tagName === 'INPUT' && (x.type || '').toLowerCase() === 'file';
  const filesIn = (root) => {
    const list = [...root.querySelectorAll('input')].filter(isFile);
    if (root.shadowRoot) list.push(...[...root.shadowRoot.querySelectorAll('input')].filter(isFile));
    return list;
  };
  let target = el;
  let retargeted = false;
  if (arg.retarget && !isFile(el)) {
    let found = null;
    const label = el.tagName === 'LABEL' ? el : el.closest('label');
    if (label && isFile(label.control)) found = label.control;
    if (!found) {
      const inside = filesIn(el);
      if (inside.length === 1) found = inside[0];
    }
    if (!found) {
      for (const id of (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean)) {
        const c = el.ownerDocument.getElementById(id);
        if (isFile(c)) { found = c; break; }
      }
    }
    // Inside a form, a control belongs to the form's only file input.
    if (!found && el.form) {
      const ins = [...el.form.elements].filter(isFile);
      if (ins.length === 1) found = ins[0];
    }
    // An upload button or drop zone usually sits right next to its (hidden)
    // input: the nearest small wrapper, up to 3 levels, that holds exactly one
    // file input. Page sections, forms and the body are too broad to tell.
    if (!found && !el.form) {
      const WRAPPERS = new Set(['DIV', 'SPAN', 'LABEL', 'P', 'LI', 'TD', 'TH', 'FIELDSET']);
      let a = el.parentElement;
      for (let i = 0; i < 3 && a && WRAPPERS.has(a.tagName); i++, a = a.parentElement) {
        const ins = filesIn(a);
        if (ins.length === 1) { found = ins[0]; break; }
        if (ins.length > 1) break;
      }
    }
    if (found) { target = found; retargeted = true; }
  }
  // A form's submit button is not a file picker: clicking it would submit the form.
  const submit = !isFile(target) && !!el.form && (
    (el.tagName === 'BUTTON' && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit')
    || (el.tagName === 'INPUT' && /^(submit|image)$/i.test(el.type)));
  target.setAttribute('data-hermes-bridge-target', arg.token);
  store.tagged.set(arg.token, new WeakRef(target));
  return {
    ok: true, tag: target.tagName, type: (target.type || '').toLowerCase(), isFile: isFile(target), retargeted, submit,
    inFrame: target.ownerDocument !== document, inShadow: target.getRootNode() !== target.ownerDocument,
  };
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
  const visible = (el) => {
    if (!el.checkVisibility || el.checkVisibility({ visibilityProperty: true })) return true;
    // A display: contents box has no layout of its own, but its children do.
    const view = el.ownerDocument.defaultView;
    return !!view && view.getComputedStyle(el).display === 'contents';
  };

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

  // Drop zones: a short "drop files here" text on a box that looks like a
  // target (it holds a file input, has a dashed or dotted border, or is
  // clickable). Marketing copy that merely mentions dragging is left alone.
  const DROP_TEXT = /\b(drop|drag)\b(?!\s*-?down)|przeci[aą]gnij|upu[sś][cć]|glisser|d[ée]poser|\bziehen\b|\bablegen\b|arrastr|soltar/i;
  const dropZones = new Set();
  const looksLikeTarget = (box) => {
    const view = box.ownerDocument.defaultView;
    const cs = view ? view.getComputedStyle(box) : null;
    if (cs && /dashed|dotted/.test(cs.borderTopStyle + cs.borderLeftStyle)) return true;
    if (box.querySelector('input[type=file i]') || box.shadowRoot?.querySelector('input[type=file i]')) return true;
    return !!cs && cs.cursor === 'pointer' || box.getAttribute('role') === 'button' || box.hasAttribute('tabindex');
  };
  const markZone = (start) => {
    const doc = start.ownerDocument;
    let el = start;
    for (let i = 0; i < 5 && el && el !== doc.body && el !== doc.documentElement; i++, el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= 80 && r.height >= 36) {
        for (let b = el, j = 0; j < 2 && b && b !== doc.body; j++, b = b.parentElement) {
          if (looksLikeTarget(b)) { dropZones.add(b); return; }
        }
        return;
      }
    }
  };
  const findZones = (root) => {
    const tw = (root.ownerDocument || root).createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(), seen = 0; n && seen < 50000; n = tw.nextNode(), seen++) {
      const t = n.nodeValue.trim();
      // A drop-zone label stands alone: its element holds little other text (not prose or code).
      const holder = n.parentElement;
      if (t.length >= 4 && t.length <= 80 && DROP_TEXT.test(t) && holder && holder.textContent.trim().length <= 100
        && !holder.closest('pre, code, p > a, nav, li')) markZone(holder);
    }
    for (const el of root.querySelectorAll('[aria-label]')) {
      const t = el.getAttribute('aria-label');
      if (t.length <= 80 && DROP_TEXT.test(t)) markZone(el);
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) findZones(host.shadowRoot);
    for (const fr of root.querySelectorAll('iframe, frame')) {
      let d = null;
      try { d = fr.contentDocument; } catch { /* another origin: that frame scans itself */ }
      if (d?.body) findZones(d.body);
    }
  };
  try { findZones(document.body || document.documentElement); } catch { /* best effort */ }

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

  // File inputs: constraints the agent needs, and what is selected right now.
  const fileInputsShown = new Set();
  function fileDesc(el) {
    let d = '';
    const accept = el.getAttribute('accept');
    if (accept) d += ' accept=' + JSON.stringify(clean(accept, 80));
    if (el.multiple) d += ' [multiple]';
    if (el.hasAttribute('webkitdirectory')) d += ' [folder]';
    const files = el.files ? [...el.files] : [];
    if (files.length) {
      const names = files.slice(0, 5).map((x) => x.name);
      d += ' selected=' + JSON.stringify(names) + (files.length > 5 ? `(+${files.length - 5} more)` : '');
    }
    return d;
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
    let interactive = isInteractive(el, role);
    // Drop zones are often plain boxes with no click handler; give them a ref
    // so files can be dropped on them.
    const dropZone = dropZones.has(el);
    if (dropZone) interactive = true;
    let childDepth = depth;
    let childNoText = noText;

    if (interactive || (role && !interactiveOnly)) {
      const leaf = (LEAF.has(role) || (interactive && !role)) && !(el.querySelector(INNER) && role !== 'combobox');
      let name = nameOf(el, (leaf || tag === 'LABEL' || dropZone) && tag !== 'SELECT' && tag !== 'INPUT' && tag !== 'TEXTAREA');
      // An unlabelled file input shows the browser's own "Choose File" button.
      if (!name && role === 'file-input') name = 'Choose File';
      if (role === 'image' && !name && !interactive) return;
      let line = role || (dropZone ? 'drop-zone' : 'clickable');
      if (role === 'heading') line += `(${el.getAttribute('aria-level') || tag[1] || ''})`;
      if (name) line += ' ' + JSON.stringify(name);
      if (interactive) line += ` [ref=${refOf(el)}]`;
      if (dropZone && line !== 'drop-zone' && !line.startsWith('drop-zone ')) line += ' [drop-zone]';
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const type = (el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') { if (el.checked) line += ' [checked]'; }
        else if (type === 'file') { line += fileDesc(el); fileInputsShown.add(el); }
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

  // Real upload inputs are usually hidden behind a styled button, so the walk
  // above never reaches them. List them separately so upload_file can target
  // them directly (no picker involved).
  const hiddenInputs = [];
  const seenDocs = new Set();
  const collect = (root) => {
    if (!root || seenDocs.has(root) || hiddenInputs.length >= 20) return;
    seenDocs.add(root);
    for (const el of root.querySelectorAll('input[type=file i]')) {
      if (!fileInputsShown.has(el) && hiddenInputs.length < 20) hiddenInputs.push(el);
    }
    for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot);
    for (const fr of root.querySelectorAll('iframe, frame')) {
      let d = null;
      try { d = fr.contentDocument; } catch { /* cross-origin: read from that frame's own snapshot */ }
      if (d) collect(d);
    }
  };
  collect(document);
  if (hiddenInputs.length) {
    // Hidden inputs rarely have a label; the nearest button, label or short
    // visible text usually says what they are for.
    const nearText = (el) => {
      const own = el.closest('label, button, [role=button]');
      if (own) return clean(own.innerText || own.textContent, 60);
      let a = el.parentElement;
      for (let i = 0; i < 3 && a; i++, a = a.parentElement) {
        const t = clean(a.innerText || '', 200);
        if (t) return t.length <= 60 ? t : '';
      }
      return '';
    };
    const lines = hiddenInputs.map((el) => {
      const label = nameOf(el, false) || nearText(el);
      const hint = el.id ? ` id=${JSON.stringify(el.id)}` : el.name ? ` name=${JSON.stringify(el.name)}` : '';
      const state = visible(el) ? 'not shown above' : 'hidden';
      return `- file-input (${state})${label ? ' ' + JSON.stringify(label) : ''} [ref=${refOf(el)}]${fileDesc(el)}${hint}${el.disabled ? ' [disabled]' : ''}`;
    });
    // Always include these, even past the size limit: they are what upload_file needs.
    out.push('', 'Hidden file inputs (pass their ref to upload_file; no file picker opens):', ...lines);
  }

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
    for (const host of doc.querySelectorAll('*')) if (host.shadowRoot) visit(host.shadowRoot);
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
export async function pagePutImage(a) {
  const list = a.files || [{ data: a.data, name: a.name, type: a.mimeType }];
  let total = 0;
  const files = list.map((f) => {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    total += bytes.length;
    const file = new File([bytes], f.name, { type: f.type || '', lastModified: f.lastModified || Date.now() });
    if (f.rel) Object.defineProperty(file, 'webkitRelativePath', { value: f.rel });
    return file;
  });
  const transfer = () => { const dt = new DataTransfer(); for (const file of files) dt.items.add(file); return dt; };
  const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const what = `${files.length === 1 ? files[0].name : files.length + ' files'} (${fmt(total)})`;
  let el;
  if (a.ref) {
    el = window.__hermesBridge?.map.get(a.ref)?.deref();
    if (!el || !el.isConnected) return { error: `Element ${a.ref} no longer exists. Take a new snapshot.` };
  } else if (typeof a.x === 'number' && typeof a.y === 'number') {
    el = document.elementFromPoint(a.x, a.y);
    for (let i = 0; i < 20 && el && el.shadowRoot; i++) {
      const inner = el.shadowRoot.elementFromPoint(a.x, a.y);
      if (!inner || inner === el) break;
      el = inner;
    }
  } else {
    el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  }
  if (!el) el = document.body;
  if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file' && a.mode === 'auto') {
    el.files = transfer().files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: `Attached ${what} to the file input.` };
  }
  // Whether the page reacted: it cancelled the event, or changed the page soon after.
  const watch = () => {
    let changes = 0;
    const mo = new MutationObserver((l) => { changes += l.length; });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    return async () => { await new Promise((r) => setTimeout(r, 400)); mo.disconnect(); return changes > 0; };
  };
  const say = (verb, taken, changed) => {
    if (taken && changed) return `${verb} ${what}; the page took it and updated. Check with snapshot that the file appears where expected.`;
    if (taken) return `${verb} ${what}; the page took the event, but nothing on the page changed yet. Check with snapshot that the file appears.`;
    if (changed) return `${verb} ${what}; the page changed afterwards (it may have taken the file). Check with snapshot.`;
    return `${verb} ${what}, but the page did not react. It may not accept files here; a file input or upload button may be the right target (upload_file without via).`;
  };
  if (a.mode !== 'drop') {
    if (typeof el.focus === 'function') el.focus();
    const done = watch();
    const ev = new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true, composed: true });
    const taken = !el.dispatchEvent(ev);
    const changed = await done();
    if (taken || changed || a.mode === 'paste') return { ok: say('Pasted', taken, changed) };
  }
  const r = el.getBoundingClientRect();
  const cx = typeof a.x === 'number' ? a.x : r.left + r.width / 2;
  const cy = typeof a.y === 'number' ? a.y : r.top + r.height / 2;
  // view and screen coordinates: some libraries (FilePond) locate the drop from them.
  const init = {
    dataTransfer: transfer(), bubbles: true, cancelable: true, composed: true, view: window,
    clientX: cx, clientY: cy, screenX: cx + (window.screenX || 0), screenY: cy + (window.screenY || 0),
  };
  const done = watch();
  el.dispatchEvent(new DragEvent('dragenter', init));
  const over = el.dispatchEvent(new DragEvent('dragover', init));
  const drop = el.dispatchEvent(new DragEvent('drop', init));
  const changed = await done();
  return { ok: say('Dropped', !over || !drop, changed) };
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
  let el = document.elementFromPoint(a.x, a.y);
  // Frames inside shadow DOM: look through each shadow root to the element under the point.
  for (let i = 0; i < 20 && el && el.shadowRoot; i++) {
    const inner = el.shadowRoot.elementFromPoint(a.x, a.y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME')) return null;
  const token = window.__hermesBridge?.frameTokens?.get(el);
  if (!token) return null;
  const r = el.getBoundingClientRect();
  return { token, x: a.x - r.left - el.clientLeft, y: a.y - r.top - el.clientTop };
}

// Watches a drop that the debugger is about to perform: keeps the browser from
// opening a dropped file as a page when nothing on the page accepts it, and
// tells whether the page itself accepted the drop.
export function pageDropGuard(a) {
  const store = (window.__hermesBridge ||= { next: 1, byEl: new WeakMap(), map: new Map() });
  if (a.phase === 'install') {
    store.dropGuard?.off?.();
    const g = { dropped: false, ours: false, event: null, onInput: false, changes: 0 };
    store.dropGuard = g;
    const onFileInput = (e) => {
      const t = e.composedPath ? e.composedPath()[0] : e.target;
      return !!t && t.tagName === 'INPUT' && (t.type || '').toLowerCase() === 'file';
    };
    // A file input fills itself from a drop; elsewhere, keep the browser from
    // opening the dropped file as a page when nothing takes the drop.
    const overBubble = (e) => { if (!e.defaultPrevented && !onFileInput(e)) e.preventDefault(); };
    const dropCapture = (e) => { g.dropped = true; g.event = e; g.onInput = onFileInput(e); };
    const dropBubble = (e) => { if (!e.defaultPrevented && !g.onInput) { g.ours = true; e.preventDefault(); } };
    const mo = new MutationObserver((l) => { if (g.dropped) g.changes += l.length; });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const off = () => {
      removeEventListener('dragover', overBubble);
      removeEventListener('drop', dropCapture, true); removeEventListener('drop', dropBubble);
      mo.disconnect();
    };
    addEventListener('dragover', overBubble);
    addEventListener('drop', dropCapture, true); addEventListener('drop', dropBubble);
    g.off = off;
    setTimeout(off, 15000);
    return true;
  }
  const g = store.dropGuard;
  store.dropGuard = null;
  if (!g) return null;
  g.off();
  return { dropped: g.dropped, handled: !!g.event && g.event.defaultPrevented && !g.ours, onInput: g.onInput, changed: g.changes > 0 };
}

// Runs in the page's own (main) world. Answers the page's next
// showOpenFilePicker() call with the given files, once, then restores the
// original. Pages using the File System Access picker cannot be answered any
// other way.
export function pageFsaShim(files, ttl) {
  const orig = window.showOpenFilePicker;
  if (typeof orig !== 'function') return false;
  const deadline = Date.now() + ttl;
  let pending = files;
  const toFile = (f) => {
    const bin = atob(f.data);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new File([u], f.name, { type: f.type || '', lastModified: f.lastModified || Date.now() });
  };
  const refuse = (what) => async () => {
    throw new DOMException(`${what} is not possible for this file: it was chosen by an automated upload, not from disk.`, 'NotAllowedError');
  };
  const handle = (file) => {
    const proto = typeof FileSystemFileHandle === 'function' ? FileSystemFileHandle.prototype : Object.prototype;
    const h = Object.create(proto);
    Object.defineProperties(h, {
      kind: { value: 'file' }, name: { value: file.name },
      getFile: { value: async () => file },
      queryPermission: { value: async () => 'granted' }, requestPermission: { value: async () => 'granted' },
      isSameEntry: { value: async (o) => o === h },
      createWritable: { value: refuse('Saving') }, createSyncAccessHandle: { value: refuse('Saving') },
      move: { value: refuse('Moving') }, remove: { value: refuse('Deleting') }, getUniqueId: { value: refuse('Identifying') },
    });
    return h;
  };
  const restore = () => { if (window.showOpenFilePicker === shim) window.showOpenFilePicker = orig; };
  const shim = async function showOpenFilePicker(opts) {
    // Only once, only within the window, and only right after a click.
    const active = !navigator.userActivation || navigator.userActivation.isActive;
    if (!pending || Date.now() > deadline || !active) return orig.call(window, opts);
    const picked = opts && opts.multiple ? pending : pending.slice(0, 1);
    pending = null;
    restore();
    document.documentElement.setAttribute('data-hermes-fsa', JSON.stringify(picked.map((f) => f.name)));
    return picked.map((f) => handle(toFile(f)));
  };
  window.showOpenFilePicker = shim;
  setTimeout(() => { restore(); pending = null; }, ttl);
  return true;
}

export function pageFsaUsed() {
  const v = document.documentElement.getAttribute('data-hermes-fsa');
  if (!v) return null;
  document.documentElement.removeAttribute('data-hermes-fsa');
  try { return JSON.parse(v); } catch { return []; }
}
