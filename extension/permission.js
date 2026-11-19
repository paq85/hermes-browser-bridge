const host = new URLSearchParams(location.search).get('host') || '';
document.getElementById('host').textContent = host;

for (const decision of ['always', 'session', 'deny', 'block', 'all']) {
  document.getElementById(decision).addEventListener('click', async () => {
    for (const b of document.querySelectorAll('button')) b.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'siteDecision', host, decision });
    } finally {
      window.close(); // the service worker normally closes this window first
    }
  });
}
