"use strict";
const { makePeer, until, teardown } = require("./harness");

(async () => {
  console.log("Starting two peers on this host...");
  const A = makePeer("Robin", "Biscuit", "cat", "honey");
  const B = makePeer("Priya", "Mochi", "frog", "moss");
  console.log(`  A id=${A.id}`);
  console.log(`  B id=${B.id}`);

  await until("A's HTTP port", () => A.net.port);
  await until("B's HTTP port", () => B.net.port);
  console.log(`  A listening on :${A.net.port}   B listening on :${B.net.port}`);

  console.log("Waiting for discovery over UDP...");
  const t0 = Date.now();
  await until("A sees B", () => A.net.peers.has(B.id));
  await until("B sees A", () => B.net.peers.has(A.id));
  const dt = Date.now() - t0;

  const pb = A.net.peers.get(B.id);
  console.log(`\nDISCOVERY OK in ${dt}ms`);
  console.log(`  A sees: ${pb.name} / pet ${pb.pet.name} (${pb.pet.species}, ${pb.pet.color}) at ${pb.ip}:${pb.port}`);
  const pa = B.net.peers.get(A.id);
  console.log(`  B sees: ${pa.name} / pet ${pa.pet.name} (${pa.pet.species}, ${pa.pet.color}) at ${pa.ip}:${pa.port}`);

  teardown(A, B);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
