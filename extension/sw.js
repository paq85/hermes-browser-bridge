import {
  pageSnapshot, pageLocate, pageSetValue, pageSelectAllInFocused, pageText,
  pageScrollProbe, pageScrollFinish, pageIndicator, pageViewport, pageTag,
  pageFramePrep, pageFrameOffset, pageFrameText, pagePutImage, pageFrameMark, pageFrameAt,
  pageDropGuard, pageFsaShim, pageFsaUsed,
} from './page-fns.js';
import { siteKey, matchRule } from './sites.js';
import { encodeGif } from './gif.js';

// The debugger (and the browser's "started debugging" bar that comes with it)
// is only attached for what truly needs it: real mouse/keyboard input,
// screenshots, running page JavaScript, console/network capture, dialogs and
// file uploads. Reading pages, finding elements, filling fields, scrolling and
// navigating use ordinary script injection and show no bar.
const DETACH_IDLE_MS = 15_000;        // release the debugger this long after its last use
const TRACKING_IDLE_MS = 5 * 60_000;  // ...unless network capture or a recording is on for the tab
const INDICATOR_IDLE_MS = 30_000;
const PROMPT_WAIT_MS = 45_000;        // how long one tool call waits for the user's answer
const MAX_CONSOLE = 200;
const MAX_NETWORK = 300;
const MAX_FRAMES = 40;                // sub-frames read per page
const GIF_MAX_FRAMES = 80;
const GIF_MAX_WIDTH = 800;
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connection-bound state. It is deliberately in memory: it is only meaningful
// while the socket is open, and the bridge's pings keep this worker alive for
// exactly that long. Anything that must outlive the worker is in chrome.storage.
let ws = null;
let authed = false;
let lastShot = null;           // most recent screenshot, for upload_image
const sessions = new Map();    // tabId -> debugger session { ready, console, net, dialog, lastUse, busy, tracking }
const indicators = new Map();  // tabId -> time of Hermes' last command on that tab
const frameInfo = new Map();   // tabId -> Map(frameId -> { token, ownerFrameId }) from the last snapshot
const recordings = new Map();  // tabId -> { on, frames: [{ data, pt }], dropped }
const prompts = new Map();     // host -> { promise, resolve, windowId }

// ---------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => { start(); });
chrome.runtime.onStartup.addListener(() => { start(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); });
setInterval(() => { sweep(); }, 5000);
start();

async function start() {
  try {
    await releaseOrphans();
    if (!(await chrome.alarms.get('tick'))) await chrome.alarms.create('tick', { periodInMinutes: 0.5 });
    await connect();
  } catch (e) {
    console.warn('start failed', e);
  }
}

async function tick() {
  await connect();
  await sweep();
}

async function sweep() {
  const now = Date.now();
  for (const [tabId, s] of sessions) {
    const openPicker = s.fc?.pending && !s.fc.pending.done && s.fc.pending.intercepted && Date.now() - s.fc.pending.at < PENDING_TTL_MS;
    const limit = s.tracking || recordings.get(tabId)?.on || openPicker ? TRACKING_IDLE_MS : DETACH_IDLE_MS;
    if (s.busy || s.dialog || now - s.lastUse < limit) continue;
    sessions.delete(tabId);
    try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  }
  for (const [tabId, t] of indicators) {
    if (now - t < INDICATOR_IDLE_MS || sessions.has(tabId)) continue;
    indicators.delete(tabId);
    setIndicator(tabId, false);
  }
}

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  return enabled;
}

async function updateBadge() {
  try {
    const enabled = await isEnabled();
    await chrome.action.setBadgeText({ text: !enabled ? 'OFF' : prompts.size ? '?' : authed ? 'ON' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: !enabled ? '#6e7781' : prompts.size ? '#bf8700' : '#1a7f37' });
  } catch { /* badge is cosmetic */ }
}

// --------------------------------------------------------------- connection

async function hmac(token, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function connect() {
  if (ws || !(await isEnabled())) { await updateBadge(); return; }
  let cfg;
  try {
    cfg = await (await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' })).json();
  } catch {
    await updateBadge();
    return; // bridge has not written config.json yet; retried on the next tick
  }
  // A plugin update replaces the files on disk; pick the new version up
  // ourselves so the user does not have to press reload on the extensions page.
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    if (disk.version && disk.version !== chrome.runtime.getManifest().version && !sessions.size) {
      chrome.runtime.reload();
      return;
    }
  } catch { /* mid-update; try again on the next tick */ }
  if (ws) return;
  const sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/extension`);
  ws = sock;
  const nonce = crypto.randomUUID();
  sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', nonce, version: chrome.runtime.getManifest().version }));
  sock.onmessage = (ev) => { onSocketMessage(sock, cfg, nonce, ev.data); };
  sock.onerror = () => { /* onclose follows */ };
  sock.onclose = async () => {
    if (ws !== sock) return;
    ws = null;
    const wasConnected = authed;
    authed = false;
    await releaseAll();
    await updateBadge();
    // Another bridge instance usually takes over the port right away; try once
    // now rather than waiting for the next 30 s tick.
    if (wasConnected) setTimeout(() => { connect(); }, 1500);
  };
}

// Tools after which a frame is added to a running recording.
const RECORDED = new Set(['navigate', 'click', 'hover', 'drag', 'type', 'press_key', 'scroll', 'scroll_to', 'set_value', 'upload_file', 'upload_image', 'handle_dialog']);

async function onSocketMessage(sock, cfg, nonce, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  try {
    if (m.type === 'hello_ack') {
      // Mutual proof of the shared token: the bridge proves itself first.
      if (m.proof !== (await hmac(cfg.token, 'bridge:' + nonce))) { sock.close(); return; }
      sock.send(JSON.stringify({ type: 'auth', proof: await hmac(cfg.token, 'ext:' + m.nonce) }));
    } else if (m.type === 'ready') {
      authed = true;
      await updateBadge();
    } else if (m.type === 'ping') {
      sock.send(JSON.stringify({ type: 'pong' }));
    } else if (m.id && m.method && authed) {
      let reply;
      try {
        if (!(await isEnabled())) throw new Error('The Hermes Browser Bridge extension is switched off by the user.');
        const fn = HANDLERS[m.method];
        if (!fn) throw new Error(`Unknown method ${m.method}. The extension may be older than the plugin: reload it on the browser's extensions page.`);
        const ctx = {}; // per-call scratch: the resolved tab and click point, for recordings
        const callStart = Date.now();
        const result = await fn(m.params || {}, ctx);
        if (RECORDED.has(m.method) && recordings.get(ctx.tabId)?.on) await recordFrame(ctx.tabId, ctx.pt).catch(() => {});
        if (ctx.tabId != null && sessions.has(ctx.tabId)) {
          // Most pickers open at once; give ones opened after an await a moment.
          const lp = livePending(ctx.tabId);
          if (!(lp && lp.at >= callStart) && (sessions.get(ctx.tabId)?.fc?.armedUntil || 0) > Date.now() && /^(click|press_key|type|evaluate)$/.test(m.method)) await sleep(150);
          const note = await chooserNotice(ctx.tabId).catch(() => '');
          if (note && result && typeof result === 'object') result.text = (result.text ? result.text + '\n\n' : '') + note;
        }
        reply = { id: m.id, result };
      } catch (e) {
        reply = { id: m.id, error: String(e?.message || e) };
      }
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
    }
  } catch (e) {
    console.warn('message handling failed', e);
  }
}

// --------------------------------------------------------- site permissions

async function siteState() {
  const { siteMode = 'ask', sites = {} } = await chrome.storage.local.get(['siteMode', 'sites']);
  const { sessionSites = {} } = await chrome.storage.session.get('sessionSites');
  return { siteMode, sites, sessionSites };
}

// 'allow' | 'deny' | 'ask' for a URL, without prompting.
function siteVerdict(url, st) {
  const host = siteKey(url);
  if (!host) return 'allow';
  const rule = matchRule(st.sites, host);
  if (rule === 'deny') return 'deny';
  if (st.siteMode === 'all' || rule === 'allow' || matchRule(st.sessionSites, host) === 'allow') return 'allow';
  return 'ask';
}

function askUser(host) {
  let p = prompts.get(host);
  if (!p) {
    p = {};
    p.promise = new Promise((r) => { p.resolve = r; });
    prompts.set(host, p);
    updateBadge();
    chrome.windows.create({
      url: chrome.runtime.getURL('permission.html') + '?host=' + encodeURIComponent(host),
      type: 'popup', width: 470, height: 360, focused: true,
    }).then((w) => { p.windowId = w.id; }, () => { prompts.delete(host); p.resolve('dismissed'); });
  }
  return Promise.race([p.promise, sleep(PROMPT_WAIT_MS).then(() => 'timeout')]);
}

async function ensureSite(url) {
  const host = siteKey(url);
  if (!host) return;
  const blocked = `The user has blocked Hermes from ${host}. Do not retry or work around it; tell the user.`;
  let verdict = siteVerdict(url, await siteState());
  if (verdict === 'ask') {
    const answer = await askUser(host);
    if (answer === 'timeout') throw new Error(`Waiting for the user: a permission prompt for ${host} is open in their browser. Tell the user to answer it, then try again.`);
    if (answer === 'block') throw new Error(blocked);
    if (answer !== 'always' && answer !== 'session' && answer !== 'allowed') throw new Error(`The user declined to let Hermes use ${host}. Do not retry or work around it; tell the user.`);
    verdict = 'allow';
  }
  if (verdict === 'deny') throw new Error(blocked);
}

// Switches between asking per site and allowing every site. Prompts that are
// open when "all" is chosen are answered with yes, so waiting calls go ahead.
async function setSiteMode(mode) {
  await chrome.storage.local.set({ siteMode: mode });
  if (mode !== 'all') return;
  for (const [host, p] of [...prompts]) {
    prompts.delete(host);
    p.resolve('allowed');
    if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
  }
  await updateBadge();
}

async function settlePrompt(host, decision) {
  if (decision === 'all') { await setSiteMode('all'); return; }
  if (decision === 'always' || decision === 'block') {
    const { sites = {} } = await chrome.storage.local.get('sites');
    sites[host] = decision === 'always' ? 'allow' : 'deny';
    await chrome.storage.local.set({ sites });
  } else if (decision === 'session') {
    const { sessionSites = {} } = await chrome.storage.session.get('sessionSites');
    sessionSites[host] = 'allow';
    await chrome.storage.session.set({ sessionSites });
  }
  const p = prompts.get(host);
  prompts.delete(host);
  if (p) {
    p.resolve(decision);
    if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
  }
  await updateBadge();
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [host, p] of prompts) {
    if (p.windowId !== windowId) continue;
    prompts.delete(host);
    p.resolve('dismissed');
    updateBadge();
  }
});

// ------------------------------------------------- script injection (no bar)

const RESTRICTED = 'This tab cannot be controlled (browser-internal page, extension store, or another extension\'s page). Navigate it to a normal web page or use tab_new.';

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function callFn(tabId, fn, arg, frameId = 0) {
  let res;
  try {
    [res] = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fn, args: [arg ?? null], world: 'ISOLATED' }),
      15000,
      'The page did not respond. It may still be loading, or a JavaScript dialog may be open (try handle_dialog).',
    );
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Cannot access|cannot be scripted|chrome:\/\/|edge:\/\/|extensions gallery|error page/i.test(msg)) throw new Error(RESTRICTED);
    if (/No frame with id|Frame with ID .* was removed/i.test(msg) && frameId !== 0) throw new Error('That embedded frame no longer exists. Take a new snapshot.');
    throw e;
  }
  return res?.result;
}

function setIndicator(tabId, show) {
  chrome.scripting.executeScript({ target: { tabId }, func: pageIndicator, args: [show], world: 'ISOLATED' }).catch(() => {});
}

// ------------------------------------------------------------------- frames

// Refs inside an embedded cross-origin frame look like "f12.e5".
function parseRef(ref) {
  const m = /^f(\d+)\.(e\d+)$/.exec(String(ref));
  return m ? { frameId: Number(m[1]), ref: m[2] } : { frameId: 0, ref: String(ref) };
}

async function subFrames(tabId) {
  const found = new Map();
  // Injecting into every frame is the most reliable listing: it reports
  // exactly the frames that can be scripted, also on pages restored from the
  // back/forward cache, where the navigation API can come back empty.
  try {
    const res = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageFrameUrl, world: 'ISOLATED' }), 8000, 'frame listing timed out');
    for (const r of res || []) if (r.frameId !== 0 && typeof r.result === 'string') found.set(r.frameId, { frameId: r.frameId, url: r.result });
  } catch { /* fall back to the navigation API below */ }
  if (!found.size) {
    try {
      for (const f of (await chrome.webNavigation.getAllFrames({ tabId })) || []) {
        if (f.frameId !== 0 && !f.errorOccurred) found.set(f.frameId, { frameId: f.frameId, url: f.url || '' });
      }
    } catch { /* no sub-frames known */ }
  }
  return [...found.values()].filter((f) => /^(https?|file):/.test(f.url)).slice(0, MAX_FRAMES);
}

function pageFrameUrl() { return location.href; }

// The page outline with cross-origin frames spliced in where their iframe sits.
async function fullSnapshot(tabId, opts) {
  const frames = await subFrames(tabId);
  if (!frames.length) {
    frameInfo.delete(tabId);
    return (await callFn(tabId, pageSnapshot, opts)).text;
  }
  const ids = [0, ...frames.map((f) => f.frameId)];
  const inAll = (fn, arg) => Promise.all(ids.map((frameId) => callFn(tabId, fn, arg, frameId).then((v) => ({ frameId, v }), () => ({ frameId, v: null }))));
  // Tokens can only be received once a frame is listening, so a first-time
  // frame needs the hand-out repeated.
  if ((await inAll(pageFramePrep)).some((p) => p.v?.fresh)) await inAll(pageFramePrep);
  await sleep(40);
  const snaps = await inAll(pageSnapshot, opts);
  const top = snaps.find((s) => s.frameId === 0);
  if (!top?.v) return (await callFn(tabId, pageSnapshot, opts)).text; // surfaces the real error
  const byToken = new Map();
  for (const s of snaps) if (s.v && s.frameId !== 0) for (const t of s.v.tokens || []) byToken.set(t, s);
  const info = new Map();
  const render = (s, indent, isTop) => {
    const out = [];
    for (let line of s.v.text.split('\n').slice(isTop ? 0 : 4)) {
      if (!isTop) line = line.replace(/\[ref=(e\d+)\]/g, `[ref=f${s.frameId}.$1]`);
      const m = /^(\s*)- iframe \[frame=(\w+)\] ?(.*)$/.exec(line);
      if (!m) { out.push(indent + line); continue; }
      const child = byToken.get(m[2]);
      if (!child || info.has(child.frameId)) { out.push(`${indent}${m[1]}- iframe (contents not readable) ${m[3]}`); continue; }
      info.set(child.frameId, { token: m[2], ownerFrameId: s.frameId });
      out.push(`${indent}${m[1]}- iframe ${m[3]}`);
      out.push(...render(child, indent + m[1] + '  ', false));
    }
    return out;
  };
  let text = render(top, '', true).join('\n');
  frameInfo.set(tabId, info);
  // Every frame's list of file inputs not shown in the outline is gathered at
  // the end, and kept even when the outline is cut: upload_file needs those refs.
  const fileLines = [];
  text = text.split('\n').filter((line) => {
    const t = line.trim();
    if (t.startsWith('Hidden file inputs (')) return false;
    if (/^- file-input \((hidden|not shown above)\)/.test(t)) { fileLines.push(t); return false; }
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const max = opts.maxChars || 30000;
  if (text.length > max) text = text.slice(0, max) + `\n… snapshot truncated at ${max} characters. Use interactiveOnly, find, or get_text.`;
  if (fileLines.length) text += '\n\nHidden file inputs (pass their ref to upload_file; no file picker opens):\n' + fileLines.join('\n');
  return text;
}

// Element position in top-level viewport CSS pixels, whichever frame it is in.
async function locate(tabId, fullRef, fn = pageLocate) {
  const { frameId, ref } = parseRef(fullRef);
  const r = await callFn(tabId, fn, ref, frameId);
  if (!r || r.error) throw new Error(r?.error || 'Could not locate element');
  if (frameId !== 0) r.frame = { id: frameId, x: r.x, y: r.y }; // the point in the frame's own coordinates
  for (let fid = frameId; fid !== 0;) {
    const inf = frameInfo.get(tabId)?.get(fid);
    const off = inf && await callFn(tabId, pageFrameOffset, { token: inf.token, scroll: fn === pageLocate }, inf.ownerFrameId);
    if (!off) throw new Error('The page\'s embedded frames changed. Take a new snapshot.');
    r.x = Math.round(r.x + off.x);
    r.y = Math.round(r.y + off.y);
    fid = inf.ownerFrameId;
  }
  return r;
}

// ------------------------------------------------- debugger (shows the bar)

function ensureAttached(tabId) {
  let s = sessions.get(tabId);
  if (s) { s.lastUse = Date.now(); return s.ready; }
  s = {
    console: [], net: new Map(), dialog: null, ready: null, lastUse: Date.now(), busy: 0, tracking: false,
    children: new Map(),      // debugger sessionId -> info, one per out-of-process (cross-site) frame
    frameSessions: new Map(), // extension frameId -> sessionId
  };
  s.ready = (async () => {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/already attached/i.test(msg)) {
        sessions.delete(tabId);
        if (/chrome:\/\/|edge:\/\/|chrome-extension:\/\/|Cannot access|Cannot attach/i.test(msg)) throw new Error(RESTRICTED);
        throw new Error('Could not attach to tab: ' + msg);
      }
    }
    // Runtime.enable replays the page's stored console messages, so console
    // history is available even though we attach late.
    for (const [method, params] of [
      // enableFileChooserOpenedEvent reports pickers without blocking them. Every
      // Page.enable must pass it: a plain Page.enable switches it off again.
      ['Page.enable', { enableFileChooserOpenedEvent: true }], ['Runtime.enable', {}], ['Emulation.setFocusEmulationEnabled', { enabled: true }],
      // Cross-site frames run in their own process. In a background tab the
      // browser does not route mouse input into them, so we get a session per
      // frame and send input there directly.
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
    ]) {
      try { await chrome.debugger.sendCommand({ tabId }, method, params); } catch { /* best effort */ }
    }
  })();
  sessions.set(tabId, s);
  return s.ready;
}

async function cdp(tabId, method, params = {}, timeoutMs = 15000, sessionId = undefined) {
  await ensureAttached(tabId);
  if (grantsActivation(method, params)) await armChooser(tabId);
  const s = sessions.get(tabId);
  const hint = s?.dialog ? ` A JavaScript ${s.dialog.type} dialog is open ("${s.dialog.message}"); call handle_dialog first.` : '';
  if (s) s.busy++;
  try {
    return await withTimeout(chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params), timeoutMs, `${method} timed out.${hint}`);
  } finally {
    if (s) { s.busy--; s.lastUse = Date.now(); }
  }
}

// The debugger session of an embedded cross-site frame, or null if it has none
// (same-process frames are reached through the tab's own session).
async function frameSession(tabId, frameId) {
  await ensureAttached(tabId);
  const s = sessions.get(tabId);
  if (!s) return null;
  const known = s.frameSessions.get(frameId);
  if (known && s.children.has(known)) return known;
  for (let i = 0; i < 4 && !s.children.size; i++) await sleep(60); // attach events follow the attach
  if (!s.children.size) return null;
  const mark = 'm' + crypto.randomUUID();
  await callFn(tabId, pageFrameMark, mark, frameId);
  try {
    for (const sid of s.children.keys()) {
      try {
        const r = await withTimeout(chrome.debugger.sendCommand({ tabId, sessionId: sid }, 'Runtime.evaluate',
          { expression: 'document.documentElement.getAttribute("data-hermes-bridge-frame")', returnByValue: true }), 3000, 'no answer');
        if (r?.result?.value === mark) {
          s.frameSessions.set(frameId, sid);
          chrome.debugger.sendCommand({ tabId, sessionId: sid }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
          return sid;
        }
      } catch { /* that frame went away */ }
    }
  } finally {
    callFn(tabId, pageFrameMark, null, frameId).catch(() => {});
  }
  return null;
}

// Where to send input for a located point: the frame's own session with
// frame-local coordinates when it has one, else the tab with top-level ones.
async function inputTarget(tabId, pt) {
  if (pt.frame) {
    const sid = await frameSession(tabId, pt.frame.id);
    if (sid) return { sid, x: pt.frame.x, y: pt.frame.y };
  }
  return { sid: undefined, x: pt.x, y: pt.y };
}

// ------------------------------------------------------------ file pickers
//
// When Hermes clicks something that opens a file picker, the system dialog
// would appear on the user's screen and Hermes could not operate it. Instead,
// file-picker interception is switched on for a short window around each of
// Hermes' own input actions (a picker can only open within 5 s of the input
// that triggers it), and off again straight after. The picker is then
// reported to Hermes, which fills it with upload_file. Pickers the user opens
// outside that window are never touched.

const CHOOSER_WINDOW_MS = 5300;
const PENDING_TTL_MS = 2 * 60_000;
let pickerSeq = 0;
const sidKey = (sid) => sid || 'top';
const dbgTarget = (tabId, sid) => (sid ? { tabId, sessionId: sid } : { tabId });

function grantsActivation(method, params) {
  if (method === 'Input.dispatchMouseEvent') return params.type === 'mousePressed' || params.type === 'mouseReleased';
  if (method === 'Input.dispatchKeyEvent' || method === 'Input.insertText') return true;
  return (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') && !!params.userGesture;
}

function fcState(s) {
  return (s.fc ||= { armedUntil: 0, armedSids: new Set(), timer: null, pending: null, waiters: [] });
}

async function armChooser(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  const fc = fcState(s);
  fc.armedUntil = Date.now() + CHOOSER_WINDOW_MS;
  const sids = [undefined, ...s.children.keys()].filter((sid) => !fc.armedSids.has(sidKey(sid)));
  await Promise.all(sids.map(async (sid) => {
    fc.armedSids.add(sidKey(sid));
    try {
      await withTimeout(chrome.debugger.sendCommand(dbgTarget(tabId, sid), 'Page.setInterceptFileChooserDialog', { enabled: true }), 3000, 'timeout');
    } catch {
      fc.armedSids.delete(sidKey(sid)); // that frame is gone
    }
  }));
  clearTimeout(fc.timer);
  fc.timer = setTimeout(() => { disarmChooser(tabId, fc); }, Math.max(50, fc.armedUntil - Date.now() + 50));
}

function disarmChooser(tabId, which) {
  const fc = sessions.get(tabId)?.fc;
  if (!fc || (which && which !== fc)) return;
  clearTimeout(fc.timer);
  fc.timer = null;
  fc.armedUntil = 0;
  for (const k of fc.armedSids) {
    chrome.debugger.sendCommand(dbgTarget(tabId, k === 'top' ? undefined : k), 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  fc.armedSids.clear();
}

function livePending(tabId) {
  const p = sessions.get(tabId)?.fc?.pending;
  if (!p || Date.now() - p.at > PENDING_TTL_MS) return null;
  return p;
}

// After an upload to an explicit target succeeds, an older unanswered picker
// is stale: it must not be filled later by an upload_file without a target.
function retireStalePickers(tabId, keepId) {
  const p = livePending(tabId);
  if (p && p.id !== keepId && !p.done) { p.done = true; p.reported = true; }
}

function waitChooser(tabId, since, ms) {
  const s = sessions.get(tabId);
  if (!s) return Promise.resolve(null);
  const fc = fcState(s);
  if (fc.pending && fc.pending.at >= since) return Promise.resolve(fc.pending);
  return new Promise((resolve) => {
    const done = (p) => { clearTimeout(t); resolve(p); };
    const t = setTimeout(() => { fc.waiters = fc.waiters.filter((w) => w !== done); resolve(null); }, ms);
    fc.waiters.push(done);
  });
}

// Runs a function on a page element held by the debugger (by backendNodeId or objectId).
async function callOnNode(tabId, sid, node, fnDecl, args = []) {
  let objectId = node.objectId;
  if (!objectId) {
    let r;
    try {
      r = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node.backendNodeId, objectGroup: 'hermes-upload' }, 15000, sid);
    } catch (e) { throw uploadError(e); }
    objectId = r?.object?.objectId;
    if (!objectId) throw new Error(STALE_NODE);
  }
  const r = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration: fnDecl, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
  }, 60000, sid);
  if (r.exceptionDetails) throw new Error('Page script error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown'));
  return r.result?.value;
}

function releaseUploadObjects(tabId, sid) {
  if (sessions.has(tabId)) cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: 'hermes-upload' }, 5000, sid).catch(() => {});
}

const STALE_NODE = 'The upload input was removed or re-created by the page (common after each upload). Call upload_file again with the Upload button\'s ref.';
const FILE_ACCESS = 'FILE_ACCESS_DENIED: "Allow access to file URLs" is off for Hermes Browser Bridge, so files cannot be passed by path.';

function uploadError(e) {
  const msg = String(e?.message || e);
  if (/Not allowed/i.test(msg)) return new Error(FILE_ACCESS);
  if (/No node (found )?with given (backend )?id|No node found for given backend id|Could not find node/i.test(msg)) return new Error(STALE_NODE);
  if (/Node is not a file input element/i.test(msg)) return new Error('That element is not a file input. Pass the Upload button\'s ref instead (it is clicked and the picker is answered), or via: "drop" for a drop zone.');
  return e instanceof Error ? e : new Error(msg);
}

// The bridge resends some uploads with the files' contents; the picker id in
// the message makes that retry go to the same picker and nowhere else.
function withPickerId(e, id) {
  const msg = String(e?.message || e);
  const m = /^(FILE_ACCESS_DENIED|FOLDER_BY_CONTENT)(:)/.exec(msg);
  return m ? new Error(`${m[1]}#${id}${msg.slice(m[1].length)}`) : e;
}

async function fileAccessAllowed() {
  try {
    const { simulateNoFileAccess } = await chrome.storage.local.get('simulateNoFileAccess');
    if (simulateNoFileAccess) return false;
    if (chrome.extension?.isAllowedFileSchemeAccess) return await chrome.extension.isAllowedFileSchemeAccess();
  } catch { /* unknown: let the browser decide */ }
  return true;
}

// Files may only go to a frame whose own site the user allows (an embedded
// frame from another site can be a different company's widget).
async function ensureFrameSite(tabId, where) {
  let url = '';
  try {
    if (where.sid) {
      const r = await cdp(tabId, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true }, 5000, where.sid);
      url = r?.result?.value || '';
    } else if (where.frameId) {
      url = (await chrome.webNavigation.getFrame({ tabId, frameId: where.frameId }))?.url || '';
    }
  } catch { /* the frame is gone; nothing will be delivered to it */ }
  if (url) await ensureSite(url);
}

const INPUT_INFO_FN = `function () {
  const file = this.tagName === 'INPUT' && (this.type || '').toLowerCase() === 'file';
  let disabled = !!this.disabled;
  try { disabled = disabled || this.matches(':disabled'); } catch (e) {}
  return { file, disabled, multiple: !!this.multiple, dir: !!(this.hasAttribute && this.hasAttribute('webkitdirectory')),
    accept: this.getAttribute ? (this.getAttribute('accept') || '') : '', connected: !!this.isConnected,
    id: this.id || '', name: this.name || '', label: (this.labels && this.labels[0] ? this.labels[0].textContent : (this.getAttribute && this.getAttribute('aria-label')) || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
}`;
const INPUT_FILES_FN = 'function () { return [...this.files].map((f) => ({ name: f.name, size: f.size, rel: f.webkitRelativePath || "" })); }';
const INPUT_BYTES_FN = `function (files) {
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.data); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const file = new File([u], f.name, { type: f.type || '', lastModified: f.lastModified || Date.now() });
    // Folder uploads: pages read each file's path inside the chosen folder from this.
    if (f.rel) Object.defineProperty(file, 'webkitRelativePath', { value: f.rel });
    dt.items.add(file);
  }
  this.files = dt.files;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}`;

function acceptWarning(accept, files) {
  const rules = String(accept || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return '';
  const ok = (f) => rules.some((r) => (r.startsWith('.') ? f.name.toLowerCase().endsWith(r)
    : r.endsWith('/*') ? (f.type || '').toLowerCase().startsWith(r.slice(0, -1)) : (f.type || '').toLowerCase() === r));
  const bad = files.filter((f) => !f.isDir && !ok(f)).map((f) => f.name);
  return bad.length ? ` Note: the input asks for ${accept}; ${bad.join(', ')} may be rejected by the page.` : '';
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// Puts files into a file input the debugger holds: by path (the browser reads
// them from disk, any size, trusted events) or, when the extension may not
// read local files, by content (bytes sent along by the bridge).
async function setFilesOn(tabId, sid, node, p) {
  try {
    const info = await callOnNode(tabId, sid, node, INPUT_INFO_FN);
    if (!info?.file) throw new Error('That element is not a file input. Pass the Upload button\'s ref instead, or via: "drop" for a drop zone.');
    if (info.disabled) throw new Error('This file input is disabled: the page is not accepting files there right now. A person could not choose files here either.');
    const files = p.files || [];
    if (!files.length) throw new Error('paths is required: absolute paths of the files to upload.');
    if (info.dir) {
      if (files.length !== 1 || !files[0].isDir) throw new Error('This is a folder upload. Pass exactly one folder path.');
    } else {
      if (files.some((f) => f.isDir)) throw new Error('This input takes files, not folders. Pass file paths.');
      if (!info.multiple && files.length > 1) throw new Error(`This input accepts only one file; you passed ${files.length}. Pass one path.`);
    }
    // Clearing first makes re-selecting the same file count as a change.
    await callOnNode(tabId, sid, node, 'function () { this.value = ""; }');
    if (p.bytes) {
      await callOnNode(tabId, sid, node, INPUT_BYTES_FN, [p.bytes]);
    } else {
      try {
        await cdp(tabId, 'DOM.setFileInputFiles', { files: files.map((f) => f.path), ...node }, 60000, sid);
      } catch (e) { throw uploadError(e); }
    }
    // Folder contents are listed asynchronously after the call returns.
    const readBack = async (tries) => {
      let list = [];
      for (let i = 0; i < tries; i++) {
        list = (await callOnNode(tabId, sid, node, INPUT_FILES_FN)) || [];
        if (list.length) break;
        await sleep(100);
      }
      return list;
    };
    const got = await readBack(info.dir && !p.bytes ? 15 : 1);
    if (info.dir && !p.bytes && !got.length && files[0].children?.length) {
      // The browser does not list a folder handed over by an extension; the
      // bridge resends the folder's files by content, with their paths.
      throw new Error('FOLDER_BY_CONTENT: folder not listed by the browser.');
    }
    const shown = got.slice(0, 8).map((f) => `${f.rel || f.name} (${fmtSize(f.size)})`).join(', ');
    const where = info.label ? ` "${info.label}"` : info.id ? ` #${info.id}` : info.name ? ` [name=${info.name}]` : '';
    return `The file input${where} now holds ${got.length} file(s): ${shown}${got.length > 8 ? ', …' : ''}.`
      + (info.connected ? '' : ' (The input is not part of the page; the page reads it from its own code.)')
      + acceptWarning(info.accept, files)
      + (p.bytes ? (p.bytesReason === 'folder' ? ' The folder\'s files were passed by content (up to 25 MB).' : ' Passed by content because "Allow access to file URLs" is off.') : '');
  } finally {
    releaseUploadObjects(tabId, sid);
  }
}

function deepFindExpression(token) {
  return `(() => {
    const sel = '[data-hermes-bridge-target="${token}"]';
    const seen = new Set();
    const find = (root) => {
      if (!root || seen.has(root)) return null;
      seen.add(root);
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const h = find(el.shadowRoot); if (h) return h; }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let d = null; try { d = el.contentDocument; } catch (e) {}
          if (d) { const h = find(d); if (h) return h; }
        }
      }
      return null;
    };
    return find(document);
  })()`;
}

function findTaggedNode(n, token) {
  if (!n) return null;
  const a = n.attributes || [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === 'data-hermes-bridge-target' && a[i + 1] === token) return n.backendNodeId;
  for (const c of [...(n.children || []), ...(n.shadowRoots || []), n.contentDocument, n.templateContent].filter(Boolean)) {
    const hit = findTaggedNode(c, token);
    if (hit) return hit;
  }
  return null;
}

// Resolves a snapshot ref to the debugger session and node of its file input,
// following a label, a wrapper, a sibling or aria-controls to the input.
// Works in same-site and cross-site frames and in shadow DOM. Returns { tag }
// only when no file input belongs to the element.
async function resolveFileInput(tabId, fullRef) {
  const { frameId, ref } = parseRef(fullRef);
  const token = crypto.randomUUID();
  const tag = await callFn(tabId, pageTag, { ref, token, retarget: true }, frameId);
  if (!tag || tag.error) throw new Error(tag?.error || 'Could not locate element');
  try {
    if (!tag.isFile) return { tag, frameId };
    const sid = frameId === 0 ? undefined : (await frameSession(tabId, frameId)) || undefined;
    const r = await cdp(tabId, 'Runtime.evaluate', { expression: deepFindExpression(token), returnByValue: false, objectGroup: 'hermes-upload' }, 15000, sid);
    if (r?.result?.objectId) return { tag, frameId, sid, node: { objectId: r.result.objectId } };
    // Closed shadow roots and same-site frames of another origin: search the full DOM tree instead.
    const doc = await cdp(tabId, 'DOM.getDocument', { depth: -1, pierce: true }, 30000, sid);
    const backendNodeId = findTaggedNode(doc?.root, token);
    cdp(tabId, 'DOM.disable', {}, 5000, sid).catch(() => {});
    if (backendNodeId) return { tag, frameId, sid, node: { backendNodeId } };
    throw new Error('Could not reach that file input. Take a new snapshot and try again, or pass the Upload button\'s ref.');
  } finally {
    callFn(tabId, pageTag, { token, remove: true }, frameId).catch(() => {});
  }
}

async function describePending(tabId, p) {
  if (!p.intercepted) {
    return 'The page opened the system file picker in this tab, outside your own actions (probably the user). You cannot operate it; leave it to the user.';
  }
  if (!p.backendNodeId) {
    return 'The page tried to open its File System Access file picker. It was blocked and the page treated it as cancelled. To upload, call upload_file with the same ref (or x/y) and paths; the picker is then answered with your files.';
  }
  let what = p.mode === 'selectMultiple' ? 'several files allowed' : 'one file';
  try {
    const info = await callOnNode(tabId, p.sid, { backendNodeId: p.backendNodeId }, INPUT_INFO_FN);
    if (info?.dir) what = 'a folder';
    if (info?.accept) what += `, accept=${JSON.stringify(info.accept)}`;
  } catch { /* the input may be gone already */ } finally { releaseUploadObjects(tabId, p.sid); }
  return `A file picker opened (${what}). No system dialog is showing. Call upload_file with paths (no ref needed) to choose the files, or upload_file with cancel: true to dismiss it.`;
}

// A note about a picker that opened since Hermes last heard about one.
async function chooserNotice(tabId) {
  const p = livePending(tabId);
  if (!p || p.reported) return '';
  p.reported = true;
  return describePending(tabId, p);
}

// The page's File System Access picker can only be answered from inside the
// page. The one-shot answer goes into every frame of the tab whose site the
// user allows (the clicked element may sit in a same-site frame).
async function injectFsaShim(tabId, files) {
  const st = await siteState();
  let frames = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch { /* top frame only */ }
  const ids = frames.filter((f) => f.frameId === 0 || siteVerdict(f.url || '', st) === 'allow').map((f) => f.frameId);
  if (!ids.length) ids.push(0);
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: ids }, world: 'MAIN', func: pageFsaShim, args: [files, CHOOSER_WINDOW_MS] });
    return res.filter((r) => r.result).length;
  } catch {
    return 0;
  }
}

async function fsaUsed(tabId) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageFsaUsed, world: 'ISOLATED' });
    return res.map((r) => r.result).find((v) => Array.isArray(v)) || null;
  } catch {
    return null;
  }
}

// Clicks an element the way a user would, with picker interception on, and
// returns the picker it opened (or null).
async function armedClick(tabId, pt) {
  const since = Date.now();
  await doClick(tabId, pt);
  return waitChooser(tabId, since, CHOOSER_WINDOW_MS);
}

async function guardAll(tabId, phase) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageDropGuard, args: [{ phase }], world: 'ISOLATED' });
    return res.map((r) => r.result).filter((v) => v && typeof v === 'object');
  } catch {
    return [];
  }
}

async function dropFiles(tabId, p) {
  // Dropping onto a file input itself is choosing files for it.
  if (p.ref) {
    const r = await resolveFileInput(tabId, p.ref);
    if (r.node && !r.tag.retargeted) {
      await ensureFrameSite(tabId, { frameId: r.frameId, sid: r.sid });
      return 'That is a file input, so the files were chosen for it directly. ' + await setFilesOn(tabId, r.sid, r.node, p);
    }
  }
  const pt = await pointFor(tabId, p);
  const t = await inputTarget(tabId, pt);
  const frameId = p.ref ? parseRef(p.ref).frameId : pt.frame ? pt.frame.id : 0;
  await ensureFrameSite(tabId, { frameId, sid: t.sid });
  const where = pt.desc ? ` on ${pt.desc}` : ` at (${pt.x}, ${pt.y})`;
  const n = (p.files || []).length;
  if (p.bytes) {
    const local = p.ref ? { ref: parseRef(p.ref).ref } : pt.frame ? { x: pt.frame.x, y: pt.frame.y } : { x: pt.x, y: pt.y };
    const r = await callFn(tabId, pagePutImage, { ...local, mode: 'drop', files: p.bytes }, frameId);
    if (!r || r.error) throw new Error(r?.error || 'Could not drop the files');
    return r.ok + ' (Passed by content because "Allow access to file URLs" is off.)';
  }
  const tab0 = await chrome.tabs.get(tabId);
  const tabsBefore = new Set((await chrome.tabs.query({})).map((x) => x.id));
  await guardAll(tabId, 'install');
  const data = { items: [], files: p.files.map((f) => f.path), dragOperationsMask: 1 | 2 | 16 };
  try {
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp(tabId, 'Input.dispatchDragEvent', { type, x: t.x, y: t.y, data }, 15000, t.sid);
    }
  } catch (e) {
    cdp(tabId, 'Input.dispatchDragEvent', { type: 'dragCancel', x: t.x, y: t.y, data }, 5000, t.sid).catch(() => {});
    guardAll(tabId, 'result');
    throw uploadError(e);
  }
  await sleep(500);
  const gs = await guardAll(tabId, 'result');
  const g = {
    dropped: gs.some((x) => x.dropped), handled: gs.some((x) => x.handled),
    onInput: gs.some((x) => x.onInput), changed: gs.some((x) => x.changed),
  };
  // Safety net: if nothing took the drop, the browser may open the file as a page.
  const opened = (await chrome.tabs.query({})).filter((x) => !tabsBefore.has(x.id) && /^file:/i.test(x.url || x.pendingUrl || ''));
  for (const x of opened) chrome.tabs.remove(x.id).catch(() => {});
  const now = await chrome.tabs.get(tabId).catch(() => null);
  let navigated = false;
  if (now && /^file:/i.test(now.url || now.pendingUrl || '') && !/^file:/i.test(tab0.url || '')) {
    navigated = true;
    await chrome.tabs.goBack(tabId).catch(() => {});
  }
  if (opened.length || navigated) return `Dropped ${n} file(s)${where}, but nothing on the page took them, so the browser tried to open the file itself (undone). This is probably not a drop zone.`;
  if (g.onInput) return `Dropped ${n} file(s) onto a file input${where}; the browser fills it. Check with snapshot (selected=…).`;
  if (g.handled && g.changed) return `Dropped ${n} file(s)${where}; the page accepted the drop and updated. Check with snapshot that the files appear.`;
  if (g.handled) return `Dropped ${n} file(s)${where}; the page took the drop event but nothing on the page changed. Some pages catch drops everywhere; this may not be a drop zone for files. Check with snapshot.`;
  if (g.dropped) return `Dropped ${n} file(s)${where}, but nothing on the page accepted the drop (it is probably not a drop zone). Check with snapshot.`;
  return `Dropped ${n} file(s)${where}; the page did not report receiving them. Check with snapshot.`;
}

// Fills a picker that is waiting (opened by an earlier click, or by the first
// attempt of this upload), and only that picker.
async function fillPending(tabId, p, id) {
  const c = livePending(tabId);
  if (!c || c.id !== id || c.done || !c.intercepted || !c.backendNodeId) {
    throw new Error('The file picker from before is no longer open (the page moved on, or it was answered). Call upload_file again with the Upload button\'s ref.');
  }
  await ensureFrameSite(tabId, { sid: c.sid });
  c.done = true;
  c.reported = true;
  try {
    const text = await setFilesOn(tabId, c.sid, { backendNodeId: c.backendNodeId }, p);
    retireStalePickers(tabId, c.id);
    return { text };
  } catch (e) {
    c.done = false; // still open: the agent can correct the call and try again
    if (/^(FILE_ACCESS_DENIED|FOLDER_BY_CONTENT)/.test(String(e.message))) throw withPickerId(e, c.id);
    throw e;
  }
}

async function uploadFile(p, ctx) {
  const tabId = await resolveTab(p, ctx);
  const files = p.files || [];

  if (p.cancel) {
    const c = livePending(tabId);
    if (!c || c.done || !c.backendNodeId || !c.intercepted) return { text: 'No file picker is waiting.' };
    c.done = true;
    c.reported = true;
    await callOnNode(tabId, c.sid, { backendNodeId: c.backendNodeId }, 'function () { this.dispatchEvent(new Event("cancel", { bubbles: true })); }').catch(() => {});
    releaseUploadObjects(tabId, c.sid);
    return { text: 'Dismissed the file picker without choosing files.' };
  }

  if (p.clear) {
    if (!p.ref) throw new Error('ref of the file input is required with clear.');
    const r = await resolveFileInput(tabId, p.ref);
    if (!r.node) throw new Error('That element is not a file input and has no file input of its own. Pass the file input\'s ref (snapshots list hidden ones under "Hidden file inputs").');
    await callOnNode(tabId, r.sid, r.node, 'function () { this.value = ""; this.dispatchEvent(new Event("input", { bubbles: true, composed: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }');
    releaseUploadObjects(tabId, r.sid);
    return { text: 'Cleared the file input.' };
  }

  if (!files.length) throw new Error('paths is required: absolute paths of the files to upload.');
  const via = p.via || 'auto';
  if (!['auto', 'input', 'chooser', 'drop', 'paste'].includes(via)) throw new Error('via must be auto, input, chooser, drop or paste.');

  // A retry the bridge makes with the files' contents goes to the very picker
  // its first attempt opened, never to another one.
  if (p.retryPicker) return fillPending(tabId, p, p.retryPicker);

  if (via === 'paste') {
    if (!p.bytes) throw new Error('Internal: paste needs file contents from the bridge.');
    if (p.ref) {
      const r = await resolveFileInput(tabId, p.ref);
      if (r.node && !r.tag.retargeted) {
        await ensureFrameSite(tabId, { frameId: r.frameId, sid: r.sid });
        return { text: 'That is a file input, so the files were chosen for it directly. ' + await setFilesOn(tabId, r.sid, r.node, { ...p, bytesReason: 'paste' }) };
      }
    }
    const { frameId, ref } = p.ref ? parseRef(p.ref) : { frameId: 0, ref: null };
    await ensureFrameSite(tabId, { frameId });
    const r = await callFn(tabId, pagePutImage, { ref, x: p.x, y: p.y, mode: 'paste', files: p.bytes }, frameId);
    if (!r || r.error) throw new Error(r?.error || 'Could not paste the files');
    return { text: r.ok };
  }

  // Path-based uploads need the "Allow access to file URLs" switch; without it
  // the bridge resends the call with the files' contents.
  if (!p.bytes && !p.fsaFiles && !(await fileAccessAllowed())) throw new Error(FILE_ACCESS);

  if (via === 'drop') {
    if (!p.ref && typeof p.x !== 'number') throw new Error('ref (or x and y) of the drop zone is required with via: "drop".');
    const text = await dropFiles(tabId, p);
    retireStalePickers(tabId);
    return { text };
  }

  // No target: answer the picker an earlier click opened.
  if (!p.ref && typeof p.x !== 'number') {
    const c = livePending(tabId);
    if (c && !c.done && c.intercepted && c.backendNodeId) return fillPending(tabId, p, c.id);
    throw new Error('No file picker is open. Pass ref: either the file input (snapshots list hidden ones too) or the Upload button, which is then clicked and its picker answered.');
  }

  // The element is a file input, or clearly belongs to one: fill it directly.
  let tag = null;
  if (p.ref && via !== 'chooser') {
    const r = await resolveFileInput(tabId, p.ref);
    tag = r.tag;
    if (r.node) {
      await ensureFrameSite(tabId, { frameId: r.frameId, sid: r.sid });
      const text = await setFilesOn(tabId, r.sid, r.node, p);
      retireStalePickers(tabId);
      return { text };
    }
    if (via === 'input') throw new Error(`Element ${p.ref} is not a file input and has no file input of its own. Use the default via to click it and answer its picker.`);
  }
  if (tag?.submit) {
    throw new Error(`${p.ref} is a form's submit button, not a file picker button: clicking it would submit the form. Give upload_file the form's file input first (snapshots list hidden ones under "Hidden file inputs"), then submit.`);
  }

  // Anything else is clicked like a user would, and the picker it opens is answered.
  const pt = await pointFor(tabId, p);
  ctx.pt = pt;
  const before = (await chrome.tabs.get(tabId)).url;
  const shim = p.fsaFiles ? await injectFsaShim(tabId, p.fsaFiles) : 0;
  const c = await armedClick(tabId, pt);
  if (shim) {
    const used = await fsaUsed(tabId);
    if (used) {
      const unused = p.fsaFiles.map((f) => f.name).filter((n) => !used.includes(n));
      retireStalePickers(tabId);
      return {
        text: `Answered the page's File System Access picker with ${used.join(', ')}.`
          + (unused.length ? ` The page asked for one file, so ${unused.join(', ')} ${unused.length === 1 ? 'was' : 'were'} not used.` : '')
          + ' (Passed by content; the page cannot save back to these files.)',
      };
    }
  }
  if (!c) {
    const now = await chrome.tabs.get(tabId).catch(() => null);
    const moved = now && (now.url !== before || now.status === 'loading');
    const warned = (sessions.get(tabId)?.console || []).slice(-10).some((m) => /only be shown with a user activation/i.test(m.text));
    throw new Error(`Clicked ${pt.desc || `(${pt.x}, ${pt.y})`} but no file picker opened.`
      + (moved ? ` The click navigated the page${now.url !== before ? ` (now ${now.url})` : ''}; it was probably a link or a submit button, not an upload control.` : '')
      + (warned ? ' The page tried to open one too late after the click (browsers allow 5 seconds).' : '')
      + (moved ? '' : ' It may open a menu first (take a snapshot and choose e.g. "Upload from computer"), it may be a drop zone (use via: "drop"), or its file input may be listed under "Hidden file inputs" in a snapshot (pass that ref).'));
  }
  if (!c.intercepted) {
    c.reported = true;
    throw new Error('The click opened the system file dialog, which could not be captured; it is showing on the user\'s screen. Ask the user to choose the file there or to close it.');
  }
  if (!c.backendNodeId) {
    c.reported = true;
    if (p.fsaFiles) throw new Error('The page opened a File System Access folder or save picker (or captured the file picker before the answer was ready); an extension cannot answer those. If the page also has a drop zone or a regular upload input, use that.');
    throw new Error('FSA_PICKER: the page uses the File System Access picker.');
  }
  return fillPending(tabId, p, c.id);
}

// After an extension restart, debugger sessions from before it may still be
// attached (with picker interception possibly on). Release them.
async function releaseOrphans() {
  try {
    const targets = await chrome.debugger.getTargets();
    for (const t of targets) {
      if (t.attached && t.tabId != null && !sessions.has(t.tabId)) chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
    }
  } catch { /* nothing to release */ }
}

async function releaseAll() {
  const ids = [...sessions.keys()];
  sessions.clear();
  for (const tabId of ids) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  }
  for (const tabId of indicators.keys()) setIndicator(tabId, false);
  indicators.clear();
  recordings.clear();
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  const fc = sessions.get(source.tabId)?.fc;
  if (fc) { clearTimeout(fc.timer); for (const w of fc.waiters.splice(0)) w(null); }
  sessions.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  sessions.delete(tabId); indicators.delete(tabId); frameInfo.delete(tabId); recordings.delete(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (!s) return;
  if (method === 'Target.attachedToTarget') {
    if (params.targetInfo?.type === 'iframe') {
      s.children.set(params.sessionId, { url: params.targetInfo.url });
      // Pickers inside a cross-site frame are reported by that frame's own session.
      const t = { tabId: source.tabId, sessionId: params.sessionId };
      chrome.debugger.sendCommand(t, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      chrome.debugger.sendCommand(t, 'Page.enable', { enableFileChooserOpenedEvent: true }).then(async () => {
        const fc = s.fc;
        if (!fc || fc.armedUntil <= Date.now()) return;
        fc.armedSids.add(params.sessionId);
        await chrome.debugger.sendCommand(t, 'Page.setInterceptFileChooserDialog', { enabled: true });
        // The window may have closed while this was being switched on.
        if (fc.armedUntil <= Date.now() || !fc.armedSids.has(params.sessionId)) {
          fc.armedSids.delete(params.sessionId);
          chrome.debugger.sendCommand(t, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
        }
      }).catch(() => {});
    }
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    s.children.delete(params.sessionId);
    for (const [fid, sid] of s.frameSessions) if (sid === params.sessionId) s.frameSessions.delete(fid);
    s.fc?.armedSids.delete(params.sessionId);
    if (s.fc?.pending?.sid === params.sessionId) s.fc.pending = null;
    return;
  }
  if (method === 'Page.fileChooserOpened') {
    const fc = fcState(s);
    const sid = source.sessionId;
    const intercepted = fc.armedSids.has(sidKey(sid));
    fc.pending = { id: 'p' + (++pickerSeq), sid, frameId: params.frameId, mode: params.mode, backendNodeId: params.backendNodeId, intercepted, at: Date.now(), reported: false, done: !intercepted };
    if (intercepted) disarmChooser(source.tabId);
    for (const w of fc.waiters.splice(0)) w(fc.pending);
    return;
  }
  if (method === 'Page.frameNavigated' && !source.sessionId && !params.frame?.parentId && s.fc) {
    s.fc.pending = null;
  }
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ');
    s.console.push({ level: params.type, text: text.slice(0, 2000) });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails || {};
    s.console.push({ level: 'error', text: (d.exception?.description || d.text || 'Uncaught exception').slice(0, 2000) });
  } else if (method === 'Page.javascriptDialogOpening') {
    s.dialog = { type: params.type, message: String(params.message || '').slice(0, 500) };
  } else if (method === 'Page.javascriptDialogClosed') {
    s.dialog = null;
  } else if (method === 'Network.requestWillBeSent') {
    s.net.set(params.requestId, { method: params.request?.method, url: params.request?.url, type: params.type, status: null });
    if (s.net.size > MAX_NETWORK) s.net.delete(s.net.keys().next().value);
  } else if (method === 'Network.responseReceived') {
    const r = s.net.get(params.requestId);
    if (r) r.status = params.response?.status;
  } else if (method === 'Network.loadingFailed') {
    const r = s.net.get(params.requestId);
    if (r) r.status = 'failed: ' + (params.errorText || 'error');
  }
  if (s.console.length > MAX_CONSOLE) s.console.splice(0, s.console.length - MAX_CONSOLE);
});

// ------------------------------------------------------------------ helpers

async function resolveTab(p, ctx) {
  let id = p.tabId;
  if (id == null) {
    const { lastTabId } = await chrome.storage.session.get('lastTabId');
    if (lastTabId != null) {
      try { await chrome.tabs.get(lastTabId); id = lastTabId; } catch { /* closed */ }
    }
  }
  if (id == null) {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    id = t?.id;
  }
  if (id == null) throw new Error('No tab available. Call tab_new first.');
  const tab = await chrome.tabs.get(id); // throws a clear error for a bad id
  await ensureSite(tab.pendingUrl || tab.url || '');
  await chrome.storage.session.set({ lastTabId: id });
  indicators.set(id, Date.now());
  setIndicator(id, true);
  if (ctx) ctx.tabId = id;
  return id;
}

async function evaluate(tabId, expression, timeoutMs = 15000) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, timeoutMs);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('Page script error: ' + (d.exception?.description || d.text || 'unknown'));
  }
  return r.result;
}

async function waitForLoad(tabId, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  await sleep(150);
  while (Date.now() < end) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    if (tab.status === 'complete') return tab;
    await sleep(150);
  }
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}

async function settleAfterInput(tabId) {
  await sleep(250);
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'loading') await waitForLoad(tabId, 10000);
}

async function pointFor(tabId, p, prefix = '') {
  const ref = p[prefix ? prefix + 'Ref' : 'ref'];
  const x = p[prefix ? prefix + 'X' : 'x'];
  const y = p[prefix ? prefix + 'Y' : 'y'];
  if (ref) {
    const r = await locate(tabId, ref);
    await sleep(50);
    return r;
  }
  if (typeof x === 'number' && typeof y === 'number') {
    const pt = { x, y, desc: '' };
    // A point picked from a screenshot may lie over a cross-site frame.
    const at = await callFn(tabId, pageFrameAt, { x, y }).catch(() => null);
    if (at) {
      for (const [fid, inf] of frameInfo.get(tabId) || []) {
        if (inf.token === at.token && inf.ownerFrameId === 0) pt.frame = { id: fid, x: at.x, y: at.y };
      }
    }
    return pt;
  }
  const names = prefix ? `${prefix}Ref, or ${prefix}X and ${prefix}Y` : 'ref (from snapshot), or both x and y';
  throw new Error(`Provide ${names}.`);
}

async function mouse(tabId, type, x, y, extra = {}, sessionId = undefined) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra }, 15000, sessionId);
}

async function doClick(tabId, pt, { button = 'left', count = 1 } = {}) {
  const t = await inputTarget(tabId, pt);
  await mouse(tabId, 'mouseMoved', t.x, t.y, {}, t.sid);
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, 'mousePressed', t.x, t.y, { button, clickCount: i }, t.sid);
    await mouse(tabId, 'mouseReleased', t.x, t.y, { button, clickCount: i }, t.sid);
  }
  return t.sid;
}

const NAMED_KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], return: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46], space: [' ', 'Space', 32, ' '], home: ['Home', 'Home', 36], end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowup: ['ArrowUp', 'ArrowUp', 38],
  arrowright: ['ArrowRight', 'ArrowRight', 39], arrowdown: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37], up: ['ArrowUp', 'ArrowUp', 38],
  right: ['ArrowRight', 'ArrowRight', 39], down: ['ArrowDown', 'ArrowDown', 40],
};
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, shift: 8 };

async function pressKey(tabId, combo, sessionId = undefined) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean);
  if (String(combo).endsWith('+') && String(combo).length > 1) parts.push('+');
  if (!parts.length) throw new Error('Empty key');
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}". Use ctrl, alt, shift or meta.`);
    modifiers |= bit;
  }
  let key, code, vk, text;
  const named = NAMED_KEYS[keyName.toLowerCase()];
  const fk = /^f(\d{1,2})$/i.exec(keyName);
  if (named) [key, code, vk, text] = named;
  else if (fk) { key = code = 'F' + fk[1]; vk = 111 + Number(fk[1]); }
  else if ([...keyName].length === 1) {
    key = (modifiers & 8) ? keyName.toUpperCase() : keyName;
    const up = keyName.toUpperCase();
    if (/[A-Z]/.test(up)) { code = 'Key' + up; vk = up.charCodeAt(0); }
    else if (/[0-9]/.test(up)) { code = 'Digit' + up; vk = up.charCodeAt(0); }
    else { code = ''; vk = 0; }
    text = key;
  } else throw new Error(`Unknown key "${keyName}". Examples: Enter, Tab, Escape, ArrowDown, ctrl+a, shift+Tab.`);
  if (modifiers & 7) text = undefined; // ctrl/alt/meta chords do not produce text
  const base = { modifiers, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) }, 15000, sessionId);
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }, 15000, sessionId);
}

async function addToGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const { groupId } = await chrome.storage.session.get('groupId');
    if (groupId != null) {
      try {
        const g = await chrome.tabGroups.get(groupId);
        if (g.windowId === tab.windowId) { await chrome.tabs.group({ tabIds: [tabId], groupId }); return; }
      } catch { /* group gone */ }
    }
    const id = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(id, { title: 'Hermes', color: 'orange' });
    await chrome.storage.session.set({ groupId: id });
  } catch { /* grouping is cosmetic */ }
}

function normaliseUrl(url) {
  let u = String(url).trim();
  if (/^(javascript|data|vbscript):/i.test(u)) throw new Error('That URL scheme is not allowed.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  return u;
}

// Captures a region given in viewport CSS pixels. `zoom` is output pixels per CSS pixel.
async function capture(tabId, region, zoom = 1) {
  const { cssVisualViewport: v } = await cdp(tabId, 'Page.getLayoutMetrics');
  const vp = await callFn(tabId, pageViewport);
  const r = region || { x: 0, y: 0, width: v.clientWidth, height: v.clientHeight };
  const z = typeof zoom === 'function' ? zoom(r) : zoom;
  const params = {
    format: 'jpeg', quality: 70, captureBeyondViewport: false,
    clip: { x: v.pageX + r.x, y: v.pageY + r.y, width: r.width, height: r.height, scale: z / (vp?.dpr || 1) },
  };
  await callFn(tabId, pageIndicator, false); // keep our own frame out of the picture
  try {
    try {
      return { shot: await cdp(tabId, 'Page.captureScreenshot', params, 8000), r, z };
    } catch (e) {
      if (!/timed out/.test(String(e.message)) || sessions.get(tabId)?.dialog) throw e;
      // Background tabs in occluded windows sometimes do not paint; front the tab and retry once.
      await cdp(tabId, 'Page.bringToFront');
      return { shot: await cdp(tabId, 'Page.captureScreenshot', params, 8000), r, z };
    }
  } finally {
    setIndicator(tabId, true);
  }
}

// ---------------------------------------------------------------- recording

async function recordFrame(tabId, pt) {
  const rec = recordings.get(tabId);
  if (!rec?.on) return;
  if (rec.frames.length >= GIF_MAX_FRAMES) { rec.dropped++; return; }
  const { shot, z } = await capture(tabId, null, (r) => Math.min(1, GIF_MAX_WIDTH / r.width));
  if (rec.frames.at(-1)?.data === shot.data) return;
  rec.frames.push({ data: shot.data, pt: pt ? { x: pt.x * z, y: pt.y * z } : null });
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function buildGif(rec, delayMs) {
  let canvas = null;
  let c2d = null;
  const frames = [];
  for (const f of rec.frames) {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + f.data)).blob());
    if (!canvas) {
      canvas = new OffscreenCanvas(bmp.width, bmp.height);
      c2d = canvas.getContext('2d', { willReadFrequently: true });
    }
    c2d.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    if (f.pt) { // mark where the click landed
      c2d.beginPath();
      c2d.arc(f.pt.x, f.pt.y, 12, 0, Math.PI * 2);
      c2d.fillStyle = 'rgba(255, 60, 0, 0.35)';
      c2d.fill();
      c2d.lineWidth = 2.5;
      c2d.strokeStyle = 'rgb(255, 60, 0)';
      c2d.stroke();
    }
    frames.push(c2d.getImageData(0, 0, canvas.width, canvas.height).data);
  }
  return { bytes: encodeGif(frames, canvas.width, canvas.height, delayMs), width: canvas.width, height: canvas.height };
}

const tabLine = (t) => `[tab ${t.id}] ${t.title || '(untitled)'} — ${t.url || ''}`;

// ----------------------------------------------------------------- handlers

const HANDLERS = {
  async status() {
    const attached = [...sessions.keys()];
    const { siteMode } = await siteState();
    return {
      text: `Extension ${chrome.runtime.getManifest().version} connected. `
        + (attached.length ? `Debugger attached to tab(s): ${attached.join(', ')} (the browser shows its debugging bar). ` : 'Debugger not attached to any tab (no debugging bar). ')
        + (siteMode === 'all' ? 'Site permissions: all sites allowed without asking (except any the user blocked).' :'Site permissions: the user is asked the first time you use each site.')
        + (prompts.size ? ` Waiting for the user's answer about: ${[...prompts.keys()].join(', ')}.` : '')
        + ((await fileAccessAllowed()) ? ' File uploads: by path, any size.' : ' File uploads: by content only, up to 25 MB, no folders ("Allow access to file URLs" is off for the extension).'),
    };
  },

  async tabs_list() {
    const tabs = await chrome.tabs.query({});
    const { lastTabId } = await chrome.storage.session.get('lastTabId');
    const st = await siteState();
    const lines = tabs.map((t) => {
      // Titles and addresses of sites the user has not shared stay private.
      const v = siteVerdict(t.url || '', st);
      const body = v === 'allow' ? tabLine(t) : `[tab ${t.id}] ${siteKey(t.url)} (${v === 'deny' ? 'blocked by the user' : 'not yet allowed: using it will ask the user'})`;
      return body + (t.active ? ' (active in its window)' : '') + (t.id === lastTabId ? ' (current Hermes tab)' : '');
    });
    return { text: lines.join('\n') || 'No tabs open.' };
  },

  async tab_new(p, ctx) {
    const url = p.url ? normaliseUrl(p.url) : 'about:blank';
    await ensureSite(url);
    const tab = await chrome.tabs.create({ url, active: !!p.foreground });
    await chrome.storage.session.set({ lastTabId: tab.id });
    ctx.tabId = tab.id;
    await addToGroup(tab.id);
    const loaded = p.url ? await waitForLoad(tab.id) : tab;
    return { text: 'Opened ' + tabLine(loaded || tab) };
  },

  async tab_close(p) {
    if (p.tabId == null) throw new Error('tabId is required.');
    const tab = await chrome.tabs.get(p.tabId);
    await ensureSite(tab.url || '');
    await chrome.tabs.remove(p.tabId);
    return { text: `Closed tab ${p.tabId}.` };
  },

  async tab_activate(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { text: 'Brought to front: ' + tabLine(tab) };
  },

  async resize_window(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const presets = { mobile: [500, 900], tablet: [820, 1100], desktop: [1440, 900] };
    const [width, height] = presets[p.preset] || [Number(p.width), Number(p.height)];
    if (!(width > 0 && height > 0)) throw new Error('Provide preset (mobile, tablet, desktop) or both width and height.');
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { state: 'normal' });
    const size = { width: Math.round(width), height: Math.round(height) };
    try {
      await chrome.windows.update(tab.windowId, size);
    } catch {
      // Growing a window near the screen edge can push it off-screen; move it to the corner and retry.
      await chrome.windows.update(tab.windowId, { ...size, left: 0, top: 0 });
    }
    await sleep(300);
    const vp = await callFn(tabId, pageViewport).catch(() => null);
    return { text: `Window resized to ${Math.round(width)}x${Math.round(height)}.` + (vp ? ` Page viewport is now ${vp.w}x${vp.h} CSS px.` : '') + ' Browser windows cannot be narrower than about 500px.' };
  },

  async navigate(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const target = String(p.url || '').trim();
    if (!target) throw new Error('url is required (a URL, or "back", "forward", "reload").');
    if (target === 'back' || target === 'forward') {
      const before = (await chrome.tabs.get(tabId)).url;
      try {
        await (target === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId));
      } catch {
        // The browser's own back/forward skips pages nobody interacted with,
        // which is every page Hermes only read. The page's history API does not.
        await callFn(tabId, target === 'back' ? pageHistoryBack : pageHistoryForward);
        for (let i = 0; i < 20 && (await chrome.tabs.get(tabId)).url === before; i++) await sleep(100);
        if ((await chrome.tabs.get(tabId)).url === before) throw new Error(`There is no page to go ${target} to.`);
      }
    } else if (target === 'reload') await chrome.tabs.reload(tabId);
    else {
      const url = normaliseUrl(target);
      await ensureSite(url);
      await chrome.tabs.update(tabId, { url });
    }
    const tab = await waitForLoad(tabId);
    setIndicator(tabId, true);
    return { text: 'Now at ' + (tab ? tabLine(tab) : 'unknown') + (tab && tab.status !== 'complete' ? ' (still loading)' : '') };
  },

  async snapshot(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    return { text: await fullSnapshot(tabId, { interactiveOnly: !!p.interactiveOnly, maxChars: p.maxChars }) };
  },

  async find(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const q = String(p.query || '').trim().toLowerCase();
    if (!q) throw new Error('query is required.');
    const snap = await fullSnapshot(tabId, { interactiveOnly: false, maxChars: 400000 });
    const words = q.split(/\s+/);
    const hits = String(snap).split('\n').slice(4).map((l) => l.trim()).filter((l) => { const s = l.toLowerCase(); return words.every((w) => s.includes(w)); });
    if (!hits.length) return { text: `No element or text matching "${p.query}". Try fewer or different words, or take a snapshot.` };
    return { text: `${hits.length} match(es)${hits.length > 30 ? ', first 30 shown' : ''}:\n` + hits.slice(0, 30).join('\n') };
  },

  async get_text(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const max = p.maxChars || 20000;
    let text = await callFn(tabId, pageText, max);
    // innerText never includes embedded documents, so add the ones with real text.
    const frames = await subFrames(tabId);
    const parts = await Promise.all(frames.map((f) => callFn(tabId, pageFrameText, 4000, f.frameId).catch(() => null)));
    let added = 0;
    for (const part of parts) {
      if (!part || part.text.length < 40 || added >= 8 || text.length >= max) continue;
      text += `\n\n--- embedded frame: ${part.url.slice(0, 200)} ---\n${part.text}`.slice(0, max - text.length);
      added++;
    }
    return { text };
  },

  async screenshot(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const { shot, r } = await capture(tabId, null, 1);
    lastShot = { data: shot.data, mimeType: 'image/jpeg' };
    return {
      text: `Screenshot of tab ${tabId}, ${Math.round(r.width)}x${Math.round(r.height)} CSS px. Image coordinates can be used directly as x/y.`,
      image: { data: shot.data, mimeType: 'image/jpeg' },
    };
  },

  async zoom(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const [x0, y0, x1, y1] = [p.x0, p.y0, p.x1, p.y1].map(Number);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new Error('Provide x0, y0, x1, y1 (viewport CSS pixels) with x1 > x0 and y1 > y0.');
    const width = x1 - x0;
    const height = y1 - y0;
    const z = Math.max(1, Math.min(4, 1400 / width, 1400 / height));
    const { shot } = await capture(tabId, { x: x0, y: y0, width, height }, z);
    lastShot = { data: shot.data, mimeType: 'image/jpeg' };
    return {
      text: `Region (${x0}, ${y0})-(${x1}, ${y1}) enlarged ${z.toFixed(1)}x. Coordinates in this image are NOT click coordinates; use the region's own.`,
      image: { data: shot.data, mimeType: 'image/jpeg' },
    };
  },

  async click(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const pt = await pointFor(tabId, p);
    ctx.pt = pt;
    const count = p.tripleClick ? 3 : p.doubleClick ? 2 : 1;
    await doClick(tabId, pt, { button: p.button || 'left', count });
    await settleAfterInput(tabId);
    return { text: `Clicked ${pt.desc || ''} at (${pt.x}, ${pt.y}).`.replace('  ', ' ') };
  },

  async hover(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const pt = await pointFor(tabId, p);
    const t = await inputTarget(tabId, pt);
    await mouse(tabId, 'mouseMoved', t.x, t.y, {}, t.sid);
    return { text: `Hovering ${pt.desc || ''} at (${pt.x}, ${pt.y}).`.replace('  ', ' ') };
  },

  async drag(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const to = await pointFor(tabId, p, 'to');
    const from = await pointFor(tabId, p, 'from'); // located last so it is the one scrolled into view
    const end = p.toRef ? await locate(tabId, p.toRef, pageLocateNoScroll).catch(() => to) : to;
    await mouse(tabId, 'mouseMoved', from.x, from.y);
    await mouse(tabId, 'mousePressed', from.x, from.y, { button: 'left', clickCount: 1 });
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await mouse(tabId, 'mouseMoved', from.x + ((end.x - from.x) * i) / steps, from.y + ((end.y - from.y) * i) / steps, { button: 'left', buttons: 1 });
      await sleep(15);
    }
    await mouse(tabId, 'mouseReleased', end.x, end.y, { button: 'left', clickCount: 1 });
    await settleAfterInput(tabId);
    return { text: `Dragged from (${from.x}, ${from.y}) to (${Math.round(end.x)}, ${Math.round(end.y)}).` };
  },

  async type(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    if (typeof p.text !== 'string') throw new Error('text is required.');
    let sid; // keyboard input follows the click into a cross-site frame
    if (p.ref) {
      const pt = await pointFor(tabId, p);
      sid = await doClick(tabId, pt);
      await sleep(80);
    }
    if (p.clear) await callFn(tabId, pageSelectAllInFocused, null, p.ref ? parseRef(p.ref).frameId : 0);
    if (p.clear && !p.text) await pressKey(tabId, 'Backspace', sid);
    if (p.text) await cdp(tabId, 'Input.insertText', { text: p.text }, 15000, sid);
    if (p.submit) {
      await pressKey(tabId, 'Enter', sid);
      await settleAfterInput(tabId);
    }
    return { text: `Typed ${p.text.length} character(s)${p.submit ? ' and pressed Enter' : ''}.` };
  },

  async press_key(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const n = Math.min(Math.max(Number(p.repeat) || 1, 1), 50);
    for (let i = 0; i < n; i++) await pressKey(tabId, p.key);
    await settleAfterInput(tabId); // Enter and shortcuts can start a navigation
    return { text: `Pressed ${p.key}${n > 1 ? ` x${n}` : ''}.` };
  },

  async scroll(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const amount = Number(p.amount) || 600;
    const dir = p.direction || 'down';
    const delta = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] }[dir];
    if (!delta) throw new Error('direction must be up, down, left or right.');
    let pt;
    if (p.ref || typeof p.x === 'number') pt = await pointFor(tabId, p);
    else {
      const vp = await callFn(tabId, pageViewport);
      pt = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) };
    }
    if (p.ref && parseRef(p.ref).frameId !== 0) {
      // Inside an embedded frame only a real wheel event reaches the right scroller.
      const t = await inputTarget(tabId, pt);
      await mouse(tabId, 'mouseWheel', t.x, t.y, { deltaX: delta[0], deltaY: delta[1] }, t.sid);
      await sleep(300);
      return { text: `Scrolled ${dir} ${amount}px inside the embedded frame.` };
    }
    const before = await callFn(tabId, pageScrollProbe, { x: pt.x, y: pt.y, dx: delta[0], dy: delta[1] });
    // A real wheel event when the debugger is already in use on this tab;
    // otherwise scroll from script so plain reading never shows the debug bar.
    if (sessions.has(tabId)) {
      try { await mouse(tabId, 'mouseWheel', pt.x, pt.y, { deltaX: delta[0], deltaY: delta[1] }); } catch { /* script fallback below */ }
      await sleep(300);
    }
    const pos = await callFn(tabId, pageScrollFinish, { before, dx: delta[0], dy: delta[1] });
    return { text: `Scrolled ${dir} ${amount}px. Page scroll position: ${pos}px.` };
  },

  async scroll_to(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    if (!p.ref) throw new Error('ref is required.');
    const r = await locate(tabId, p.ref);
    return { text: `Scrolled ${r.desc} into view; it is now at (${r.x}, ${r.y}).` };
  },

  async set_value(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    if (!p.ref) throw new Error('ref is required.');
    const { frameId, ref } = parseRef(p.ref);
    const r = await callFn(tabId, pageSetValue, { ref, value: p.value }, frameId);
    if (!r || r.error) throw new Error(r?.error || 'Could not set value');
    return { text: r.ok };
  },

  async upload_file(p, ctx) {
    return uploadFile(p, ctx);
  },

  async upload_image(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const img = p.image || lastShot;
    if (!img) throw new Error('No image to use: take a screenshot first, or pass path to an image file.');
    const mode = p.mode || 'auto';
    if (!['auto', 'paste', 'drop'].includes(mode)) throw new Error('mode must be auto, paste or drop.');
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[img.mimeType] || 'img';
    const { frameId, ref } = p.ref ? parseRef(p.ref) : { frameId: 0, ref: null };
    const r = await callFn(tabId, pagePutImage, {
      ref, x: p.x, y: p.y, mode, data: img.data, mimeType: img.mimeType,
      name: String(p.filename || img.name || `screenshot.${ext}`).replace(/[\\/:*?"<>|]/g, '_'),
    }, frameId);
    if (!r || r.error) throw new Error(r?.error || 'Could not deliver the image');
    return { text: r.ok };
  },

  async gif_recorder(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const action = p.action;
    let rec = recordings.get(tabId);
    if (action === 'start') {
      rec = { on: true, frames: [], dropped: 0 };
      recordings.set(tabId, rec);
      await recordFrame(tabId, null);
      return { text: `Recording tab ${tabId}. A frame is captured after each action you take on it (up to ${GIF_MAX_FRAMES}). The browser shows its debugging bar while recording. Call gif_recorder with action "stop", then "export".` };
    }
    if (!rec) throw new Error('No recording for this tab. Call gif_recorder with action "start" first.');
    if (action === 'stop') {
      if (rec.on) await recordFrame(tabId, null).catch(() => {});
      rec.on = false;
      return { text: `Recording stopped with ${rec.frames.length} frame(s)${rec.dropped ? ` (${rec.dropped} more were skipped after the limit)` : ''}. Call gif_recorder with action "export" to save it.` };
    }
    if (action === 'clear') {
      recordings.delete(tabId);
      return { text: 'Recording discarded.' };
    }
    if (action === 'export') {
      if (rec.on) { await recordFrame(tabId, null).catch(() => {}); rec.on = false; }
      if (!rec.frames.length) throw new Error('The recording has no frames.');
      const delay = Math.min(Math.max(Number(p.frameDelayMs) || 900, 100), 5000);
      const { bytes, width, height } = await buildGif(rec, delay);
      const frames = rec.frames.length;
      recordings.delete(tabId);
      return {
        text: `GIF with ${frames} frame(s), ${width}x${height}, ${Math.round(bytes.length / 1024)} KB.`,
        file: { data: toBase64(bytes), name: String(p.filename || `hermes-recording-${Date.now()}`), ext: 'gif' },
      };
    }
    throw new Error('action must be start, stop, export or clear.');
  },

  async evaluate(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const r = await evaluate(tabId, String(p.expression || ''), 30000);
    let text;
    if (r.type === 'undefined') text = 'undefined';
    else if (r.value !== undefined) text = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
    else text = r.description || r.type;
    if (text.length > 30000) text = text.slice(0, 30000) + '\n… truncated';
    return { text };
  },

  async console_messages(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    const fresh = !sessions.has(tabId);
    await ensureAttached(tabId);
    if (fresh) await sleep(300); // let the replayed history arrive
    const s = sessions.get(tabId);
    let msgs = s?.console || [];
    if (p.onlyErrors) msgs = msgs.filter((m) => m.level === 'error' || m.level === 'assert');
    const text = msgs.map((m) => `[${m.level}] ${m.text}`).join('\n') || 'No console messages.';
    if (p.clear && s) s.console.length = 0;
    return { text };
  },

  async network_requests(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    await ensureAttached(tabId);
    const s = sessions.get(tabId);
    if (!s.tracking) {
      await cdp(tabId, 'Network.enable');
      s.tracking = true;
      return { text: 'Network capture is now on for this tab (it stays on while you keep using the tab, up to 5 minutes idle). Reload the page or repeat the action, then call network_requests again.' };
    }
    let rows = [...s.net.values()];
    if (p.urlPattern) rows = rows.filter((r) => String(r.url).includes(p.urlPattern));
    const text = rows.slice(-(Number(p.limit) || 50)).map((r) => `${r.status ?? 'pending'} ${r.method} ${String(r.url).slice(0, 300)} (${r.type || 'Other'})`).join('\n')
      || 'No matching requests captured yet.';
    if (p.clear) s.net.clear();
    return { text };
  },

  async handle_dialog(p, ctx) {
    const tabId = await resolveTab(p, ctx);
    await ensureAttached(tabId);
    const s = sessions.get(tabId);
    const d = s?.dialog;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: p.accept !== false, ...(p.promptText != null ? { promptText: String(p.promptText) } : {}) });
    } catch {
      return { text: 'No JavaScript dialog is open in this tab.' };
    }
    if (s) s.dialog = null;
    return { text: `${p.accept !== false ? 'Accepted' : 'Dismissed'} ${d ? `${d.type} dialog: "${d.message}"` : 'the open dialog'}` };
  },
};

function pageHistoryBack() { history.back(); }
function pageHistoryForward() { history.forward(); }

// Like pageLocate but without scrolling, for the drop end of a drag.
function pageLocateNoScroll(ref) {
  const el = window.__hermesBridge?.map.get(ref)?.deref();
  if (!el || !el.isConnected) return { error: 'gone' };
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  let w = el.ownerDocument.defaultView;
  while (w && w !== window && w.frameElement) {
    const fr = w.frameElement.getBoundingClientRect();
    x += fr.left + w.frameElement.clientLeft;
    y += fr.top + w.frameElement.clientTop;
    w = w.parent;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

// ------------------------------------------- popup and permission prompt UI

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages may change settings or answer prompts.
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  (async () => {
    try {
      if (msg?.type === 'setEnabled') {
        await chrome.storage.local.set({ enabled: !!msg.enabled });
        if (msg.enabled) await connect();
        else { ws?.close(); await releaseAll(); }
      } else if (msg?.type === 'detachAll') {
        await releaseAll();
      } else if (msg?.type === 'siteDecision' && typeof msg.host === 'string' && ['always', 'session', 'deny', 'block', 'all'].includes(msg.decision)) {
        await settlePrompt(msg.host, msg.decision);
      } else if (msg?.type === 'setSiteMode' && ['ask', 'all'].includes(msg.mode)) {
        await setSiteMode(msg.mode);
      } else if (msg?.type === 'removeSite' && typeof msg.host === 'string') {
        const { sites = {} } = await chrome.storage.local.get('sites');
        delete sites[msg.host];
        await chrome.storage.local.set({ sites });
        const { sessionSites = {} } = await chrome.storage.session.get('sessionSites');
        delete sessionSites[msg.host];
        await chrome.storage.session.set({ sessionSites });
      }
      const tabs = [];
      for (const tabId of new Set([...indicators.keys(), ...sessions.keys()])) {
        try {
          const t = await chrome.tabs.get(tabId);
          tabs.push({ tabId, title: (sessions.has(tabId) ? '● ' : '') + (t.title || t.url || String(tabId)) });
        } catch { /* closed */ }
      }
      await updateBadge();
      const st = await siteState();
      const rules = [
        ...Object.entries(st.sites).map(([host, rule]) => ({ host, rule })),
        ...Object.keys(st.sessionSites).filter((h) => !(h in st.sites)).map((host) => ({ host, rule: 'session' })),
      ].sort((a, b) => a.host.localeCompare(b.host));
      sendResponse({ enabled: await isEnabled(), connected: authed, tabs, siteMode: st.siteMode, rules, fileAccess: await fileAccessAllowed() });
    } catch (e) {
      sendResponse({ error: String(e?.message || e) });
    }
  })();
  return true;
});
