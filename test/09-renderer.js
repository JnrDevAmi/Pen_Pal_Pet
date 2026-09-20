"use strict";
/*
 * End-to-end through the real renderer: the real preload, the real page, a
 * realistic state snapshot. Opens every screen, clicks every shortcut, feeds
 * the page hostile content, and fails on any console error or crash.
 *
 * Run with:  node_modules/.bin/electron ../test/09-renderer.js
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const APP = path.join(__dirname, "..", "app");
const { Store } = require(path.join(APP, "store.js"));
const C = require(path.join(APP, "crypto.js"));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-rend-"));
const store = new Store(dir);
store.setProfile("Robin", { name: "Biscuit", species: "cat", color: "honey" });

const friend = C.newKeys();
const friendId = C.deriveId(friend.sigPub);

// Deliberately nasty display data: if any of this is ever treated as markup
// rather than text, the DOM assertions below will notice.
const XSS = '<img src=x onerror="window.__pwned=1">';
const peers = [{
  id: friendId, name: XSS, pet: { name: XSS, species: "frog", color: "moss" },
  safety: C.safetyCode(store.identity.sigPub, friend.sigPub), verified: false,
}];
const now = Date.now();
const snapshot = {
  me: {
    id: store.identity.id, name: "Robin",
    pet: { name: "Biscuit", species: "cat", color: "honey" },
    ready: true, acceptAnyone: true,
  },
  peers,
  notes: [
    {
      id: "n_out1", dir: "out", status: "waiting", peerId: friendId,
      peerName: XSS, peerPet: peers[0].pet, note: XSS,
      doodle: [{ c: 2, p: [10, 10, 80, 60] }], reply: null,
      createdAt: now - 5000, sentAt: 0, deliveredAt: 0, arriveAt: 0, openedAt: 0,
      repliedAt: 0, returnAt: 0, readAt: 0, recalledAt: 0, replyPending: false, attempts: 0,
    },
    {
      id: "n_in1", dir: "in", status: "arrived", peerId: friendId,
      peerName: XSS, peerPet: peers[0].pet, note: XSS,
      doodle: [], reply: null,
      createdAt: now - 40000, sentAt: now - 40000, deliveredAt: now - 30000,
      arriveAt: now - 12000, openedAt: 0, repliedAt: 0, returnAt: 0, readAt: 0,
      recalledAt: 0, replyPending: false, attempts: 0,
    },
  ],
  travelMs: 8000, port: 51234,
};

const calls = [];
ipcMain.handle("state:get", () => snapshot);
ipcMain.handle("do", (_e, msg) => { calls.push(msg); return { ok: true }; });
ipcMain.on("status", () => {});
ipcMain.on("app:quit", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1040, height: 700, show: false,
    webPreferences: {
      preload: path.join(APP, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });

  const errors = [];
  win.webContents.on("console-message", (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });
  win.webContents.on("render-process-gone", (_e, d) => errors.push("renderer gone: " + d.reason));
  win.webContents.on("preload-error", (_e, f, err) => errors.push("preload: " + err.message));

  await win.loadFile(path.join(APP, "renderer", "index.html"));
  win.setPosition(-4000, 0);
  win.showInactive();
  await sleep(2500);

  // Each snippet runs in its own scope: executeJavaScript shares one context,
  // so a bare `const` would collide on the second call.
  const $ = (js) => win.webContents.executeJavaScript(`(() => { ${js} })()`, true);
  const clickByText = (label) => $(`
    const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;`);
  const closeWindow = () => $(`
    const b = [...document.querySelectorAll(".win button, .win .close")]
      .find(x => /close|×/i.test((x.textContent || "") + (x.getAttribute("aria-label") || "")));
    if (b) b.click();
    return !!b;`);

  /* ---------------- the shell renders ---------------- */
  check("page loaded without console errors", errors.length === 0, errors[0] || "");

  const rail = await $(`return [...document.querySelectorAll(".rail-btn")].map(b => b.dataset.key);`);
  check("all four shortcuts are present", rail.length === 4 && rail.includes("write")
    && rail.includes("mailbag") && rail.includes("friends") && rail.includes("pet"),
    rail.join(", "));

  const bar = await $(`return { text: document.getElementById("sb-text").textContent,
                         clock: document.getElementById("sb-clock").textContent,
                         pet: document.getElementById("sb-pet").innerHTML.length };`);
  check("status bar shows text, a pet and a clock",
    bar.text.length > 0 && /\d/.test(bar.clock) && bar.pet > 0,
    `"${bar.text}" ${bar.clock}`);

  const pets = await $(`return document.querySelectorAll(".pet").length;`);
  check("pets are on the stage", pets > 0, `${pets} pet(s)`);

  const badge = await $(`return (document.querySelector('[data-key="mailbag"] .rail-badge')||{}).textContent || "";`);
  check("mailbag badge reflects the waiting note", badge === "1", `badge="${badge}"`);

  /* ---------------- hostile content stays text ---------------- */
  const pwned = await $(`return !!window.__pwned;`);
  check("script in a friend's name did not execute", pwned === false);

  const injected = await $(`return document.querySelectorAll('img[src="x"]').length;`);
  check("no markup was built from note or peer text", injected === 0, `${injected} injected node(s)`);

  /* ---------------- every screen opens and closes ---------------- */
  for (const [key, title] of [["write", "Write a note"], ["mailbag", "Mailbag"],
    ["friends", "Nearby friends"], ["pet", "My pet"]]) {
    await $(`document.querySelector('[data-key="${key}"]').click(); return true;`);
    await sleep(700);
    const open = await $(`return !!document.querySelector(".win");`);
    check(`${title} opens`, open === true);
    await closeWindow();
    await sleep(400);
  }

  /* ---------------- the safety-code flow ---------------- */
  await $(`document.querySelector('[data-key="friends"]').click(); return true;`);
  await sleep(700);
  const code = await $(`return (document.querySelector(".safety-code")||{}).textContent || "";`);
  check("a safety code is shown for an unverified friend",
    /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/.test(code), code);
  check("the shown code matches what the app derives", code === peers[0].safety);

  const before = calls.length;
  await clickByText("Check");
  await sleep(600);
  await clickByText("They match");
  await sleep(600);
  const verified = calls.slice(before).find((c) => c.action === "verifyFriend");
  check("confirming the code calls verifyFriend", !!verified,
    verified ? `id=${String(verified.payload.id).slice(0, 12)}` : "not called");

  /* ---------------- the impostor warning ---------------- */
  win.webContents.send("net-event", { kind: "impostor", id: friendId, name: "Priya", wasVerified: true });
  await sleep(900);
  const warned = await $(`return document.body.textContent.includes("Something is wrong")
     || document.body.textContent.includes("pretending to be");`);
  check("an impostor event warns the user", warned === true);

  /* ---------------- commands from the tray ---------------- */
  for (const cmd of ["write", "mailbag", "friends", "pet"]) {
    win.webContents.send("command", cmd);
    await sleep(500);
    const open = await $(`return !!document.querySelector(".win");`);
    check(`tray command "${cmd}" opens its screen`, open === true);
    await closeWindow();
    await sleep(300);
  }

  // A command the preload does not allow must be dropped before the page sees it.
  const beforeJunk = await $(`return !!document.querySelector(".win");`);
  win.webContents.send("command", "__proto__");
  win.webContents.send("command", "evil");
  await sleep(500);
  const afterJunk = await $(`return !!document.querySelector(".win");`);
  check("an unknown tray command is ignored", beforeJunk === afterJunk);

  /* ---------------- resilience ---------------- */
  win.webContents.send("state", null);
  win.webContents.send("net-event", null);
  win.webContents.send("state", { me: null, peers: null, notes: null });
  await sleep(700);
  check("malformed pushes from main do not break the page",
    errors.length === 0, errors[0] || "");

  win.setSize(760, 520);
  await sleep(600);
  win.setSize(1300, 860);
  await sleep(600);
  const alive = await $(`return !!document.getElementById("stage") && document.querySelectorAll(".pet").length >= 0;`);
  check("resizing keeps the page intact", alive === true);

  check("no console errors across the whole run", errors.length === 0,
    errors.length ? errors.slice(0, 2).join(" | ") : "");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} renderer checks passed`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  app.exit(failed.length ? 1 : 0);
});
