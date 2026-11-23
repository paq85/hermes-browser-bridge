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

const VERSION = '0.5.0';
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
// Content types for uploads, so pages that check file.type see what a real picker gives them.
const MIME_TYPES = {
  ...IMAGE_TYPES, '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.avif': 'image/avif',
  '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.rtf': 'application/rtf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
};
const CONTENT_LIMIT = 25 * 1024 * 1024; // when files must travel by content rather than by path

function expandHome(p) {
  return p === '~' ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p;
}

// Normalises the ways an agent may write a local path, and refuses the ones
// that are ambiguous or reach beyond this computer.
function normaliseUploadPath(raw) {
  let p = String(raw).trim().replace(/^"(.*)"$/, '$1');
  if (/^file:\/\//i.test(p)) {
    try { p = fileURLToPath(p); } catch { throw new Error(`Not a usable file URL: "${raw}". Pass a plain absolute path.`); }
  }
  p = expandHome(p);
  if (process.platform === 'win32') {
    // Network shares and device paths would make this computer contact another machine.
    if (/^[\\/]{2}/.test(p)) throw new Error(`Network and device paths are not allowed for uploads (got "${raw}"). Copy the file to this computer first.`);
    // Git Bash / MSYS style: /c/Users/... means C:\Users\...
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(p);
    if (msys) p = `${msys[1].toUpperCase()}:\\${p.slice(3).replace(/\//g, '\\')}`;
    if (!/^[a-zA-Z]:[\\/]/.test(p)) throw new Error(`Use a full path with a drive letter, like C:\\Users\\me\\file.pdf (got "${raw}").`);
  } else if (!path.isAbsolute(p)) {
    throw new Error(`Use an absolute path (got "${raw}"). Relative paths are ambiguous here.`);
  }
  return path.resolve(p);
}

// Checks every path before the browser sees it, so mistakes come back as
// clear messages instead of an empty or half-filled upload.
function resolveUploadPaths(paths) {
  const list = Array.isArray(paths) ? paths : typeof paths === 'string' ? [paths] : [];
  if (!list.length) throw new Error('paths is required: absolute paths of the files to upload.');
  if (list.length > 100) throw new Error('At most 100 files per upload.');
  return list.map((raw) => {
    const abs = normaliseUploadPath(raw);
    let st;
    try { st = fs.statSync(abs); } catch { throw new Error(`No such file: ${abs}`); }
    if (!st.isFile() && !st.isDirectory()) throw new Error(`Not a regular file or folder: ${abs}`);
    return {
      path: abs, name: path.basename(abs), size: st.isFile() ? st.size : 0, isDir: st.isDirectory(),
      type: st.isFile() ? (MIME_TYPES[path.extname(abs).toLowerCase()] || '') : '', lastModified: Math.round(st.mtimeMs),
      ...(st.isDirectory() ? { children: listFolder(abs) } : {}),
    };
  });
}

// Every regular file inside a folder (recursively, not following links out of
// it), for passing a folder by content.
function listFolder(dir, out = [], limit = 5000, depth = 0) {
  if (depth > 32) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= limit) break;
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFolder(p, out, limit, depth + 1);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// Reads a file, stopping once it is larger than `budget` bytes (stat sizes
// can be wrong or change), in chunks so small files stay cheap.
function readCapped(p, budget) {
  const fd = fs.openSync(p, 'r');
  try {
    const parts = [];
    let total = 0;
    const chunk = Buffer.alloc(1024 * 1024);
    for (let r; (r = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      parts.push(Buffer.from(chunk.subarray(0, r)));
      total += r;
      if (total > budget) break;
    }
    return Buffer.concat(parts, total);
  } finally {
    fs.closeSync(fd);
  }
}

// Reads files (and the files inside folders, with their path inside the
// folder) for passing by content, within the 25 MB limit.
function readUploadBytes(files, why, fix) {
  const entries = [];
  for (const f of files) {
    if (!f.isDir) { entries.push({ p: f.path, rel: '' }); continue; }
    for (const p of f.children || []) entries.push({ p, rel: [f.name, ...path.relative(f.path, p).split(path.sep)].join('/') });
  }
  if (entries.length > 1000) throw new Error(`${why} That is ${entries.length} files, more than the 1000 that can be passed by content. ${fix}`);
  let left = CONTENT_LIMIT;
  return entries.map(({ p, rel }) => {
    const buf = readCapped(p, left);
    if (buf.length > left) throw new Error(`${why} These files total more than the 25 MB that can be passed by content. ${fix}`);
    left -= buf.length;
    const st = fs.statSync(p);
    return { name: path.basename(p), rel, type: MIME_TYPES[path.extname(p).toLowerCase()] || '', lastModified: Math.round(st.mtimeMs), data: buf.toString('base64') };
  });
}

const ACCESS_FIX = 'Turn on "Allow access to file URLs" for Hermes Browser Bridge on the browser\'s extensions page (Details), then try again.';
const SMALLER_FIX = 'Pass fewer or smaller files.';

// upload_file: the bridge checks the paths, then the extension does the
// upload. When the extension can only take the files' contents (a setting is
// off, a folder, or a File System Access picker), it says so with a code and
// the bridge resends the same request with the contents, tied to the picker
// the first attempt opened.
async function uploadFile(args) {
  // Only the documented arguments reach the extension; the rest is set here.
  const pick = (o) => Object.fromEntries(['ref', 'x', 'y', 'via', 'cancel', 'clear', 'tabId'].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  if (args.cancel || args.clear) return callBrowser('upload_file', pick(args));
  const files = resolveUploadPaths(args.paths);
  const base = pick(args);
  if ((base.via === 'drop' || base.via === 'paste') && files.some((f) => f.isDir)) {
    throw new Error(`Folders cannot be ${base.via === 'drop' ? 'dropped' : 'pasted'}; pass the files inside it instead (or use the page's folder upload input).`);
  }
  let call = { ...base, files };
  if (call.via === 'paste') call.bytes = readUploadBytes(files, "Pasting needs the files' contents.", SMALLER_FIX);
  let tip = '';
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await callBrowser('upload_file', call);
      return tip ? { ...r, text: `${r?.text || ''}\n${tip}` } : r;
    } catch (e) {
      const m = /^(FILE_ACCESS_DENIED|FOLDER_BY_CONTENT|FSA_PICKER)(?:#(\w+))?:/.exec(String(e.message));
      if (!m || attempt >= 3) throw e;
      const [, code, picker] = m;
      if (picker) call = { ...call, retryPicker: picker };
      if (code === 'FSA_PICKER') {
        if (files.some((f) => f.isDir)) throw new Error('This page\'s file picker takes files, not a folder. Pass the files.');
        call = { ...call, fsaFiles: call.fsaFiles || readUploadBytes(files, "This page uses the File System Access picker, which can only be answered with the files' contents.", SMALLER_FIX) };
      } else if (code === 'FOLDER_BY_CONTENT') {
        call = { ...call, bytes: readUploadBytes(files, 'This browser does not list folders handed over by an extension, so the folder\'s files are passed by content.', 'Upload the files individually, or a smaller folder.'), bytesReason: 'folder' };
      } else {
        call = { ...call, bytes: call.bytes || readUploadBytes(files, 'The extension is not allowed to read local files.', ACCESS_FIX), bytesReason: 'access' };
        tip = 'Tip: turn on "Allow access to file URLs" for Hermes Browser Bridge (browser extensions page > Details) to upload by path: any size, and the same events a real file picker produces.';
      }
    }
  }
}

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
  const r = (name === 'upload_file' ? await uploadFile(args) : await callBrowser(name, args)) || {};
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
