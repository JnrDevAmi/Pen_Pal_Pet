"use strict";
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, session, safeStorage,
} = require("electron");
const path = require("path");
const { Store } = require("./store");
const { Net } = require("./net");
const { makeActions, dispatch } = require("./actions");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let tray = null;
let quitting = false;
let pushTimer = null;
let petsHidden = false;
let statusText = "Pen-pal Pet";
let badge = 0;
let store = null;
let net = null;

/* ---------------- window ---------------- */
function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: Math.min(1040, Math.round(wa.width * 0.8)),
    height: Math.min(700, Math.round(wa.height * 0.85)),
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1b2545",
    title: "Pen-pal Pet",
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  // Closing the window puts the app in the tray rather than quitting it: notes
  // can only arrive while it is running, so quitting has to be deliberate.
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    petsHidden = true;
    buildMenu();
  });
  win.on("show", () => { petsHidden = false; buildMenu(); });
}

function send(channel, payload) {
  // The window can be alive while its render frame is already gone (during
  // shutdown, or after a renderer crash), so check both before sending.
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try { wc.send(channel, payload); } catch {}
}
function pushState() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { if (net) send("state", net.snapshot()); }, 60);
}
function command(name) {
  if (petsHidden || (win && !win.isDestroyed() && !win.isVisible())) setHidden(false);
  if (win && !win.isDestroyed()) win.focus();
  send("command", name);
}
function setHidden(hidden) {
  petsHidden = hidden;
  if (!win || win.isDestroyed()) return;
  if (hidden) win.hide();
  else { win.show(); win.focus(); }
  buildMenu();
}

/* ---------------- tray ---------------- */
function trayImage() {
  const file = process.platform === "darwin" ? "trayTemplate.png" : "tray.png";
  const img = nativeImage.createFromPath(path.join(__dirname, "build", file));
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}
function buildMenu() {
  if (!tray) return;
  const login = app.getLoginItemSettings().openAtLogin;
  const nearby = net ? net.onlinePeers().length : 0;
  const menu = Menu.buildFromTemplate([
    { label: statusText, enabled: false },
    { type: "separator" },
    { label: "Write a note…", click: () => command("write") },
    { label: badge ? `Mailbag (${badge})` : "Mailbag", click: () => command("mailbag") },
    { label: nearby ? `Nearby friends (${nearby})` : "Nearby friends", click: () => command("friends") },
    { label: "My pet…", click: () => command("pet") },
    { type: "separator" },
    { label: "Open Pen-pal Pet", click: () => setHidden(false) },
    {
      label: "Accept notes from anyone on this Wi-Fi",
      type: "checkbox",
      checked: store ? store.identity.acceptAnyone : true,
      click: (item) => { store.setAcceptAnyone(item.checked); pushState(); buildMenu(); },
    },
    {
      label: "Start when I log in", type: "checkbox", checked: login,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); },
    },
    { type: "separator" },
    { label: "Quit Pen-pal Pet", click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(badge ? `Pen-pal Pet: ${statusText} (${badge} waiting)` : `Pen-pal Pet: ${statusText}`);
}
function createTray() {
  tray = new Tray(trayImage());
  tray.on("click", () => setHidden(false));
  tray.on("right-click", () => tray.popUpContextMenu());
  buildMenu();
}

/* ---------------- actions from the page ---------------- */
let actions = null;

ipcMain.handle("state:get", () => (net ? net.snapshot() : null));
ipcMain.handle("do", async (_e, msg) => {
  if (!actions) return { ok: false, error: "Still starting up." };
  return dispatch(actions, msg);
});
ipcMain.on("status", (_e, s) => {
  statusText = String((s && s.text) || "Pen-pal Pet").slice(0, 80);
  badge = Math.max(0, Number(s && s.badge) || 0);
  if (process.platform === "darwin" && tray) tray.setTitle(badge ? String(badge) : "");
  buildMenu();
});
ipcMain.on("app:quit", () => { quitting = true; app.quit(); });

/* ---------------- containment ----------------
 * This app is a toy that listens to the local network, so the rule is: if
 * anything unexpected happens, stop rather than carry on in a state nobody
 * reasoned about. Notes on disk are flushed first, then the process exits.
 * Nothing here can reach the rest of the machine: the window is sandboxed,
 * the app never spawns a shell, and it makes no internet connections.
 */
let dying = false;
function dieSafely(reason, err) {
  if (dying) return;
  dying = true;
  try { console.error("Shutting down:", reason, err && (err.stack || err.message || err)); } catch {}
  try { if (net) net.stop(); } catch {}
  try { if (store) store.saveNow(); } catch {}
  try { quitting = true; if (win && !win.isDestroyed()) win.destroy(); } catch {}
  try { app.quit(); } catch {}
  setTimeout(() => process.exit(1), 1500).unref();
}
process.on("uncaughtException", (err) => dieSafely("uncaught exception", err));
process.on("unhandledRejection", (err) => dieSafely("unhandled rejection", err));

/** Nothing in this app needs a single web permission. Refuse them all. */
function lockDownSession(ses) {
  ses.setPermissionRequestHandler((_wc, _perm, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  if (ses.setBluetoothPairingHandler) ses.setBluetoothPairingHandler((_d, cb) => cb({}));
}

/* ---------------- lifecycle ---------------- */
app.on("second-instance", () => setHidden(false));

// Belt and braces: even if a renderer were somehow persuaded to open another
// page, it gets no Node, no navigation and no new windows.
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.on("will-redirect", (e) => e.preventDefault());
});

app.whenReady().then(() => {
  app.setAppUserModelId("com.penpalpet.app");
  lockDownSession(session.defaultSession);

  // Seal this computer's private keys with the OS keystore (DPAPI on Windows,
  // Keychain on macOS, libsecret on Linux) so copying identity.json to another
  // machine yields nothing usable. Where no keystore is available the store
  // falls back to a plain file rather than refusing to start.
  let secure = null;
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      secure = {
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (buf) => safeStorage.decryptString(buf),
      };
    } else {
      console.warn("No OS keystore available; identity.json will be stored unsealed.");
    }
  } catch (err) {
    console.warn("OS keystore unavailable:", err.message);
  }

  store = new Store(app.getPath("userData"), secure);
  net = new Net(store);
  actions = makeActions({ store, net, onChanged: () => { pushState(); buildMenu(); } });
  net.on("changed", () => { pushState(); buildMenu(); });
  net.on("event", (ev) => send("net-event", ev));
  net.start();
  createWindow();
  createTray();
});
app.on("window-all-closed", (e) => { e.preventDefault(); });
app.on("before-quit", () => {
  quitting = true;
  if (net) net.stop();
  if (store) store.saveNow();
});
