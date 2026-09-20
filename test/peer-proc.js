"use strict";
/* One peer, one process - the way it actually runs on a real machine. */
const { makePeer } = require("./harness");

const idx = process.argv[2];
const p = makePeer(`User${idx}`, `Pet${idx}`, ["cat", "pup", "frog", "bird"][idx % 4]);

process.on("message", (m) => {
  if (m === "report") {
    process.send({ idx: Number(idx), id: p.id, seen: p.net.onlinePeers().length });
  }
  if (m === "quit") { try { p.net.stop(); } catch {} process.exit(0); }
});
process.send({ ready: true, idx: Number(idx), id: p.id });
