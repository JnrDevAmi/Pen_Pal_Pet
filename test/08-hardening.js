"use strict";
/*
 * A standing audit of the app's security posture.
 *
 * These read the source rather than run it, so a future edit that quietly
 * turns the sandbox off, widens the CSP, or reaches for child_process fails
 * the build instead of shipping.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app");
const read = (f) => fs.readFileSync(path.join(APP, f), "utf8");

/** Comments describe; only code can do. Scan code alone. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const main = read("main.js");
const preload = read("preload.js");
const html = read(path.join("renderer", "index.html"));
const css = read(path.join("renderer", "style.css"));
const rapp = read(path.join("renderer", "app.js"));
const appSources = ["main.js", "net.js", "store.js", "crypto.js", "actions.js", "preload.js"]
  .map((f) => ({ f, src: read(f) }));

/* ---------------- the window ---------------- */

test("the renderer is sandboxed with context isolation and no Node", () => {
  assert.match(main, /sandbox:\s*true/, "sandbox must be on");
  assert.match(main, /contextIsolation:\s*true/, "context isolation must be on");
  assert.match(main, /nodeIntegration:\s*false/, "node integration must be off");
  assert.ok(!/nodeIntegration:\s*true/.test(main));
  assert.ok(!/nodeIntegrationInWorker:\s*true/.test(main));
  assert.ok(!/nodeIntegrationInSubFrames:\s*true/.test(main));
  assert.ok(!/contextIsolation:\s*false/.test(main));
  assert.ok(!/sandbox:\s*false/.test(main));
});

test("web security is never weakened", () => {
  assert.ok(!/webSecurity:\s*false/.test(main), "webSecurity must not be disabled");
  assert.ok(!/allowRunningInsecureContent:\s*true/.test(main));
  assert.ok(!/experimentalFeatures:\s*true/.test(main));
  assert.ok(!/enableRemoteModule/.test(main), "the remote module must not be used");
});

test("navigation, popups and webviews are all refused", () => {
  assert.match(main, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*"deny"/);
  assert.match(main, /will-navigate[\s\S]{0,80}preventDefault/);
  assert.match(main, /will-attach-webview[\s\S]{0,80}preventDefault/);
});

test("every web permission is denied", () => {
  assert.match(main, /setPermissionRequestHandler\([\s\S]{0,80}false\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/);
  assert.match(main, /setDevicePermissionHandler\(\(\)\s*=>\s*false\)/);
  assert.match(main, /lockDownSession\(session\.defaultSession\)/);
});

test("an unexpected failure shuts the app down rather than continuing", () => {
  assert.match(main, /process\.on\("uncaughtException"/);
  assert.match(main, /process\.on\("unhandledRejection"/);
  assert.match(main, /function dieSafely/);
  assert.match(main, /saveNow\(\)/, "notes must be flushed before exit");
});

/* ---------------- the bridge ---------------- */

test("the preload bridge exposes nothing dangerous", () => {
  const code = codeOnly(preload);
  for (const bad of ["shell", "clipboard", "child_process", "fs.",
    "openExternal", "webFrame", "process.env"]) {
    assert.ok(!code.includes(bad), `preload must not expose ${bad}`);
  }
  // it may require electron, and nothing else
  const requires = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ["electron"], "preload must require only electron");
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  // Inside the exposed object, ipcRenderer may only ever appear as a call -
  // never handed over as a value the page could keep and aim anywhere.
  const exposed = code.slice(code.indexOf("exposeInMainWorld"));
  for (const m of exposed.matchAll(/ipcRenderer(\s*[^.\s]|\.\s*\w+)/g)) {
    assert.match(m[0], /^ipcRenderer\.(invoke|send|on)$/,
      `ipcRenderer must only be called, never exposed: saw "${m[0]}"`);
  }
});

test("every channel the preload uses is handled, and vice versa", () => {
  const used = new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)].map((m) => m[1]));
  const listened = new Set([...preload.matchAll(/ipcRenderer\.on\("([^"]+)"/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.(?:handle|on)\("([^"]+)"/g)].map((m) => m[1]));
  const sent = new Set([...main.matchAll(/send\("([^"]+)"/g)].map((m) => m[1]));

  for (const ch of used) {
    assert.ok(handled.has(ch), `page calls "${ch}" but main does not handle it`);
  }
  for (const ch of handled) {
    assert.ok(used.has(ch), `main handles "${ch}" but nothing calls it - dead surface`);
  }
  for (const ch of listened) {
    assert.ok(sent.has(ch), `page listens for "${ch}" but main never sends it`);
  }
});

/* ---------------- the page ---------------- */

test("the content security policy is closed by default", () => {
  const m = html.match(/content="([^"]*default-src[^"]*)"/);
  assert.ok(m, "a CSP meta tag must be present");
  const csp = m[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/, "the page must not be able to reach the network");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.ok(!/unsafe-eval/.test(csp), "unsafe-eval must never be allowed");
  assert.ok(!/https?:/.test(csp), "the CSP must name no remote origin");
});

test("the page loads nothing from the internet", () => {
  for (const [name, src] of [["index.html", html], ["style.css", css], ["app.js", rapp]]) {
    const hits = [...src.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0])
      .filter((u) => !u.startsWith("http://www.w3.org/"));   // SVG namespaces are inert
    assert.deepStrictEqual(hits, [], `${name} references remote resources: ${hits.join(", ")}`);
  }
});

test("the page never builds markup from data it did not create", () => {
  // innerHTML is fine for the app's own inline SVG constants, but every use
  // must be traceable to one of those - never to a note, name or pet name.
  const uses = [...rapp.matchAll(/(\w+)\.innerHTML\s*=(?!=)\s*([^;]+);/g)].map((m) => m[2].trim());
  for (const expr of uses) {
    const safe = /^(petSVG\(|icon$|ICONS\.|`?<svg|CARRY\()/.test(expr);
    assert.ok(safe, `innerHTML built from something unvetted: ${expr}`);
  }
});

/* ---------------- the code at large ---------------- */

test("the app never evaluates strings or spawns processes", () => {
  for (const { f, src } of appSources) {
    for (const bad of ["child_process", "eval(", "new Function(", "vm.runIn", "execSync"]) {
      assert.ok(!src.includes(bad), `${f} must not use ${bad}`);
    }
  }
});

test("private keys are never written to a log", () => {
  // Only expressions matter. A message mentioning "identity.json" names a
  // file; a message interpolating `identity` would be the actual leak, so
  // quoted text is removed before the line is judged.
  const stripLiterals = (line) => line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`$\\]|\\.)*`/g, "``");

  for (const { f, src } of appSources) {
    const logs = [...src.matchAll(/console\.(?:log|warn|error|info)\(([^\n]*)/g)].map((m) => m[1]);
    for (const line of logs) {
      const code = stripLiterals(line);
      assert.ok(!/\bsigPriv\b|\.priv\b|\bidentity\b(?!\s*\.\s*(?:id|name|pet|ready))/.test(code),
        `${f} logs something key-shaped: ${line.slice(0, 90)}`);
    }
  }
});

test("the log-leak check would actually catch a leak", () => {
  // A guard is worthless if it cannot fail, so prove it fires on a real leak.
  const leaky = 'console.error("boom", store.identity.sigPriv);';
  const logs = [...leaky.matchAll(/console\.(?:log|warn|error|info)\(([^\n]*)/g)].map((m) => m[1]);
  const code = logs[0].replace(/"(?:[^"\\]|\\.)*"/g, '""');
  assert.match(code, /\bsigPriv\b/, "the check must detect a genuine key in a log call");
});

test("the protocol refuses to talk to anything off the local network", () => {
  const net = read("net.js");
  assert.match(net, /function isLocalAddress/);
  assert.match(net, /if \(!isLocalAddress\(req\.socket\.remoteAddress\)\)/, "inbound must be filtered");
  assert.match(net, /if \(!isLocalAddress\(rinfo\.address\)\) return;/, "beacons must be filtered");
});

test("identity is bound to its signing key everywhere it is accepted", () => {
  const net = read("net.js");
  const store = read("store.js");
  assert.match(net, /if \(id !== deriveId\(sigPub\)\) return;/, "a beacon must prove its id");
  assert.match(net, /if \(!verify\(sigPub, raw, m\.sig\)\) return;/, "a beacon must be signed");
  assert.match(net, /if \(!verify\(peer\.sigPub,[\s\S]{0,120}\) \{/, "a message must be signed");
  assert.match(store, /=== deriveId\(d\.sigPub\)/, "a stored identity must match its key");
});

test("a changed peer key is refused rather than silently accepted", () => {
  const net = read("net.js");
  assert.match(net, /keyState === "changed"/);
  assert.match(net, /kind: "impostor"/, "the user must be told");
  // the refusing branch must return before the peer is recorded
  const idx = net.indexOf('keyState === "changed"');
  assert.ok(idx > 0, "the changed-key branch must exist");
  const after = net.slice(idx);
  const bail = after.indexOf("return;");
  const record = after.indexOf("this.peers.set");
  assert.ok(bail > 0, "a changed key must stop processing");
  assert.ok(record > 0, "the peer list write should follow in the same function");
  assert.ok(bail < record,
    "a refused peer must never be written to the peer list");
});

test("shipped software carries no debugger", () => {
  assert.match(main, /devTools:\s*false/, "devTools must be off in the built app");
  assert.match(main, /Menu\.setApplicationMenu\(null\)/,
    "the default menu carries a Toggle Developer Tools shortcut");
});

test("one peer cannot flood the mailbag", () => {
  const net = read("net.js");
  assert.match(net, /acceptsAnotherNote/, "inbound notes must be rate limited per peer");
  assert.match(net, /NOTE_PER_PEER/, "one peer must not fill the whole mailbag");
  assert.match(net, /429/, "a flood should be refused, not stored");
});

test("the listener cannot be held open or flooded", () => {
  const net = read("net.js");
  assert.match(net, /maxConnections\s*=\s*\d+/, "connection count must be capped");
  assert.match(net, /headersTimeout\s*=\s*\d+/, "slow headers must time out");
  assert.match(net, /requestTimeout\s*=\s*\d+/, "slow bodies must time out");
  assert.match(net, /MAX_BODY/, "body size must be capped");
});

test("replay protection is present and bounded", () => {
  const net = read("net.js");
  const crypto = read("crypto.js");
  assert.match(net, /this\.replay\.accept\(/);
  assert.match(crypto, /class ReplayGuard/);
  assert.match(crypto, /NONCE_MAX/, "the nonce set must have a hard cap");
  assert.match(crypto, /CLOCK_SKEW_MS/);
});

test("private keys are sealed with the OS keystore where one exists", () => {
  const store = read("store.js");
  assert.match(main, /safeStorage/, "main must offer the keystore to the store");
  assert.match(main, /isEncryptionAvailable\(\)/, "availability must be checked, not assumed");
  assert.match(store, /writeSecret\(this\.idFile/, "identity must go through the sealed path");
  assert.match(store, /readSecret\(this\.idFile\)/);
  assert.match(store, /writeSecret\(this\.notesFile/, "notes hold private messages and are sealed too");
  assert.match(store, /readSecret\(this\.notesFile\)/);
  assert.ok(!/writeJSON\(this\.(idFile|notesFile)/.test(store),
    "neither file may be written straight to disk");
});

test("the packaged build ships only what it needs", () => {
  const pkg = JSON.parse(read("package.json"));
  const files = pkg.build.files.join(" ");
  for (const f of ["main.js", "preload.js", "store.js", "net.js", "crypto.js", "actions.js"]) {
    assert.ok(files.includes(f), `${f} must be packaged`);
  }
  assert.ok(!files.includes("test"), "tests must not ship");
  assert.strictEqual(pkg.build.asar, true, "sources should be packed");
  assert.ok(Array.isArray(pkg.build.electronLanguages));
});

test("electron is on a supported major", () => {
  const pkg = JSON.parse(read("package.json"));
  const major = Number(String(pkg.devDependencies.electron).replace(/[^\d.]/g, "").split(".")[0]);
  assert.ok(major >= 42, `electron ${major} is out of support; 42+ still receives Chromium fixes`);
});
