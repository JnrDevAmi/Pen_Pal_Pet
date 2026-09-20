"use strict";
/*
 * Temporary harness: boots the real renderer with the real preload, feeds it a
 * realistic state snapshot, and asks Electron to paint it into a PNG.
 * Captures only the app's own window - never the desktop.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const APP = path.join(__dirname, "..", "app");
const { Store } = require(path.join(APP, "store.js"));
const C = require(path.join(APP, "crypto.js"));

const OUT = process.env.PENPAL_OUT || path.join(__dirname, "shot.png");
const W = Number(process.env.PENPAL_W || 1400);
const H = Number(process.env.PENPAL_H || 440);
const SCENE = process.env.PENPAL_SCENE || "home";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-shot-"));
const store = new Store(dir);
store.setProfile("Robin", { name: "Biscuit", species: "cat", color: "honey" });

// Two friends on the Wi-Fi, each with a derived safety code.
const friends = [
  { keys: C.newKeys(), name: "Priya", pet: { name: "Mochi", species: "frog", color: "moss" }, verified: true },
  { keys: C.newKeys(), name: "Sam", pet: { name: "Waffle", species: "pup", color: "plum" }, verified: false },
];
const peers = friends.map((f) => ({
  id: C.deriveId(f.keys.sigPub), name: f.name, pet: f.pet,
  safety: C.safetyCode(store.identity.sigPub, f.keys.sigPub), verified: f.verified,
}));

const now = Date.now();
const notes = [];
if (["home", "nearby", "mailbag"].includes(SCENE)) {
  notes.push({
    id: "n_wait1", dir: "out", status: "waiting", peerId: peers[0].id,
    peerName: "Priya", peerPet: peers[0].pet, note: "lunch at one?",
    doodle: [{ c: 2, p: [30, 40, 90, 90, 150, 50, 210, 110] }], reply: null,
    createdAt: now - 20000, sentAt: 0, deliveredAt: 0, arriveAt: 0, openedAt: 0,
    repliedAt: 0, returnAt: 0, readAt: 0, recalledAt: 0, replyPending: false, attempts: 0,
  });
}
if (["visitor", "mailbag"].includes(SCENE)) {
  notes.push({
    id: "n_in1", dir: "in", status: "arrived", peerId: peers[0].id,
    peerName: "Priya", peerPet: peers[0].pet, note: "found this by the river!",
    doodle: [{ c: 4, p: [20, 120, 90, 60, 160, 120, 230, 60] }], reply: null,
    createdAt: now - 30000, sentAt: now - 30000, deliveredAt: now - 20000,
    arriveAt: now - 9000, openedAt: 0, repliedAt: 0, returnAt: 0, readAt: 0,
    recalledAt: 0, replyPending: false, attempts: 0,
  });
}

if (SCENE === "mailbag") {
  notes.push({
    id: "n_done1", dir: "out", status: "home", peerId: peers[1].id,
    peerName: "Sam", peerPet: peers[1].pet, note: "swap notebooks tomorrow?",
    doodle: [{ c: 1, p: [40, 100, 110, 40, 180, 100] }],
    reply: { wave: false, note: "yes! bring the green one", doodle: [] },
    createdAt: now - 400000, sentAt: now - 390000, deliveredAt: now - 380000,
    arriveAt: 0, openedAt: now - 370000, repliedAt: now - 360000,
    returnAt: now - 350000, readAt: now - 340000, recalledAt: 0,
    replyPending: false, attempts: 1,
  });
}

const snapshot = {
  me: {
    id: store.identity.id, name: "Robin",
    pet: { name: "Biscuit", species: "cat", color: "honey" },
    ready: true, acceptAnyone: true,
  },
  peers, notes, travelMs: 8000, port: 51234,
};

ipcMain.handle("state:get", () => snapshot);
ipcMain.handle("do", () => ({ ok: true }));
ipcMain.handle("open-external", () => false);
ipcMain.handle("clipboard:write", () => true);
ipcMain.on("win:interactive", () => {});
ipcMain.on("win:focusable", () => {});
ipcMain.on("status", () => {});
ipcMain.on("app:quit", () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H, show: false, frame: false,
    backgroundColor: "#fdfaf2",
    webPreferences: {
      preload: path.join(APP, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // Hidden windows throttle requestAnimationFrame, which freezes the pets
      // mid-walk. Keep the frame loop running at full speed for the capture.
      backgroundThrottling: false,
    },
  });
  // Show it off the side of the desktop: visible enough for the compositor to
  // animate, never visible to a person.
  win.setPosition(-4000, 0);
  win.showInactive();

  const errs = [];
  win.webContents.on("console-message", (_e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
  win.webContents.on("render-process-gone", (_e, d) => errs.push("renderer gone: " + d.reason));

  await win.loadFile(path.join(APP, "renderer", "index.html"));
  // Screenshot-only: pets sit flush on the viewport floor (bottom: -2px), which
  // clips them in a captured frame. Lift the whole scene off the edge.
  await win.webContents.insertCSS(
    ".pet{bottom:34px !important} .floor-mail{bottom:34px !important} .popover{bottom:118px !important}"
  );
  await new Promise((r) => setTimeout(r, 1200));

  // Open a specific window in the app, if the scene asks for one.
  const cmd = { nearby: "friends", write: "write", mailbag: "mailbag", pet: "pet" }[SCENE];
  if (cmd) {
    win.webContents.send("command", cmd);
    await new Promise((r) => setTimeout(r, 900));
  }
  if (SCENE === "impostor") {
    win.webContents.send("net-event", {
      kind: "impostor", id: peers[0].id, name: "Priya", wasVerified: true,
    });
    await new Promise((r) => setTimeout(r, 900));
  }
  await new Promise((r) => setTimeout(r, Number(process.env.PENPAL_WAIT || 2500)));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`captured ${SCENE} -> ${OUT} (${img.getSize().width}x${img.getSize().height})`);
  console.log("renderer errors: " + (errs.length ? errs.slice(0, 5).join(" | ") : "none"));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.quit();
});
