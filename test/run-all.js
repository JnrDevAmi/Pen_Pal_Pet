"use strict";
/* Every suite, one at a time. They share a multicast group, so running two at
   once pollutes each other's peer lists. */
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const ELECTRON = path.join(ROOT, "app", "node_modules", ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron");
const hasElectron = fs.existsSync(ELECTRON);

const suites = [
  ["units",        "node", ["--test", "test/06-units.js"]],
  ["ipc surface",  "node", ["--test", "test/07-ipc.js"]],
  ["hardening",    "node", ["--test", "test/08-hardening.js"]],
  ["discovery",    "node", ["test/00-discovery.js"]],
  ["round trip",   "node", ["test/01-roundtrip.js"]],
  ["edges",        "node", ["test/02-edges.js"]],
  ["attacks",      "node", ["test/03-attacks.js"]],
  ["stress",       "node", ["test/04-stress.js"]],
  ["renderer",     "electron", ["test/09-renderer.js"]],
  ["packaged app", "node",     ["test/10-packaged.js"]],
];

let failed = 0;
const skipped = [];
const BUILT = path.join(ROOT, "app", "dist", "win-unpacked", "Pen-pal Pet.exe");
const hasBuild = fs.existsSync(BUILT);

for (const [name, runner, args] of suites) {
  if (runner === "electron" && !hasElectron) { skipped.push(name); continue; }
  // The packaged smoke test needs something built; skip rather than fail when
  // there is nothing in dist/ yet.
  if (name === "packaged app" && (!hasBuild || process.platform !== "win32")) {
    skipped.push(name + " (no build in dist/)");
    continue;
  }
  process.stdout.write(`\n=== ${name} ===\n`);
  const cmd = runner === "electron" ? ELECTRON : process.execPath;
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: runner === "electron" });
  if (r.status !== 0) { failed++; process.stdout.write(`--- ${name} FAILED ---\n`); }
}
if (skipped.length) {
  process.stdout.write(`\nskipped (needs electron: npm install): ${skipped.join(", ")}\n`);
}
process.stdout.write(failed ? `\n${failed} suite(s) FAILED\n` : "\nAll suites passed\n");
process.exit(failed ? 1 : 0);
