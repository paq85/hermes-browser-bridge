// Per-site permissions. A "site" is a hostname without a leading "www.";
// a rule for example.com also covers its subdomains.

export function siteKey(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '');
    if (u.protocol === 'file:') return 'local files';
  } catch { /* not a URL */ }
  return null; // blank and browser-internal pages need no permission
}

// Most specific matching rule wins. Returns 'allow', 'deny' or null.
export function matchRule(rules, host) {
  let best = null;
  let bestLen = -1;
  for (const [k, v] of Object.entries(rules || {})) {
    if ((host === k || host.endsWith('.' + k)) && k.length > bestLen) { best = v; bestLen = k.length; }
  }
  return best;
}
