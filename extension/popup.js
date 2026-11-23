const $ = (id) => document.getElementById(id);
const RULE_LABEL = { allow: 'Allowed', deny: 'Blocked', session: 'Allowed until the browser closes' };

function render(s) {
  const status = $('status');
  if (!s || s.error) {
    status.textContent = 'Extension error: ' + (s?.error || 'no response');
    status.className = 'status warn';
    return;
  }
  $('enabled').checked = s.enabled;
  if (!s.enabled) {
    status.textContent = 'Off. Hermes cannot use this browser.';
    status.className = 'status';
  } else if (s.connected) {
    status.textContent = 'Connected to Hermes.';
    status.className = 'status ok';
  } else {
    status.textContent = 'Waiting for Hermes. It connects within 30 seconds of Hermes starting.';
    status.className = 'status warn';
  }

  $('fileaccess').hidden = s.fileAccess !== false;
  $('tabs-section').hidden = !s.tabs.length;
  $('tabs').replaceChildren(...s.tabs.map((t) => {
    const li = document.createElement('li');
    li.textContent = t.title;
    li.title = t.title;
    return li;
  }));

  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.siteMode;
  $('no-rules').hidden = s.rules.length > 0;
  $('rules').replaceChildren(...s.rules.map((r) => {
    const li = document.createElement('li');
    li.className = 'rule';
    const name = document.createElement('span');
    name.textContent = r.host;
    name.title = r.host;
    const what = document.createElement('span');
    what.className = 'muted';
    what.textContent = RULE_LABEL[r.rule] || r.rule;
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'link';
    forget.textContent = 'Forget';
    forget.addEventListener('click', () => send({ type: 'removeSite', host: r.host }));
    li.append(name, what, forget);
    return li;
  }));
}

async function send(msg) {
  try {
    render(await chrome.runtime.sendMessage(msg));
  } catch (e) {
    render({ error: String(e?.message || e) });
  }
}

$('enabled').addEventListener('change', (e) => send({ type: 'setEnabled', enabled: e.target.checked }));
$('detach').addEventListener('click', () => send({ type: 'detachAll' }));
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => { if (r.checked) send({ type: 'setSiteMode', mode: r.value }); });
}
send({ type: 'status' });
setInterval(() => send({ type: 'status' }), 2000);
