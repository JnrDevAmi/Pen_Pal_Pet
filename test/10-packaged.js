"use strict";
/*
 * Smoke test for a built app, not the source.
 *
 * This exists because of a real escape: an afterPack hook trimmed ffmpeg.dll
 * to save 3MB, the main process still started and still wrote its files, so
 * every check passed - while the renderer died on launch and the window was
 * created but never shown. The app ran headless and looked installed.
 *
 * So the assertion here is the one that would have caught it: a real window
 * must become VISIBLE. Everything else is secondary.
 *
 *   node test/10-packaged.js [path-to-built-exe]
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const DEFAULT = path.join(__dirname, "..", "app", "dist", "win-unpacked", "Pen-pal Pet.exe");
const exe = process.argv[2] || DEFAULT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask Windows whether this app owns a window that is actually on screen. */
function visibleWindow(dir) {
  const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class V {
  [DllImport("user32.dll")] public static extern bool EnumWindows(P cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  public delegate bool P(IntPtr h, IntPtr l);
}
"@
$ids = (Get-Process | Where-Object { $_.Path -like '${dir}*' }).Id
$script:hit = ''
$cb = [V+P]{
  param($h,$l)
  $pp = 0; [V]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
  if (($ids -contains $pp) -and [V]::IsWindowVisible($h)) {
    $t = New-Object System.Text.StringBuilder 256
    [V]::GetWindowText($h,$t,256) | Out-Null
    if ($t.ToString().Trim()) { $script:hit = $t.ToString().Trim(); return $false }
  }
  return $true
}
[V]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null
Write-Output $script:hit
`;
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

function killApp(dir) {
  try {
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-Process | Where-Object { $_.Path -like '${dir}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`],
      { timeout: 20000 });
  } catch {}
}

(async () => {
  if (process.platform !== "win32") {
    console.log("  SKIP  this smoke test is Windows-only");
    process.exit(0);
  }
  if (!fs.existsSync(exe)) {
    console.log(`  no built app at ${exe}\n  build one first: npm run dist:portable`);
    process.exit(1);
  }
  // PowerShell -like matches literally, so the prefix must be in Windows form.
  const dir = path.win32.normalize(path.dirname(exe));
  console.log(`  testing ${exe}\n`);

  // Everything the app needs at runtime, including the pieces that look unused.
  for (const dll of ["ffmpeg.dll", "vk_swiftshader.dll", "d3dcompiler_47.dll"]) {
    check(`${dll} is present`, fs.existsSync(path.join(dir, dll)),
      dll === "ffmpeg.dll" ? "renderer will not start without it" : "");
  }
  const asar = path.join(dir, "resources", "app.asar");
  check("app.asar packed", fs.existsSync(asar),
    fs.existsSync(asar) ? `${Math.round(fs.statSync(asar).size / 1024)} KB` : "");

  // The real check: launch it and wait for a window to appear on screen.
  killApp(dir);
  await sleep(1500);
  const profile = path.join(process.env.APPDATA || os.tmpdir(), "Pen-pal Pet");
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

  const child = spawn(exe, [], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  let title = "";
  for (let i = 0; i < 20 && !title; i++) {
    await sleep(1200);
    title = visibleWindow(dir);
  }

  check("a window becomes visible", !!title, title || "none appeared within 24s");
  check("renderer did not crash", !/crash/i.test(out), (out.match(/.*crash.*/i) || [""])[0].slice(0, 70));

  const id = path.join(profile, "identity.json");
  const wrote = fs.existsSync(id);
  check("identity written on first run", wrote);
  if (wrote) {
    const raw = fs.readFileSync(id, "utf8");
    check("identity sealed at rest", !!JSON.parse(raw).sealed);
    check("no readable keys on disk", !/sigPriv|"priv"/.test(raw));
  }

  killApp(dir);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} packaged checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
