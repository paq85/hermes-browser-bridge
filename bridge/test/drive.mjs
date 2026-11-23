// Manual and exploratory testing: starts a throwaway Chromium with a private
// copy of the extension and the bridge, allows all sites, and exposes the
// bridge's tools over local HTTP so they can be called from a shell:
//
//   node test/drive.mjs <state-file.json> [--headed]
//   curl -s -X POST http://127.0.0.1:<port>/tool -d '{"name":"tab_new","arguments":{"url":"https://example.com"}}'
//
// The state file receives {"port": <http port>, "pid": ...} once ready.
// POST /quit (or 20 minutes without calls) shuts everything down.

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
const stateFile = process.argv[2];
if (!stateFile) { console.error('usage: node test/drive.mjs <state-file.json> [--headed]'); process.exit(2); }
const headed = process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
const chromium = fs.readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()
  .map((d) => fs.readdirSync(path.join(root, d)).map((s) => path.join(root, d, s, 'chrome.exe')).find((p) => fs.existsSync(p))).find(Boolean);
if (!chromium) throw new Error('No Playwright Chromium found');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hbb-drive-'));
const extDir = path.join(sandbox, 'extension');
fs.cpSync(path.resolve(here, '..', '..', 'extension'), extDir, { recursive: true });
const pairing = { port: 41000 + Math.floor(Math.random() * 3000), token: crypto.randomBytes(32).toString('hex') };
fs.writeFileSync(path.join(sandbox, 'pairing.json'), JSON.stringify(pairing));
fs.writeFileSync(path.join(extDir, 'config.json'), JSON.stringify(pairing));
const dbgPort = 45000 + Math.floor(Math.random() * 3000);

const bridge = spawn(process.execPath, [path.resolve(here, '..', 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HERMES_BROWSER_BRIDGE_CONFIG: path.join(sandbox, 'pairing.json'), HERMES_BROWSER_BRIDGE_EXTENSION_DIR: extDir, HERMES_BROWSER_BRIDGE_OUTPUT_DIR: path.join(sandbox, 'out') },
});
bridge.stderr.on('data', () => {});
const waiting = new Map();
let seq = 0;
readline.createInterface({ input: bridge.stdout }).on('line', (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); });
const rpc = (method, params) => new Promise((res) => { const id = ++seq; waiting.set(id, res); bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'drive', version: '0' } });

const browser = spawn(chromium, [
  `--user-data-dir=${path.join(sandbox, 'profile')}`, `--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`,
  ...(headed ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
  `--remote-debugging-port=${dbgPort}`, 'about:blank',
], { stdio: 'ignore' });

// Allow all sites (as a user choosing that in the popup would).
async function allowAllSites() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(list.find((t) => /\/sw\.js$/.test(t.url))?.url || '')?.[1];
      if (id) {
        const t = await (await fetch(`http://127.0.0.1:${dbgPort}/json/new?chrome-extension://${id}/popup.html`, { method: 'PUT' })).json();
        await sleep(500);
        const sock = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
        const done = new Promise((res) => sock.on('message', res));
        sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { awaitPromise: true, expression: 'chrome.storage.local.set({ siteMode: "all" })' } }));
        await done;
        sock.close();
        await fetch(`http://127.0.0.1:${dbgPort}/json/close/${t.id}`);
        return;
      }
    } catch { /* starting */ }
    await sleep(200);
  }
  throw new Error('extension did not start');
}
await allowAllSites();

let last = Date.now();
const server = http.createServer(async (req, res) => {
  last = Date.now();
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/quit') { res.end('bye'); shutdown(); return; }
  if (req.url !== '/tool' || req.method !== 'POST') { res.writeHead(404); res.end('POST /tool or /quit'); return; }
  try {
    const { name, arguments: args = {} } = JSON.parse(body || '{}');
    const r = await rpc('tools/call', { name, arguments: args });
    const content = r.result?.content || [];
    let text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const img = content.find((c) => c.type === 'image');
    if (img) {
      const f = path.join(sandbox, `shot-${Date.now()}.jpg`);
      fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
      text += `\n[image saved to ${f}]`;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ isError: !!r.result?.isError, text }));
  } catch (e) {
    res.writeHead(500); res.end(String(e.message));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
fs.writeFileSync(stateFile, JSON.stringify({ port: server.address().port, pid: process.pid, sandbox, debugPort: dbgPort }));
console.log(`ready on http://127.0.0.1:${server.address().port}`);

function shutdown() {
  try { browser.kill(); } catch { /* gone */ }
  try { bridge.stdin.end(); bridge.kill(); } catch { /* gone */ }
  server.close();
  setTimeout(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* busy */ } process.exit(0); }, 800);
}
setInterval(() => { if (Date.now() - last > 20 * 60_000) shutdown(); }, 30_000);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
