# Hermes Browser Bridge

Lets [Hermes Agent](https://github.com/NousResearch/hermes-agent) use your real,
signed-in Chrome or Edge through a browser extension, in the same spirit as the
browser extensions other AI assistants ship. No remote-debugging port, no "allow
remote debugging" prompt, no profile copying.

> Unofficial community project. It is not affiliated with or endorsed by Nous
> Research (Hermes Agent) or any other company named here.

```
Hermes Agent ──MCP (stdio)──> bridge/server.mjs ──WebSocket on 127.0.0.1──> extension ──chrome.debugger──> your tabs
```

## Install

This repository is a Hermes plugin (portable Agent Plugins v1 package:
`plugin.json` + `mcp.json` + a skill). Hermes needs nothing else: it starts the
bridge itself with its own bundled Node.js, and the bridge has no dependencies
to install (`ws` is vendored).

1. **Install the plugin**:

   ```bash
   hermes plugins install paq85/hermes-browser-bridge --enable
   ```

   Hermes asks you to confirm because this is not a catalog plugin. Read the
   code first if you like; it is small, and the only dependency (`ws`) is
   vendored.

   Hermes copies it to `<hermes home>\plugins\hermes-browser-bridge` and exposes
   the tools as `mcp__chrome__*` from the next session. Plugins are per Hermes
   profile; repeat with `hermes -p <profile> plugins install ...` for others.

2. **Load the extension**: open `chrome://extensions`, turn on *Developer mode*,
   click *Load unpacked* and pick the `extension` folder **inside the installed
   plugin** (on Windows `%LOCALAPPDATA%\hermes\plugins\hermes-browser-bridge\extension`).
   That copy holds `config.json`, the pairing the bridge writes on first start.

The pairing itself lives in `~/.hermes-browser-bridge/config.json`, shared by
all profiles, and is mirrored into the plugin's `extension` folder each time the
bridge starts.

After `hermes plugins update hermes-browser-bridge` the extension notices the
new version on disk and reloads itself within 30 seconds (from 0.3.0 on).

To use the bridge from another MCP client instead, point it at
`node bridge/server.mjs` (stdio).

## Using it

Ask Hermes to do something in your browser. The toolbar icon shows **ON** while
Hermes is connected. Tabs Hermes opens go into an orange "Hermes" tab group.

Tabs Hermes is working in get an orange frame.

**The "started debugging this browser" bar.** The browser shows this for any
extension that uses the debugger API, and an extension cannot hide it. This one
keeps it to a minimum:

- Reading pages, finding elements, filling fields, scrolling and navigating use
  ordinary script injection and never show the bar.
- Real mouse and keyboard input, screenshots, running page JavaScript, console
  and network capture, dialogs and file uploads need the debugger. The bar
  appears for those and goes away about 15 seconds after the last one (5 minutes
  while network capture is on for a tab).

To never see it, start the browser with `--silent-debugger-extension-api`
(add it to the shortcut's target). That flag hides the bar for every extension,
so only use it if you trust all your extensions that hold the debugger permission.

The popup has an **Allow Hermes** switch (off = Hermes cannot touch the browser)
and a **Release all tabs** button.

### Site permissions

By default Hermes must ask before it uses each site. The first time it touches a
site, a small window opens in the browser:

- **Always allow** remembers the site (and its subdomains).
- **Allow until I close the browser** allows it for this browser session.
- **Not now** refuses this time and asks again next time.
- **Never allow this site** blocks it until you remove the rule.

Hermes' call waits up to 45 seconds for your answer. In `tabs_list`, tabs on
sites you have not allowed show only their site name, not their title or
address. The popup lists every decision with a **Forget** link.

**To allow every site without being asked**, do either of these once:

- in the toolbar popup, under *Sites*, choose **Allow all sites without asking**;
- or, in any permission prompt, click **Allow all sites from now on**.

Hermes can then use any site immediately, and a call that was waiting on a
prompt goes ahead. Sites you blocked with **Never allow** stay blocked; use
**Forget** in the popup to unblock one. Choose **Ask me the first time…** in the
popup to go back to asking. The setting is kept across browser restarts.

## Tools

`status`, `tabs_list`, `tab_new`, `tab_close`, `tab_activate`, `resize_window`,
`navigate`, `snapshot`, `find`, `get_text`, `screenshot`, `zoom`, `click`
(single, double, triple, right), `hover`, `drag`, `type`, `press_key`, `scroll`,
`scroll_to`, `set_value`, `upload_file`, `upload_image`, `gif_recorder`,
`evaluate`, `console_messages`, `network_requests`, `handle_dialog`, `wait`,
`batch`.

`snapshot` returns an outline of the page with `[ref=eN]` ids that the
interaction tools accept. Screenshots are scaled to CSS pixels, so image
coordinates work directly as `x`/`y`.

**Embedded frames from other sites** (payment forms, embedded editors, video
players, captcha-free widgets) appear in `snapshot`, `find` and `get_text` like
the rest of the page; their elements have refs like `f12.e5` and work with every
tool. Clicks and typing are sent straight into the frame, so they work in
background tabs too.

**`upload_image`** gives the page your last screenshot (or an image file) as a
user would: into a file input, as a paste (`Ctrl+V` into an editor or chat box),
or as a drag-and-drop onto a drop zone.

**`gif_recorder`** records the actions Hermes takes in a tab (one frame per
action, clicks marked with an orange circle) and saves an animated GIF to
`~/.hermes-browser-bridge/recordings/`.

## Security model

- The bridge listens on `127.0.0.1` only.
- The extension and bridge prove to each other that they hold the token in
  the pairing file (HMAC challenge both ways). Web pages and other extensions
  cannot connect. Keep it private; to rotate the token delete
  `~/.hermes-browser-bridge/config.json` and start a new Hermes session.
- Hermes acts with your logins. The tool instructions tell it to treat page
  content as untrusted and to ask before sending, buying or deleting, but that
  is guidance to the model, not an enforced limit. Site permissions are
  enforced by the extension: Hermes cannot read or act on a site you have not
  allowed. Only the extension's own pages can answer a permission prompt.
- Password field values are masked in snapshots.

### What you are trusting

Installing this gives an AI agent the ability to act in your signed-in browser.
Know the edges before you switch on **Allow all sites**:

- With all sites allowed, Hermes can use any logged-in account in that browser.
  It can run JavaScript in the page (`evaluate`), click, type and submit. Prefer
  the default ask-per-site mode, and block sites you never want it near (bank,
  email, admin consoles).
- `upload_file` and `upload_image` with `path` read files from this computer and
  hand them to the page. A prompt-injected agent could try to upload a private
  file to a site you allowed. Local-file pages (`file://`) count as the site
  "local files" and are allowed too in all-sites mode, if your browser's
  "Allow access to file URLs" switch is on for the extension.
- The extension requests broad permissions (`debugger`, `scripting`,
  `<all_urls>`, `webNavigation`, `tabs`, `tabGroups`) because driving arbitrary pages
  needs them. It makes no network requests except the local WebSocket to the
  bridge, and sends nothing anywhere else. It is loaded unpacked and is not
  published in any extension store.
- Anything on your computer that can read your user files can read the pairing
  token and drive the bridge. That is the same trust boundary as your own
  account.

Found a security problem? Please open a private security advisory on the
repository rather than a public issue.
## Limits

- Site permissions apply to the tab's own site. Embedded frames from other sites
  inside an allowed page are covered by that page's permission.
- `upload_file` does not reach file inputs inside embedded frames from other
  sites; `upload_image` does.
- `chrome://` pages, the Web Store and other extensions' pages cannot be controlled.
- One browser profile at a time: the most recently connected extension wins.
- After Hermes starts, the extension can take up to 30 seconds to connect; the
  first tool call waits for it.

## Test

`cd bridge && npm test` loads the extension into a throwaway Chromium profile
and drives it through the bridge (needs a Playwright Chromium or Chrome for
Testing; branded Chrome no longer accepts `--load-extension`).

## License

MIT, see [LICENSE](LICENSE). Includes the MIT-licensed `ws` library.
