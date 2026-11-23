// Upload tests: every way a site can take files (file inputs visible, hidden,
// labelled, detached, in shadow DOM and frames; buttons that open a picker;
// drop zones; paste targets; File System Access pickers), plus the safety and
// fallback rules. Driven exactly as Hermes would, through the MCP bridge.

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from '../vendor/ws/wrapper.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A raw DevTools connection to a page of the test browser (not through the
// extension): used to act as "the user" and to change extension settings.
async function devtools(dbgPort, match) {
  let t = null;
  for (let i = 0; i < 50 && !t; i++) {
    const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
    t = list.find((x) => x.type === 'page' && match(x.url));
    if (!t) await sleep(100);
  }
  if (!t) throw new Error('no matching page');
  const sock = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej); });
  let n = 0;
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++n;
    const on = (m) => { const d = JSON.parse(m); if (d.id === id) { sock.off('message', on); res(d); } };
    sock.on('message', on);
    sock.send(JSON.stringify({ id, method, params }));
    setTimeout(() => res(null), 10000);
  });
  return { send, close: () => sock.close(), target: t };
}

// Runs an expression in the extension's popup page (as the user using the popup would).
async function inPopup(dbgPort, expression) {
  const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
  const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(list.find((t) => /\/sw\.js$/.test(t.url))?.url || '')?.[1];
  const t = await (await fetch(`http://127.0.0.1:${dbgPort}/json/new?chrome-extension://${id}/popup.html`, { method: 'PUT' })).json();
  const page = await devtools(dbgPort, (u) => u.startsWith(`chrome-extension://${id}/popup.html`));
  let value;
  for (let i = 0; i < 50; i++) {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    value = r?.result?.result?.value;
    if (value !== undefined) break;
    await sleep(100);
  }
  page.close();
  await fetch(`http://127.0.0.1:${dbgPort}/json/close/${t.id}`);
  return value;
}

export async function uploadTests({ a, base, check, refFor, sandbox, dbgPort }) {
  // ---------------------------------------------------------------- fixtures
  const dir = path.join(sandbox, 'uploads');
  fs.mkdirSync(path.join(dir, 'album', 'sub'), { recursive: true });
  const fA = path.join(dir, 'alpha.txt'); fs.writeFileSync(fA, 'alpha file content');
  const fB = path.join(dir, 'bravo.txt'); fs.writeFileSync(fB, 'bravo file content');
  const fPng = path.join(dir, 'pixel.png');
  fs.writeFileSync(fPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const fUni = path.join(dir, 'zażółć gęślą jaźń.txt'); fs.writeFileSync(fUni, 'unicode name');
  const fBig = path.join(dir, 'big.bin'); fs.writeFileSync(fBig, Buffer.alloc(40 * 1024 * 1024, 7));
  const fMid = path.join(dir, 'mid.bin'); fs.writeFileSync(fMid, Buffer.alloc(6 * 1024 * 1024, 65));
  fs.writeFileSync(path.join(dir, 'album', 'one.txt'), 'one');
  fs.writeFileSync(path.join(dir, 'album', 'sub', 'two.txt'), 'two');
  const fDir = path.join(dir, 'album');

  // Uploads run with all sites allowed; localhost (the cross-site frames) was
  // blocked by the earlier permission tests, and blocks still apply.
  await inPopup(dbgPort, 'chrome.storage.local.set({ siteMode: "all" }).then(() => "ok")');
  let r = await a.tool('tab_new', { url: base + '/upload' });
  const tabId = Number(/\[tab (\d+)\]/.exec(r.text)?.[1]);
  check('upload lab opens', !r.isError && /Upload Lab/.test(r.text), r.text);

  // The page logs what it received after reading the files, so wait for it.
  const log = async () => {
    const t = (await a.tool('evaluate', { tabId, expression: 'JSON.stringify(window.__log)' })).text;
    try { return JSON.parse(t); } catch { return []; }
  };
  let mark = 0;
  const since = async () => { mark = (await log()).length; };
  const waitFor = async (pred) => {
    for (let i = 0; i < 30; i++) {
      const hit = (await log()).slice(mark).find(pred);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  const got = (source, extra = () => true) => waitFor((e) => e.source === source && extra(e));
  const snap = async () => (await a.tool('snapshot', { tabId })).text;

  // --------------------------------------------------------------- snapshot
  let s = await snap();
  check('snapshot shows accept and multiple on a visible file input', /file-input "Visible upload" \[ref=e\d+\] accept="\.txt,\.png,text\/plain" \[multiple\]/.test(s), s);
  // The top page's list comes last (an embedded frame's own list is shown inside the frame).
  const hiddenPart = s.split('Hidden file inputs').pop() || '';
  check('snapshot lists hidden file inputs with refs', /file-input \(hidden\)[^\n]*\[ref=e\d+\][^\n]*id="hidden"/.test(hiddenPart) && /\[folder\]|id="folder"/.test(s), hiddenPart || s);
  check('hidden inputs inside shadow DOM and same-site frames are listed', /file-input \(hidden\)[^\n]*id="i"/.test(hiddenPart) && /file-input \(hidden\)[^\n]*\[ref=e\d+\][^\n]*id="frameInput"/.test(hiddenPart), hiddenPart);
  check('the cross-site frame\'s hidden input is listed with a frame ref', /file-input \(hidden\)[^\n]*\[ref=f\d+\.e\d+\][^\n]*id="frameInput"/.test(s), s);
  check('drop zones without a click handler get a ref', /region "Drop files here" \[ref=e\d+\] \[drop-zone\]/.test(s) && /region "Frame drop zone" \[ref=f\d+\.e\d+\] \[drop-zone\]/.test(s), s);
  check('a label wrapping a hidden input is named by its text', /clickable "Attach via label" \[ref=e\d+\]/.test(s), s);
  check('a dashed box around a "Drop files here" paragraph is the drop zone', /\[ref=e\d+\][^\n]*\[drop-zone\]|drop-zone "Drop files here" \[ref=e\d+\]/.test(s.split('Drop zone with a nested label')[1] || ''), s.split('Drop zone with a nested label')[1]);
  check('marketing text that mentions dragging is not a drop zone', !/drop-zone "Drag n' drop to reorder files"|Drag n' drop to reorder files" \[ref/.test(s), s.split('Drop zone with a nested label')[1]);
  check('content inside a display: contents element is in the snapshot', /button "Contents button" \[ref=e\d+\]/.test(s), s);
  check('the hidden-input list appears once, at the end', s.split('Hidden file inputs').length === 2 && /Hidden file inputs[^]*$/.test(s), s);

  // Files never go to a frame whose site the user blocked.
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input \(hidden\)[^\n]*\[ref=(f\d+\.e\d+)\][^\n]*id="frameInput"/), paths: [fA] });
  check('upload into a blocked site\'s embedded frame is refused', r.isError && /blocked Hermes from localhost/.test(r.text), r.text);
  await inPopup(dbgPort, 'chrome.runtime.sendMessage({ type: "removeSite", host: "localhost" }).then(() => "ok")');

  // ---------------------------------------------------- direct to an input
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Visible upload" \[ref=(e\d+)\]/), paths: [fA, fB] });
  let e = await got('visible');
  check('visible input gets both files, trusted, with real contents', !r.isError && e?.trusted === true && e.files.length === 2 && e.files[0].head === 'alpha file content' && e.files[1].type === 'text/plain', r.text + ' / ' + JSON.stringify(e));
  check('result says what the page now holds', /now holds 2 file\(s\): alpha\.txt \(18 B\), bravo\.txt/.test(r.text), r.text);
  check('frameworks listening at the document root see the change', !!(await waitFor((x) => x.source === 'root-change:visible' && x.trusted)));
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Visible upload" \[ref=(e\d+)\]/), paths: [fA] });
  check('choosing the same file again still counts as a new choice', !r.isError && !!(await got('visible', (x) => x.files.length === 1)), r.text);

  const direct = [
    ['hidden input filled by its ref, no picker', /file-input \(hidden\)[^\n]*\[ref=(e\d+)\][^\n]*id="hidden"/, 'hidden', fA],
    ['a label wrapping a hidden input is followed to the input', /clickable "Attach via label" \[ref=(e\d+)\]/, 'labelled', fB],
    ['a <label for> pointing at a visually hidden input is followed', /file-input "Upload résumé" \[ref=(e\d+)\]/, 'srOnly', fA],
    ['hidden input inside shadow DOM filled by ref', /file-input \(hidden\)[^\n]*\[ref=(e\d+)\][^\n]*id="i"/, 'shadow', fB],
    ['hidden input inside a same-site frame filled by ref', /file-input \(hidden\)[^\n]*\[ref=(e\d+)\][^\n]*id="frameInput"/, 'frame@127.0.0.1', fA],
    ['hidden input inside a cross-site frame filled by ref', /file-input \(hidden\)[^\n]*\[ref=(f\d+\.e\d+)\][^\n]*id="frameInput"/, 'frame@localhost', fB],
  ];
  for (const [label, re, source, file] of direct) {
    await since();
    r = await a.tool('upload_file', { tabId, ref: refFor(s, re), paths: [file] });
    e = await got(source);
    check(label, !r.isError && e?.trusted === true && e.files[0]?.name === path.basename(file), r.text + ' / ' + JSON.stringify(e));
  }

  // ---------------------------------------------- buttons that open a picker
  const buttons = [
    ['styled button: clicked, picker answered', /button "Choose file" \[ref=(e\d+)\]/, 'hidden', [fA, fB]],
    ['picker opened after an async step is answered', /button "Upload after delay" \[ref=(e\d+)\]/, 'async', [fA]],
    ['showPicker() picker is answered', /button "Browse with showPicker" \[ref=(e\d+)\]/, 'showPicker', [fB]],
    ['picker of an input never added to the page is answered', /button "Import from a detached input" \[ref=(e\d+)\]/, 'detached', [fB]],
    ['button inside shadow DOM: picker answered', /button "Shadow upload" \[ref=(e\d+)\]/, 'shadow', [fA]],
    ['button inside a same-site frame: picker answered', /button "Frame upload button" \[ref=(e\d+)\]/, 'frame@127.0.0.1', [fB]],
    ['button inside a cross-site frame: picker answered through the frame\'s session', /button "Frame upload button" \[ref=(f\d+\.e\d+)\]/, 'frame@localhost', [fA]],
  ];
  for (const [label, re, source, files] of buttons) {
    await since();
    r = await a.tool('upload_file', { tabId, ref: refFor(s, re), paths: files });
    e = await got(source);
    check(label, !r.isError && e?.trusted === true && e.files.length === files.length && e.files[0].name === path.basename(files[0]), r.text + ' / ' + JSON.stringify(e));
  }
  check('a detached input is described as such', /not part of the page/.test((await a.tool('upload_file', { tabId, ref: refFor(s, /button "Import from a detached input" \[ref=(e\d+)\]/), paths: [fA] })).text));

  await since();
  s = await snap();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Nested upload button" \[ref=(f\d+\.e\d+)\]/), paths: [fA] });
  e = await got('nested@[::1]');
  check('button inside a cross-site frame nested in another one: picker answered', !r.isError && e?.trusted === true && e.files[0]?.name === 'alpha.txt', r.text + ' / ' + JSON.stringify(e));

  // ------------------------------------- a plain click that opens a picker
  r = await a.tool('click', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/) });
  check('a plain click reports the picker it opened instead of a system dialog', /A file picker opened \(several files allowed\)\. No system dialog is showing/.test(r.text), r.text);
  await since();
  r = await a.tool('upload_file', { tabId, paths: [fPng] });
  e = await got('hidden');
  check('upload_file without ref answers that picker', !r.isError && e?.files[0]?.name === 'pixel.png' && e.files[0].type === 'image/png', r.text + ' / ' + JSON.stringify(e));
  r = await a.tool('upload_file', { tabId, paths: [fA] });
  check('a picker is answered only once', r.isError && /No file picker is open/.test(r.text), r.text);
  await a.tool('click', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/) });
  r = await a.tool('upload_file', { tabId, cancel: true });
  check('cancel dismisses an open picker', !r.isError && /Dismissed/.test(r.text), r.text);
  r = await a.tool('press_key', { tabId, key: 'Escape' });
  check('a handled picker is not reported again', !/file picker/i.test(r.text), r.text);
  await a.tool('click', { tabId, ref: refFor(s, /button "Upload after delay" \[ref=(e\d+)\]/) });
  r = await a.tool('upload_file', { tabId, paths: [fA, fB] });
  check('a mistake in answering a picker (two files for one) ...', r.isError && /accepts only one file/.test(r.text), r.text);
  await since();
  r = await a.tool('upload_file', { tabId, paths: [fB] });
  check('... leaves the picker open for the corrected call', !r.isError && (await got('async'))?.files[0]?.name === 'bravo.txt', r.text);
  await a.tool('click', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/) });
  await sleep(20000); // longer than the debugger's idle release
  await since();
  r = await a.tool('upload_file', { tabId, paths: [fA] });
  check('an open picker survives a 20 s pause before the agent answers', !r.isError && (await got('hidden'))?.files[0]?.name === 'alpha.txt', r.text);

  // ------------------------------------------------------------ constraints
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [fA, fB] });
  check('two files for a single-file input: clear error, nothing set', r.isError && /accepts only one file/.test(r.text) && !(await got('single')), r.text);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "PDF upload" \[ref=(e\d+)\]/), paths: [fA] });
  check('accept mismatch: set anyway (browsers do not enforce it), with a warning', !r.isError && /may be rejected by the page/.test(r.text) && !!(await got('pdfonly')), r.text);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Folder upload" \[ref=(e\d+)\]/), paths: [fDir] });
  e = await got('folder', (x) => x.files.length);
  check('folder input gets the folder\'s files with their paths inside it', !r.isError && e?.files.length === 2 && e.files.some((f) => f.rel === 'album/sub/two.txt' && f.head === 'two') && /album\/sub\/two\.txt/.test(r.text), r.text + ' / ' + JSON.stringify(e));
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Folder upload" \[ref=(e\d+)\]/), paths: [fA] });
  check('a file for a folder input: clear error', r.isError && /Pass exactly one folder/.test(r.text), r.text);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [path.join(dir, 'nope.txt')] });
  check('missing file: clear error naming the path', r.isError && /No such file: .*nope\.txt/.test(r.text), r.text);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: ['alpha.txt'] });
  check('relative path: asks for a full path', r.isError && /absolute path|full path with a drive letter/.test(r.text), r.text);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: ['\\\\attacker.example\\share\\cv.pdf'] });
  check('network path refused before anything is read', r.isError && /Network and device paths are not allowed/.test(r.text), r.text);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Disabled upload" \[ref=(e\d+)\]/), paths: [fA] });
  check('a disabled file input is refused', r.isError && /disabled/.test(r.text), r.text);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Upload Image" \[ref=(e\d+)\]/), paths: [fPng] });
  e = await got('photo');
  const stillHere = (await a.tool('evaluate', { tabId, expression: 'location.pathname' })).text;
  check('a form\'s submit button with one file input fills that input, without submitting', !r.isError && e?.files[0]?.name === 'pixel.png' && stillHere === '/upload', r.text + ' ' + stillHere);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Upload report" \[ref=(e\d+)\]/), paths: [fA] });
  const stillHere2 = (await a.tool('evaluate', { tabId, expression: 'location.pathname' })).text;
  check('a submit button of a form without a file input is refused, not clicked', r.isError && /submit button/.test(r.text) && stillHere2 === '/upload', r.text + ' ' + stillHere2);

  // An old unanswered picker is not filled by a later upload_file without a target.
  await a.tool('click', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/) });
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [fA] });
  r = await a.tool('upload_file', { tabId, paths: [fB] });
  check('after an upload to an explicit target, the old picker is retired', r.isError && /No file picker is open/.test(r.text), r.text);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [fUni] });
  check('non-ASCII file name with spaces', !r.isError && (await got('single'))?.files[0]?.name === 'zażółć gęślą jaźń.txt', r.text);
  const t0 = Date.now();
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [fBig] });
  const ms = Date.now() - t0;
  check(`40 MB file by path, size intact (${ms} ms)`, !r.isError && (await got('single'))?.files[0]?.size === 40 * 1024 * 1024 && ms < 10000, r.text);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/), via: 'input', paths: [fA] });
  check('via input on an element without a file input: clear error', r.isError && /not a file input/.test(r.text), r.text);

  // ------------------------------------------------------------ drop, paste
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /region "Drop files here" \[ref=(e\d+)\]/), via: 'drop', paths: [fA, fPng] });
  e = await got('drop');
  check('drop onto a drop zone: real, trusted files', !r.isError && e?.trusted === true && e.files.length === 2 && e.files[0].head === 'alpha file content' && /accepted the drop/.test(r.text), r.text + ' / ' + JSON.stringify(e));
  const urlBefore = (await a.tool('evaluate', { tabId, expression: 'location.href' })).text;
  r = await a.tool('upload_file', { tabId, x: 30, y: 30, via: 'drop', paths: [fA] });
  const urlAfter = (await a.tool('evaluate', { tabId, expression: 'location.href' })).text;
  check('drop where nothing accepts it: reported, and the page is not replaced by the file', /nothing on the page accepted|did not report/.test(r.text) && urlBefore === urlAfter, r.text + ' ' + urlAfter);
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /region "Drop files here" \[ref=(e\d+)\]/), via: 'drop', paths: [fDir] });
  check('dropping a folder: clear error', r.isError && /Folders cannot be dropped/.test(r.text), r.text);
  s = await snap();
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /textbox "Paste files here" \[ref=(e\d+)\]/), via: 'paste', paths: [fPng] });
  e = await got('paste');
  check('paste into an editor', !r.isError && e?.files[0]?.name === 'pixel.png' && e.files[0].type === 'image/png', r.text + ' / ' + JSON.stringify(e));
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /region "Frame drop zone" \[ref=(e\d+)\]/), via: 'drop', paths: [fA] });
  e = await got('frameDrop@127.0.0.1');
  const fileTabs = () => a.tool('tabs_list').then((x) => /file:\/\//.test(x.text));
  check('drop into a same-site frame\'s drop zone', !r.isError && e?.trusted === true && e.files[0]?.name === 'alpha.txt' && !(await fileTabs()), r.text + ' / ' + JSON.stringify(e));
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Frame upload button" \[ref=(e\d+)\]/), via: 'drop', paths: [fA] });
  check('drop onto a non-drop-zone inside a same-site frame: reported, no file opened in a tab', !r.isError && /not accept|did not report|tried to open|not a drop zone/.test(r.text) && !(await fileTabs()), r.text);
  await since();
  const nestedPart = (s.split('Drop zone with a nested label')[1] || '').split('Inside display contents')[0];
  const nestedRef = refFor(nestedPart, /\[ref=(e\d+)\][^\n]*\[drop-zone\]/) || refFor(nestedPart, /drop-zone "[^"]*" \[ref=(e\d+)\]/);
  r = await a.tool('upload_file', { tabId, ref: nestedRef, via: 'drop', paths: [fB] });
  check('drop onto a dashed box drop zone', !r.isError && !!(await got('nestedDrop')), r.text);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /region "Frame drop zone" \[ref=(f\d+\.e\d+)\]/), via: 'drop', paths: [fB] });
  e = await got('frameDrop@localhost');
  check('drop into a cross-site frame\'s drop zone', !r.isError && e?.trusted === true && e.files[0]?.name === 'bravo.txt', r.text + ' / ' + JSON.stringify(e));

  // ------------------------------------------- File System Access picker
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Open with file system picker" \[ref=(e\d+)\]/), paths: [fA] });
  e = await got('fsapi');
  check('File System Access picker answered with the file', !r.isError && e?.files[0]?.name === 'alpha.txt' && e.files[0].head === 'alpha file content', r.text + ' / ' + JSON.stringify((await log()).slice(mark)));
  r = await a.tool('evaluate', { tabId, expression: 'String(window.showOpenFilePicker).includes("native code")' });
  check('the page\'s own showOpenFilePicker is restored afterwards', r.text === 'true', r.text);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Frame file system picker" \[ref=(e\d+)\]/), paths: [fA, fB] });
  e = await got('fsapi@127.0.0.1');
  check('File System Access picker inside a same-site frame answered', !r.isError && e?.files[0]?.name === 'alpha.txt', r.text + ' / ' + JSON.stringify((await log()).slice(mark)));
  check('a single-file picker given two files says which one was not used', /bravo\.txt was not used/.test(r.text), r.text);

  // ------------------------------------------- never touch the user's own picker
  await sleep(6000); // past the interception window of Hermes' last action
  const user = await devtools(dbgPort, (u) => u === base + '/upload');
  const box = await user.send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify((() => { const b = document.getElementById("hiddenBtn"); b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })())' });
  const [ux, uy] = JSON.parse(box?.result?.result?.value || '[0,0]');
  for (const type of ['mousePressed', 'mouseReleased']) await user.send('Input.dispatchMouseEvent', { type, x: ux, y: uy, button: 'left', clickCount: 1 });
  await sleep(600);
  user.close();
  r = await a.tool('get_text', { tabId, maxChars: 50 });
  check('a picker the user opens is reported as theirs, not taken over', /outside your own actions/.test(r.text), r.text);
  r = await a.tool('upload_file', { tabId, paths: [fA] });
  check('and Hermes cannot fill the user\'s picker', r.isError && /No file picker is open/.test(r.text), r.text);

  // ------------------------ "Allow access to file URLs" off: content fallback
  // (A test copy of the extension cannot be reloaded with the real switch off,
  // so this uses a setting that makes it behave as if it were.)
  await inPopup(dbgPort, 'chrome.storage.local.set({ simulateNoFileAccess: true }).then(() => "ok")');
  let st = (await a.tool('status')).text;
  check('file access off: status says uploads go by content', /by content only, up to 25 MB/.test(st), st);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Visible upload" \[ref=(e\d+)\]/), paths: [fA, fB] });
  e = await got('visible');
  check('file access off: input still filled, by content', !r.isError && e?.files.length === 2 && e.files[0].head === 'alpha file content' && /Passed by content/.test(r.text) && /Allow access to file URLs/.test(r.text), r.text + ' / ' + JSON.stringify(e));
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/), paths: [fMid] });
  e = await got('hidden');
  check('file access off: picker answered by content (6 MB)', !r.isError && e?.files[0]?.size === 6 * 1024 * 1024, r.text + ' / ' + JSON.stringify(e));
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /region "Drop files here" \[ref=(e\d+)\]/), via: 'drop', paths: [fB] });
  check('file access off: drop by content', !r.isError && (await got('drop'))?.files[0]?.name === 'bravo.txt', r.text);
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Folder upload" \[ref=(e\d+)\]/), paths: [fDir] });
  e = await got('folder', (x) => x.files.length);
  check('file access off: folder still uploaded, by content', !r.isError && e?.files.some((f) => f.rel === 'album/one.txt'), r.text + ' / ' + JSON.stringify(e));
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [fBig] });
  check('file access off: over 25 MB refused, naming the fix', r.isError && /more than the 25 MB/.test(r.text), r.text);
  // A retry with contents must go to the picker its own first attempt opened, not an older one.
  await a.tool('click', { tabId, ref: refFor(s, /button "Choose file" \[ref=(e\d+)\]/) });
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /file-input "Single upload" \[ref=(e\d+)\]/), paths: [fB] });
  e = await got('single');
  check('file access off: the named input is filled, not an older open picker', !r.isError && e?.files[0]?.name === 'bravo.txt' && !(await log()).slice(mark).some((x) => x.source === 'hidden'), r.text + ' / ' + JSON.stringify((await log()).slice(mark)));
  await since();
  r = await a.tool('upload_file', { tabId, ref: refFor(s, /button "Open with file system picker" \[ref=(e\d+)\]/), paths: [fA] });
  check('file access off: File System Access picker still answered', !r.isError && (await got('fsapi'))?.files[0]?.name === 'alpha.txt', r.text);
  await inPopup(dbgPort, 'chrome.storage.local.remove("simulateNoFileAccess").then(() => "ok")');
  st = (await a.tool('status')).text;
  check('file access back on', /by path, any size/.test(st), st);
  await a.tool('tab_close', { tabId });
}
