#!/usr/bin/env node
// Hermes Browser Bridge: an MCP stdio server that relays tool calls to the
// browser extension over a localhost WebSocket.
//
// Several copies may run at once (one per Hermes session). The first one to
// bind the port is the "hub" and owns the extension connection; the others
// connect to it as clients and relay through it. If the hub exits, a client
// takes over the port and the extension reconnects to it.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
// ws is vendored (bridge/vendor/ws, MIT) so the plugin runs without `npm install`.
import { WebSocketServer, WebSocket } from './vendor/ws/wrapper.mjs';
import { TOOLS, INSTRUCTIONS } from './tools.mjs';

const VERSION = '0.4.1';
const DEFAULT_PORT = 38917;
const CONNECT_WAIT_MS = 40_000; // the extension retries every 30 s
const CALL_TIMEOUT_MS = 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));

// The pairing (port + shared token) lives in one per-user file so every Hermes
// profile and every installed copy of this plugin agrees on it. It is mirrored
// into this copy's extension folder, which is where the extension reads it.
const PAIRING_PATH = process.env.HERMES_BROWSER_BRIDGE_CONFIG || path.join(os.homedir(), '.hermes-browser-bridge', 'config.json');
// (Both paths can be overridden so the test suite never touches the real pairing.)
const EXTENSION_COPY = path.join(process.env.HERMES_BROWSER_BRIDGE_EXTENSION_DIR || path.join(here, '..', 'extension'), 'config.json');

const OUTPUT_DIR = process.env.HERMES_BROWSER_BRIDGE_OUTPUT_DIR || path.join(os.homedir(), '.hermes-browser-bridge', 'recordings');
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const log = (...a) => process.stderr.write(`[hermes-browser-bridge ${process.pid}] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On Windows a process's working directory cannot be renamed or deleted. If we
// were started inside the plugin folder, step out so `hermes plugins update`
// can replace it while this bridge is running.
try {
  const rel = path.relative(path.resolve(here, '..'), process.cwd());
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    const data = process.env.PLUGIN_DATA;
    process.chdir(data && fs.existsSync(data) ? data : os.homedir());
  }
} catch { /* staying put only blocks updates */ }

function readPairing(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(c.port) && typeof c.token === 'string' && c.token.length >= 32) return { port: c.port, token: c.token };
  } catch { /* missing or unreadable */ }
  return null;
}

function loadConfig() {
  let c = readPairing(PAIRING_PATH);
  if (!c) {
    c = readPairing(EXTENSION_COPY) || { port: DEFAULT_PORT, token: crypto.randomBytes(32).toString('hex') };
    fs.mkdirSync(path.dirname(PAIRING_PATH), { recursive: true });
    fs.writeFileSync(PAIRING_PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
    log('wrote pairing to', PAIRING_PATH);
  }
  const mirrored = readPairing(EXTENSION_COPY);
  if (!mirrored || mirrored.port !== c.port || mirrored.token !== c.token) {
    try {
      fs.writeFileSync(EXTENSION_COPY, JSON.stringify(c, null, 2) + '\n');
      log('updated', EXTENSION_COPY);
    } catch (e) {
      log(`could not write ${EXTENSION_COPY}: ${e.message}. Copy ${PAIRING_PATH} there by hand.`);
    }
  }
  return c;
}

const cfg = loadConfig();
const hmac = (msg) => crypto.createHmac('sha256', cfg.token).update(msg).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- transport

let role = null;   // 'hub' | 'client'
let ext = null;    // hub: authenticated extension socket
let relay = null;  // client: socket to the hub
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer, sock }

const transport = () => (role === 'hub' ? ext : relay && relay.readyState === WebSocket.OPEN ? relay : null);

function failPending(sock, reason) {
  for (const [id, p] of pending) {
    if (p.sock !== sock) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(reason));
  }
}

function settle(m) {
  const p = pending.get(m.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(m.id);
  if (m.error !== undefined) p.reject(new Error(String(m.error)));
  else p.resolve(m.result);
}

async function callBrowser(method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const deadline = Date.now() + CONNECT_WAIT_MS;
  let sock;
  while (!(sock = transport())) {
    if (Date.now() > deadline) {
      throw new Error('The Hermes Browser Bridge extension is not connected. Check that the browser is running and the extension is installed and switched on (toolbar icon); it reconnects within 30 seconds.');
    }
    await sleep(250);
  }
  // A client's request passes through the hub, which may itself wait for the extension.
  const total = role === 'client' ? timeoutMs + CONNECT_WAIT_MS + 5000 : timeoutMs;
  return new Promise((resolve, reject) => {
    const id = `${process.pid}-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser did not answer "${method}" within ${Math.round(total / 1000)} s.`));
    }, total);
    pending.set(id, { resolve, reject, timer, sock });
    sock.send(JSON.stringify({ id, method, params }));
  });
}

function acceptExtension(sock) {
  let state = 'new';
  const myNonce = crypto.randomBytes(16).toString('hex');
  const authTimer = setTimeout(() => { if (state !== 'ready') sock.close(); }, 5000);
  sock.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (state === 'new' && m.type === 'hello' && typeof m.nonce === 'string') {
      state = 'challenged';
      sock.send(JSON.stringify({ type: 'hello_ack', proof: hmac('bridge:' + m.nonce), nonce: myNonce }));
    } else if (state === 'challenged' && m.type === 'auth') {
      if (!safeEq(m.proof, hmac('ext:' + myNonce))) { log('extension failed authentication'); sock.close(); return; }
      state = 'ready';
      clearTimeout(authTimer);
      const old = ext;
      ext = sock;
      if (old) { failPending(old, 'Extension reconnected; retry.'); old.close(); }
      sock.send(JSON.stringify({ type: 'ready' }));
      log('extension connected');
    } else if (state === 'ready' && m.id) {
      settle(m);
    }
  });
  sock.on('close', () => {
    clearTimeout(authTimer);
    failPending(sock, 'The browser extension disconnected.');
    if (ext === sock) { ext = null; log('extension disconnected'); }
  });
  sock.on('error', () => {});
}

function acceptClient(sock) {
  sock.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m.id || !m.method) return;
    let reply;
    try { reply = { id: m.id, result: await callBrowser(m.method, m.params) }; }
    catch (e) { reply = { id: m.id, error: e.message }; }
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
  });
  sock.on('error', () => {});
}

function tryHub() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin || '';
      const url = (req.url || '').split('?')[0];
      if (url === '/extension' && origin.startsWith('chrome-extension://')) {
        wss.handleUpgrade(req, socket, head, acceptExtension);
      } else if (url === '/client' && !origin && safeEq(req.headers['x-bridge-token'] || '', cfg.token)) {
        wss.handleUpgrade(req, socket, head, acceptClient);
      } else {
        socket.destroy();
      }
    });
    server.once('error', () => resolve(false));
    server.listen({ port: cfg.port, host: '127.0.0.1', exclusive: true }, () => {
      role = 'hub';
      log(`listening on 127.0.0.1:${cfg.port} (hub)`);
      resolve(true);
    });
  });
}

function tryClient() {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/client`, { headers: { 'x-bridge-token': cfg.token }, maxPayload: 64 * 1024 * 1024 });
    let opened = false;
    sock.on('open', () => { opened = true; role = 'client'; relay = sock; log('relaying through existing bridge (client)'); resolve(true); });
    sock.on('message', (raw) => { try { settle(JSON.parse(raw)); } catch { /* ignore */ } });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (!opened) { resolve(false); return; }
      relay = null;
      role = null;
      failPending(sock, 'Lost connection to the bridge hub; retry.');
      establish();
    });
  });
}

let establishing = false;
async function establish() {
  if (establishing) return;
  establishing = true;
  for (let attempt = 0; role === null; attempt++) {
    if (await tryHub()) break;
    if (await tryClient()) break;
    if (attempt === 5) log(`port ${cfg.port} is in use by something that is not this bridge; still retrying`);
    await sleep(300 + Math.random() * 700);
  }
  establishing = false;
}

// Keeps the extension's service worker alive while we are connected.
setInterval(() => { if (ext?.readyState === WebSocket.OPEN) ext.send('{"type":"ping"}'); }, 20_000);

// ---------------------------------------------------------------------- MCP

const toolNames = new Set(TOOLS.map((t) => t.name));

async function callTool(name, args) {
  if (!toolNames.has(name)) throw new Error(`Unknown tool: ${name}`);
  if (name === 'wait') {
    const s = Math.min(Math.max(Number(args.seconds) || 0, 0), 30);
    await sleep(s * 1000);
    return [{ type: 'text', text: `Waited ${s} s.` }];
  }
  if (name === 'batch') {
    const actions = Array.isArray(args.actions) ? args.actions.slice(0, 20) : [];
    if (!actions.length) throw new Error('actions must be a non-empty array of { name, arguments }.');
    const out = [];
    for (const [i, a] of actions.entries()) {
      const label = `[${i + 1}/${actions.length}] ${a?.name}`;
      try {
        if (a?.name === 'batch') throw new Error('batch cannot be nested.');
        const part = await callTool(a?.name, a?.arguments || {});
        out.push({ type: 'text', text: label + ':' }, ...part);
      } catch (e) {
        throw new Error(`${label} failed: ${e.message}` + (i ? ` (the ${i} step(s) before it succeeded)` : ''));
      }
    }
    return out;
  }
  if (name === 'upload_image' && args.path) {
    // The extension cannot read local files; send the image along with the call.
    const file = path.resolve(String(args.path));
    const mimeType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mimeType) throw new Error('path must be a .png, .jpg, .jpeg, .gif or .webp file.');
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`No such file: ${file}`);
    if (stat.size > 15 * 1024 * 1024) throw new Error('Image is larger than 15 MB.');
    const { path: _omit, ...rest } = args;
    args = { ...rest, image: { data: fs.readFileSync(file).toString('base64'), mimeType, name: path.basename(file) } };
  }
  const r = (await callBrowser(name, args)) || {};
  const content = [];
  if (r.text) content.push({ type: 'text', text: String(r.text) });
  if (r.file) {
    // Files the extension produces (GIF recordings) are saved here, where Hermes can read them.
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const base = path.basename(String(r.file.name)).replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'recording';
    const out = path.join(OUTPUT_DIR, `${base}.${r.file.ext}`);
    fs.writeFileSync(out, Buffer.from(r.file.data, 'base64'));
    content.push({ type: 'text', text: `Saved to ${out}` });
  }
  if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
  if (!content.length) content.push({ type: 'text', text: 'Done.' });
  return content;
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'hermes-browser-bridge', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'notifications/initialized':
      // A host that keeps running across plugin updates may hold the previous
      // version's tool list; tell it to read ours.
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n'), 500);
      return null;
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      try {
        return ok({ content: await callTool(params?.name, params?.arguments || {}) });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
      }
    default:
      return isRequest ? err(-32601, `Method not found: ${method}`) : null;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    return;
  }
  const reply = await handleRpc(msg);
  if (reply && msg.id !== undefined && msg.id !== null) process.stdout.write(JSON.stringify(reply) + '\n');
});
rl.on('close', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

establish();
