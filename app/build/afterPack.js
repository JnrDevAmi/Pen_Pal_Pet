"use strict";
/*
 * Drops Electron runtime pieces this app provably does not use.
 *
 * Pen-pal Pet draws 2D SVG pets and paper windows. It has no WebGPU, no 3D
 * canvas, and no audio or video anywhere. The DirectX shader compiler and the
 * media pipeline are therefore dead weight in every download.
 *
 * Deliberately KEPT, despite being tempting:
 *   LICENSES.chromium.html  20MB, but Chromium's licence requires the
 *                           attribution ships with the binary.
 *   vk_swiftshader.dll      the software renderer machines without working GPU
 *   vulkan-1.dll            drivers fall back to.
 *   d3dcompiler_47.dll      ANGLE needs it for D3D.
 *   ffmpeg.dll              the renderer will not start without it, however
 *                           little media the app plays.
 */
const fs = require("fs");
const path = require("path");

const DROP = [
  "dxcompiler.dll",   // ~24.6 MB - DirectX shader compiler, WebGPU only
  "dxil.dll",         // ~1.4 MB  - signs those shaders
];

// NOT dropped, though it looks unused:
//   ffmpeg.dll  ~3 MB. The app plays no audio or video, but Chromium's
//   renderer links it unconditionally: without it the renderer process dies
//   on startup, ready-to-show never fires, and the app runs headless - tray
//   alive, window created but never shown. Verified by removing it from an
//   installed build and watching exactly that happen.

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  let freed = 0;
  const removed = [];
  for (const name of DROP) {
    const file = path.join(dir, name);
    try {
      const { size } = fs.statSync(file);
      fs.unlinkSync(file);
      freed += size;
      removed.push(name);
    } catch {
      // Not present on this platform; nothing to do.
    }
  }
  if (removed.length) {
    console.log(`  • trimmed unused runtime  files=${removed.join(", ")} freed=${(freed / 1048576).toFixed(1)}MB`);
  }
};
