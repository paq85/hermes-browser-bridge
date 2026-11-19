// End-to-end test: loads the extension into a throwaway Chromium profile and
// drives it through the MCP bridge exactly as Hermes would.
//
//   node test/e2e.mjs [path-to-chromium]
//
// Needs a Chromium that still accepts --load-extension (Chrome for Testing or
// a Playwright Chromium; branded Chrome 137+ does not).

import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocket } from '../vendor/ws/wrapper.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Everything runs against a private copy of the extension with its own port and
// token, so the test can never reach a real browser that has the extension.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hbb-test-'));
const extDir = path.join(sandbox, 'extension');
fs.cpSync(path.resolve(here, '..', '..', 'extension'), extDir, { recursive: true });
const pairing = { port: 39000 + Math.floor(Math.random() * 900), token: crypto.randomBytes(32).toString('hex') };
fs.writeFileSync(path.join(sandbox, 'pairing.json'), JSON.stringify(pairing));
fs.writeFileSync(path.join(extDir, 'config.json'), JSON.stringify(pairing));
const bridgeEnv = {
  ...process.env,
  HERMES_BROWSER_BRIDGE_CONFIG: path.join(sandbox, 'pairing.json'),
  HERMES_BROWSER_BRIDGE_EXTENSION_DIR: extDir,
  HERMES_BROWSER_BRIDGE_OUTPUT_DIR: path.join(sandbox, 'out'),
};
// The test browser's own debugging port is used only to press buttons in the
// extension's permission prompt, which nothing else is allowed to answer.
const dbgPort = 40000 + Math.floor(Math.random() * 900);
const serverJs = path.resolve(here, '..', 'server.mjs');

function findChromium() {
  if (process.argv[2]) return process.argv[2];
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  for (const d of fs.existsSync(root) ? fs.readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse() : []) {
    for (const sub of fs.readdirSync(path.join(root, d))) {
      const exe = path.join(root, d, sub, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('No Chromium found; pass a path as the first argument.');
}

const page = (cross) => `<!doctype html><title>Bridge Test</title>
<h1>Bridge test page</h1>
<p>Hello from the test page.</p>
<a href="/second">Go to second page</a>
<label>Name <input id="name" placeholder="Your name"></label>
<input type="password" id="pw" value="hunter2" aria-label="Password">
<label><input type="checkbox" id="agree"> I agree</label>
<select id="colour" aria-label="Colour"><option>Red</option><option>Green</option><option>Blue</option></select>
<button id="go">Greet</button>
<div id="out"></div>
<div style="cursor:pointer" id="card">Custom clickable</div>
<input type="file" id="file" aria-label="Attachment">
<div id="pad" role="button" aria-label="Drag pad" style="width:300px;height:60px;background:#ccc"></div>
<p id="para">Triple click selects this whole paragraph of text.</p>
<div id="pastezone" role="textbox" aria-label="Paste zone" contenteditable style="width:200px;height:30px;border:1px solid"></div>
<div id="dropzone" role="button" aria-label="Drop zone" style="width:200px;height:40px;background:#ddd"></div>
<iframe src="/frame" style="width:300px;height:80px;border:3px solid"></iframe>
<iframe src="${cross}/cross" style="width:320px;height:110px;border:5px solid;margin-left:40px"></iframe>
<div style="height:3000px"></div>
<script>
  console.log('page loaded', 42);
  go.onclick = () => out.textContent = 'Hello, ' + document.getElementById('name').value + '! ' + colour.value + ' ' + agree.checked;
  card.onclick = () => card.textContent = 'Card clicked';
  pad.onmousedown = (e) => pad.dataset.down = e.clientX; pad.onmouseup = (e) => pad.dataset.up = e.clientX;
  let moves = 0; pad.onmousemove = () => pad.dataset.moves = ++moves;
  pastezone.addEventListener('paste', (e) => { const f = e.clipboardData.files[0]; if (f) { e.preventDefault(); pastezone.dataset.got = f.name + ':' + f.type + ':' + (f.size > 1000); } });
  dropzone.addEventListener('dragover', (e) => e.preventDefault());
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; dropzone.dataset.got = f ? f.name + ':' + f.type : 'none'; });
</script>`;
const CROSS = `<!doctype html><title>Cross</title><p>Text inside the cross-origin frame, long enough to be included.</p>
<button onclick="this.textContent='Cross clicked'">Cross button</button><input aria-label="Cross field">`;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FRAME = `<!doctype html><button onclick="this.textContent='Frame clicked'">Frame button</button>`;
const SECOND = `<!doctype html><title>Second</title><h1>Second page</h1><button onclick="alert('boo')">Alert</button>`;

class Mcp {
  constructor(name) {
    this.name = name;
    this.proc = spawn(process.execPath, [serverJs], { stdio: ['pipe', 'pipe', 'pipe'], env: bridgeEnv });
    this.proc.stderr.on('data', (d) => process.stderr.write(`  ${name}: ${d}`));
    this.waiting = new Map();
    this.n = 0;
    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => {
      const m = JSON.parse(l);
      if (m.method === 'notifications/tools/list_changed') this.listChanged = true;
      this.waiting.get(m.id)?.(m);
      this.waiting.delete(m.id);
    });
  }
  rpc(method, params) {
    const id = ++this.n;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res) => this.waiting.set(id, res));
  }
  async tool(name, args = {}) {
    const r = await this.rpc('tools/call', { name, arguments: args });
    const text = r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const image = r.result.content.find((c) => c.type === 'image');
    return { text, image, isError: !!r.result.isError };
  }
  stop() { this.proc.stdin.end(); }
}

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n      ' + String(detail).slice(0, 1500)}`);
  if (!cond) failures++;
}
const refFor = (snap, re) => (re.exec(snap) || [])[1];

function jpegSize(b64) {
  const b = Buffer.from(b64, 'base64');
  for (let i = 2; i < b.length;) {
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

// The same server answers as 127.0.0.1 (the test site) and as localhost (a
// different origin, used for the cross-origin frame and the permission tests).
let cross = '';
const web = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/frame' ? FRAME : req.url === '/second' ? SECOND : req.url === '/cross' ? CROSS : page(cross));
});
await new Promise((r) => web.listen(0, r));
const base = `http://127.0.0.1:${web.address().port}`;
cross = `http://localhost:${web.address().port}`;

// Runs a script in a page of the extension (e.g. the toolbar popup) opened in a
// tab of the test browser, as the user clicking in that popup would.
async function inExtensionPage(page, expression) {
  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(list.find((t) => /\/sw\.js$/.test(t.url))?.url || '')?.[1];
  if (!id) throw new Error('extension service worker not found');
  const target = await (await fetch(`http://127.0.0.1:${dbgPort}/json/new?chrome-extension://${id}/${page}`, { method: 'PUT' })).json();
  const value = await runInTarget(target, expression);
  await fetch(`http://127.0.0.1:${dbgPort}/json/close/${target.id}`);
  return value;
}

// Evaluates in a page target once the extension page (not the initial
// about:blank) is the loaded document.
async function runInTarget(target, expression) {
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
  let n = 0;
  const evaluate = (expr) => new Promise((res) => {
    const id = ++n;
    const onMsg = (m) => { const d = JSON.parse(m); if (d.id === id) { sock.off('message', onMsg); res(d); } };
    sock.on('message', onMsg);
    sock.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { awaitPromise: true, returnByValue: true, expression: expr } }));
    setTimeout(() => res(null), 5000);
  });
  // The new tab starts on about:blank; wait until the extension page is the one loaded.
  for (let i = 0; i < 60; i++) {
    const loc = (await evaluate('location.href + "|" + document.readyState'))?.result?.result?.value || '';
    if (loc.startsWith('chrome-extension://') && loc.endsWith('|complete')) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const reply = await evaluate(expression);
  sock.close();
  return reply?.result?.result?.value;
}
const clickPopupMode = (mode) => inExtensionPage('popup.html', `new Promise((done) => { const go = () => { const r = document.querySelector('input[name="mode"][value="${mode}"]'); if (r && document.readyState === 'complete') { r.click(); setTimeout(() => done(document.querySelector('input[name="mode"]:checked')?.value), 400); } else setTimeout(go, 50); }; go(); })`);

// Presses a button in the extension's permission prompt window.
async function answerPrompt(buttonId) {
  for (let i = 0; i < 100; i++) {
    let targets = [];
    try { targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json(); } catch { /* browser still starting */ }
    const t = targets.find((x) => /permission\.html/.test(x.url));
    if (t) {
      const clicked = await runInTarget(t, `new Promise((done) => { const go = () => { const b = document.getElementById('${buttonId}'); if (document.readyState === 'complete' && b) { b.click(); done('ok'); } else setTimeout(go, 50); }; go(); })`);
      if (clicked !== 'ok') throw new Error('could not press the prompt button ' + buttonId);
      return decodeURIComponent(/host=([^&]+)/.exec(t.url)?.[1] || '');
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error('permission prompt did not appear');
}

const a = new Mcp('bridge-A');
const init = await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
check('initialize', init.result?.serverInfo?.name === 'hermes-browser-bridge', JSON.stringify(init));
const list = await a.rpc('tools/list', {});
check('tools/list', list.result?.tools?.length >= 27, JSON.stringify(list).slice(0, 300));
a.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await new Promise((res) => setTimeout(res, 800));
check('announces tools/list_changed after initialize', a.listChanged === true);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hbb-profile-'));
const chrome = spawn(findChromium(), [
  `--user-data-dir=${profile}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=2',
  '--window-size=1000,700', `--remote-debugging-port=${dbgPort}`, 'about:blank',
], { stdio: 'ignore' });

try {
  let r = await a.tool('tabs_list');
  check('extension connects and tabs_list works', !r.isError && /\[tab \d+\]/.test(r.text), r.text);

  // Site permissions: nothing is allowed until the user answers the prompt.
  let pending = a.tool('tab_new', { url: cross + '/second' });
  let asked = await answerPrompt('deny');
  r = await pending;
  check('site prompt: "Not now" refuses the call', asked === 'localhost' && r.isError && /declined/.test(r.text), `${asked} | ${r.text}`);
  pending = a.tool('tab_new', { url: cross + '/second' });
  await answerPrompt('block');
  r = await pending;
  check('site prompt: "Never allow" blocks', r.isError && /blocked/.test(r.text), r.text);
  const tBlocked = Date.now();
  r = await a.tool('tab_new', { url: cross + '/second' });
  check('a blocked site is refused at once, without asking again', r.isError && /blocked/.test(r.text) && Date.now() - tBlocked < 3000, r.text);
  pending = a.tool('tab_new', { url: base + '/' });
  asked = await answerPrompt('always');
  r = await pending;
  check('site prompt: "Always allow" lets the call through', asked === '127.0.0.1' && !r.isError && /Bridge Test/.test(r.text), `${asked} | ${r.text}`);
  r = await a.tool('status');
  check('status reports ask-per-site mode', /asked the first time/.test(r.text), r.text);

  // "Allow all sites": from the prompt itself, and from the toolbar popup.
  const third = `http://[::1]:${web.address().port}`; // a host with no rule of its own
  pending = a.tool('tab_new', { url: third + '/second' });
  asked = await answerPrompt('all');
  r = await pending;
  check('prompt: "Allow all sites from now on" lets the waiting call through', asked === '[::1]' && !r.isError && /Second/.test(r.text), `${asked} | ${r.text}`);
  const allTab = Number(/\[tab (\d+)\]/.exec(r.text)?.[1]);
  r = await a.tool('status');
  check('status reports all-sites mode', /all sites allowed without asking/.test(r.text), r.text);
  r = await a.tool('navigate', { url: third + '/', tabId: allTab });
  check('all-sites mode: another page on a new host needs no prompt', !r.isError && /Bridge Test/.test(r.text), r.text);
  r = await a.tool('tabs_list');
  check('all-sites mode: tabs_list shows every title and address', !/not yet allowed/.test(r.text) && /Bridge Test — http:\/\/\[::1\]/.test(r.text), r.text);
  r = await a.tool('tab_new', { url: cross + '/second' });
  check('all-sites mode: a blocked site stays blocked', r.isError && /blocked/.test(r.text), r.text);
  check('popup: switch back to "Ask me"', (await clickPopupMode('ask')) === 'ask');
  r = await a.tool('status');
  check('status reports ask mode again', /asked the first time/.test(r.text), r.text);
  pending = a.tool('navigate', { url: third + '/second', tabId: allTab });
  await new Promise((res) => setTimeout(res, 1500)); // the prompt is now open and the call is waiting
  check('popup: switch to "Allow all sites without asking"', (await clickPopupMode('all')) === 'all');
  r = await pending;
  check('switching to all-sites in the popup releases a call waiting on a prompt', !r.isError && /Second/.test(r.text), r.text);
  const leftover = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  check('no permission prompt left open', !leftover.some((t) => /permission\.html/.test(t.url)));
  await a.tool('tab_close', { tabId: allTab });

  r = await a.tool('snapshot');
  const snap = r.text;
  r = await a.tool('find', { query: 'greet' });
  check('find', /1 match/.test(r.text) && /button "Greet" \[ref=e\d+\]/.test(r.text), r.text);
  r = await a.tool('scroll', { direction: 'down', amount: 300 });
  check('scroll without debugger', /position: 300 of/.test(r.text), r.text);
  r = await a.tool('scroll_to', { ref: refFor(snap, /button "Greet" \[ref=(e\d+)\]/) });
  check('scroll_to', !r.isError && /into view/.test(r.text), r.text);
  r = await a.tool('set_value', { ref: refFor(snap, /textbox "Name[^"]*" \[ref=(e\d+)\]/), value: 'silent' });
  check('set_value text', !r.isError, r.text);
  r = await a.tool('navigate', { url: base + '/second' });
  check('navigate to URL without debugger', /Second/.test(r.text), r.text);
  r = await a.tool('navigate', { url: 'back' });
  check('navigate back', /Bridge Test/.test(r.text), r.text);
  r = await a.tool('get_text');
  check('navigate + get_text', /Bridge test page/.test(r.text), r.text);
  r = await a.tool('status');
  check('reading, find, scroll, set_value, navigate never attach the debugger', /Debugger not attached/.test(r.text), r.text);
  r = await a.tool('snapshot');
  check('indicator frame is not in the snapshot', !/hermes_bridge/.test(r.text) && /Bridge test page/.test(r.text), r.text);
  check('snapshot has heading, text, link', /heading\(1\) "Bridge test page"/.test(snap) && /Hello from the test page/.test(snap) && /link "Go to second page" \[ref=e\d+\]/.test(snap), snap);
  check('snapshot hides password value', !snap.includes('hunter2') && snap.includes('value="•••"'), snap);
  check('snapshot finds cursor:pointer div', /clickable "Custom clickable" \[ref=e\d+\]/.test(snap), snap);
  check('snapshot reads same-origin iframe', /iframe\n\s+- button "Frame button" \[ref=e\d+\]/.test(snap), snap);

  r = await a.tool('type', { ref: refFor(snap, /textbox "Name[^"]*" \[ref=(e\d+)\]/), text: 'Ada', clear: true });
  check('type into ref', !r.isError, r.text);
  r = await a.tool('set_value', { ref: refFor(snap, /combobox "Colour" \[ref=(e\d+)\]/), value: 'Blue' });
  check('set_value select', !r.isError && /Blue/.test(r.text), r.text);
  r = await a.tool('set_value', { ref: refFor(snap, /checkbox "I agree" \[ref=(e\d+)\]/), value: true });
  check('set_value checkbox', !r.isError && /checked/.test(r.text), r.text);
  r = await a.tool('click', { ref: refFor(snap, /button "Greet" \[ref=(e\d+)\]/) });
  check('click button', !r.isError, r.text);
  r = await a.tool('evaluate', { expression: 'document.getElementById("out").textContent' });
  check('real events reached the page', r.text === 'Hello, Ada! Blue true', r.text);

  r = await a.tool('type', { ref: refFor(snap, /textbox "Name[^"]*" \[ref=(e\d+)\]/), text: 'Hermes', clear: true });
  r = await a.tool('evaluate', { expression: 'document.getElementById("name").value' });
  check('type with clear replaces', r.text === 'Hermes', r.text);

  r = await a.tool('click', { ref: refFor(snap, /clickable "Custom clickable" \[ref=(e\d+)\]/) });
  r = await a.tool('click', { ref: refFor(snap, /button "Frame button" \[ref=(e\d+)\]/) });
  r = await a.tool('snapshot', { interactiveOnly: true });
  check('click on div and inside iframe', /Card clicked/.test(r.text) && /Frame clicked/.test(r.text), r.text);

  // Cross-origin frame: readable in the outline, and usable by ref.
  const snapX = (await a.tool('snapshot')).text;
  check('snapshot reads a cross-origin iframe', /- iframe http:\/\/localhost:\d+\/cross\n\s+- text "Text inside the cross-origin frame[^\n]*\n\s+- button "Cross button" \[ref=f\d+\.e\d+\]/.test(snapX), snapX);
  r = await a.tool('click', { ref: refFor(snapX, /button "Cross button" \[ref=(f\d+\.e\d+)\]/) });
  r = await a.tool('set_value', { ref: refFor(snapX, /textbox "Cross field" \[ref=(f\d+\.e\d+)\]/), value: 'typed across' });
  const snapY = (await a.tool('snapshot')).text;
  check('click and set_value inside a cross-origin iframe', /button "Cross clicked"/.test(snapY) && /value="typed across"/.test(snapY), r.text + '\n' + snapY);
  r = await a.tool('type', { ref: refFor(snapY, /textbox "Cross field" \[ref=(f\d+\.e\d+)\]/), text: 'retyped', clear: true });
  r = await a.tool('find', { query: 'cross field' });
  check('type with clear inside a cross-origin iframe; find sees it', /value="retyped"/.test(r.text), r.text);
  r = await a.tool('get_text');
  check('get_text includes embedded frame text', /embedded frame: http:\/\/localhost:\d+\/cross/.test(r.text) && /Text inside the cross-origin frame/.test(r.text), r.text);

  r = await a.tool('scroll', { direction: 'down', amount: 500 });
  check('scroll', /position: [1-9]\d* of/.test(r.text), r.text);

  r = await a.tool('screenshot');
  const size = r.image && jpegSize(r.image.data);
  const vp = JSON.parse((await a.tool('evaluate', { expression: 'JSON.stringify([document.documentElement.clientWidth, innerHeight, devicePixelRatio])' })).text);
  check(`screenshot in CSS pixels at dpr ${vp[2]} (${size?.w}x${size?.h} vs viewport ${vp[0]}x${vp[1]})`,
    size && Math.abs(size.w - vp[0]) <= 2 && Math.abs(size.h - vp[1]) <= 2 && vp[2] === 2, r.text);

  r = await a.tool('console_messages');
  check('console_messages replays earlier logs', /\[log\] page loaded 42/.test(r.text), r.text);
  r = await a.tool('status');
  check('debugger attached while acting', /attached to tab/.test(r.text), r.text);

  const pt = JSON.parse((await a.tool('evaluate', { expression: '(() => { pad.scrollIntoView({block:"center"}); const r = pad.getBoundingClientRect(); const q = para.getBoundingClientRect(); return JSON.stringify([Math.round(r.left), Math.round(r.top + 30), Math.round(q.left + 30), Math.round(q.top + q.height / 2)]); })()' })).text);
  r = await a.tool('drag', { fromX: pt[0] + 20, fromY: pt[1], toX: pt[0] + 220, toY: pt[1] });
  const d = JSON.parse((await a.tool('evaluate', { expression: 'JSON.stringify([+pad.dataset.down, +pad.dataset.up, +pad.dataset.moves])' })).text);
  check('drag presses, moves and releases', d[1] - d[0] === 200 && d[2] >= 10, JSON.stringify(d) + ' ' + r.text);
  await a.tool('click', { x: pt[2], y: pt[3], tripleClick: true });
  r = await a.tool('evaluate', { expression: 'getSelection().toString().trim()' });
  check('tripleClick selects the paragraph', r.text === 'Triple click selects this whole paragraph of text.', r.text);
  r = await a.tool('zoom', { x0: 0, y0: 0, x1: 300, y1: 150 });
  const zs = r.image && jpegSize(r.image.data);
  check(`zoom enlarges (${zs?.w}x${zs?.h})`, zs && zs.w >= 1190 && zs.w <= 1210, r.text);
  const snap2 = (await a.tool('snapshot')).text;
  const tmpFile = path.join(os.tmpdir(), 'hbb-upload-test.txt');
  fs.writeFileSync(tmpFile, 'hello');
  r = await a.tool('upload_file', { ref: refFor(snap2, /file-input "Attachment" \[ref=(e\d+)\]/), paths: [tmpFile] });
  const up = (await a.tool('evaluate', { expression: 'file.files[0] ? file.files[0].name + ":" + file.files[0].size : "none"' })).text;
  check('upload_file', up === 'hbb-upload-test.txt:5', r.text + ' / ' + up);
  fs.rmSync(tmpFile, { force: true });

  // Images: the last screenshot into a file input and as a paste; a file as a drop.
  await a.tool('screenshot');
  r = await a.tool('upload_image', { ref: refFor(snap2, /file-input "Attachment" \[ref=(e\d+)\]/) });
  let got = (await a.tool('evaluate', { expression: 'file.files[0].name + ":" + file.files[0].type + ":" + (file.files[0].size > 1000)' })).text;
  check('upload_image into a file input', got === 'screenshot.jpg:image/jpeg:true', r.text + ' / ' + got);
  r = await a.tool('upload_image', { ref: refFor(snap2, /textbox "Paste zone" \[ref=(e\d+)\]/), filename: 'shot.jpg' });
  got = (await a.tool('evaluate', { expression: 'pastezone.dataset.got' })).text;
  check('upload_image as a paste', got === 'shot.jpg:image/jpeg:true' && /accepted/.test(r.text), r.text + ' / ' + got);
  const pngFile = path.join(sandbox, 'tiny.png');
  fs.writeFileSync(pngFile, Buffer.from(TINY_PNG, 'base64'));
  r = await a.tool('upload_image', { ref: refFor(snap2, /button "Drop zone" \[ref=(e\d+)\]/), mode: 'drop', path: pngFile });
  got = (await a.tool('evaluate', { expression: 'dropzone.dataset.got' })).text;
  check('upload_image of a file as a drop', got === 'tiny.png:image/png' && /accepted/.test(r.text), r.text + ' / ' + got);

  // GIF recording.
  r = await a.tool('gif_recorder', { action: 'start' });
  check('gif_recorder start', !r.isError && /Recording tab/.test(r.text), r.text);
  await a.tool('click', { ref: refFor(snap2, /button "Greet" \[ref=(e\d+)\]/) });
  await a.tool('scroll', { direction: 'down', amount: 250 });
  await a.tool('set_value', { ref: refFor(snap2, /combobox "Colour" \[ref=(e\d+)\]/), value: 'Green' });
  r = await a.tool('gif_recorder', { action: 'stop' });
  const nFrames = Number(/with (\d+) frame/.exec(r.text)?.[1]);
  check(`gif_recorder stop (${nFrames} frames)`, nFrames >= 3 && nFrames <= 5, r.text);
  r = await a.tool('gif_recorder', { action: 'export', filename: 'e2e demo', frameDelayMs: 300 });
  const gifPath = /Saved to (.+\.gif)/.exec(r.text)?.[1];
  const gif = gifPath && fs.existsSync(gifPath) ? fs.readFileSync(gifPath) : null;
  check('gif_recorder export writes a GIF file', !!gif && gif.subarray(0, 6).toString() === 'GIF89a' && gif.readUInt16LE(6) === 800 && /e2e_demo\.gif$/.test(gifPath), r.text);
  if (gif) {
    const decoded = (await a.tool('evaluate', { expression: `(async () => { const buf = await (await fetch('data:image/gif;base64,${gif.toString('base64')}')).arrayBuffer(); const d = new ImageDecoder({ data: buf, type: 'image/gif' }); await d.tracks.ready; const n = d.tracks.selectedTrack.frameCount; let w = 0; for (let i = 0; i < n; i++) { const f = (await d.decode({ frameIndex: i })).image; w = f.displayWidth; f.close(); } return n + ' frames, width ' + w; })()` })).text;
    check(`the browser decodes every GIF frame (${decoded})`, decoded === `${nFrames} frames, width 800`, decoded);
  }
  r = await a.tool('network_requests');
  check('network_requests turns capture on', /capture is now on/.test(r.text), r.text);
  await a.tool('navigate', { url: 'reload' });
  r = await a.tool('network_requests', { urlPattern: '/frame' });
  check('network_requests lists requests', /200 GET http:\/\/127\.0\.0\.1:\d+\/frame/.test(r.text), r.text);
  r = await a.tool('resize_window', { width: 900, height: 650 });
  // The headless test browser has no screen, so only the call path is checked here.
  check('resize_window (call path only)', !r.isError || /visible screen space/.test(r.text), r.text);
  r = await a.tool('batch', { actions: [{ name: 'snapshot', arguments: { interactiveOnly: true } }, { name: 'press_key', arguments: { key: 'Tab' } }, { name: 'get_text', arguments: { maxChars: 100 } }] });
  check('batch runs steps in order', !r.isError && /\[1\/3\] snapshot:/.test(r.text) && /\[3\/3\] get_text:/.test(r.text), r.text.slice(0, 400));
  r = await a.tool('batch', { actions: [{ name: 'get_text' }, { name: 'click', arguments: { ref: 'e9999' } }, { name: 'get_text' }] });
  check('batch stops at the first error', r.isError && /\[2\/3\] click failed/.test(r.text), r.text);

  r = await a.tool('press_key', { key: 'ctrl+Home' });
  r = await a.tool('snapshot', { interactiveOnly: true });
  r = await a.tool('click', { ref: refFor(r.text, /link "Go to second page" \[ref=(e\d+)\]/) });
  r = await a.tool('get_text');
  check('link click navigates; get_text', /Second page/.test(r.text) && /\/second/.test(r.text), r.text);

  r = await a.tool('snapshot');
  const alertRef = refFor(r.text, /button "Alert" \[ref=(e\d+)\]/);
  await a.tool('click', { ref: alertRef });
  r = await a.tool('handle_dialog', { accept: true });
  check('handle_dialog', /Accepted alert dialog: "boo"/.test(r.text), r.text);

  r = await a.tool('navigate', { url: 'back' });
  check('navigate back', /Bridge Test/.test(r.text), r.text);
  r = await a.tool('navigate', { url: 'javascript:alert(1)' });
  check('javascript: URLs rejected', r.isError, r.text);
  r = await a.tool('click', { ref: 'e9999' });
  check('stale ref gives a clear error', r.isError && /snapshot/.test(r.text), r.text);

  r = await a.tool('tab_new', { url: base + '/second' });
  await a.tool('click', { x: 5, y: 5 });
  const during = (await a.tool('status')).text;
  await a.tool('wait', { seconds: 22 });
  r = await a.tool('status');
  const newId = /tab (\d+)/.exec((await a.tool('tabs_list')).text.split('\n').find((l) => /current Hermes tab/.test(l)) || '')?.[1];
  check('debugger released about 15 s after the last action', during.includes(newId) && !r.text.includes(newId), `${newId} | ${during} | ${r.text}`);
  await a.tool('tab_close', { tabId: Number(newId) });
  await a.tool('navigate', { url: base + '/', tabId: Number(/\[tab (\d+)\] Bridge Test/.exec((await a.tool('tabs_list')).text)?.[1]) });

  // Second bridge instance must relay through the first.
  const b = new Mcp('bridge-B');
  await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  r = await b.tool('tabs_list');
  check('second bridge relays through hub', !r.isError && /Bridge Test/.test(r.text), r.text);

  // Hub exits: the client takes over the port and the extension reconnects to it.
  a.stop();
  await new Promise((res) => setTimeout(res, 500));
  const t0 = Date.now();
  r = await b.tool('get_text');
  check(`failover after hub exit (${Math.round((Date.now() - t0) / 1000)} s)`, !r.isError && /Bridge test page/.test(r.text), r.text);
  b.stop();
} finally {
  chrome.kill();
  web.close();
  a.stop();
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser still releasing files */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* same */ }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
