"use strict";
/* Load, flood and churn. Every peer here is a real process-local Net with real sockets. */
const { makePeer, compose, until, sleep, teardown } = require("./harness");
const { ReplayGuard, newNonce } = require("../app/crypto.js");

const results = [];
const rec = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const mb = () => Math.round(process.memoryUsage().heapUsed / 1048576);

(async () => {
  // ---------- 1. Many peers on one network ----------
  // 20 is the ceiling for peers sharing ONE event loop; past that the loop
  // itself is the bottleneck, not the protocol. Realistic scaling (one peer
  // per OS process, as on real machines) is covered by 05-multiproc.js, which
  // reaches full convergence at 30.
  const N = 20;
  console.log(`  spinning up ${N} peers...`);
  const m0 = mb();
  const t0 = Date.now();
  const crowd = [];
  for (let i = 0; i < N; i++) crowd.push(makePeer(`User${i}`, `Pet${i}`, ["cat", "pup", "frog", "bird"][i % 4]));

  const hub = crowd[0];
  await until(`${N - 1} peers discovered`, () => hub.net.onlinePeers().length >= N - 1, 90000);
  const discovery = Date.now() - t0;
  rec(`${N} peers all discover each other`, hub.net.onlinePeers().length === N - 1,
    `${discovery}ms, heap ${m0}MB -> ${mb()}MB`);

  // Every peer should see every other peer, not just the hub.
  const allSee = crowd.every((p) => p.net.onlinePeers().length === N - 1);
  rec("discovery is symmetric across all peers", allSee,
    `min seen = ${Math.min(...crowd.map((p) => p.net.onlinePeers().length))}`);

  // ---------- 2. The realistic burst: everyone writes to one person at once ----------
  const target = crowd[1];
  const senders = crowd.slice(2);
  console.log(`  ${senders.length} peers each send one note simultaneously...`);
  const b0 = Date.now();
  const burst = senders.map((s, i) => {
    const n = compose(s, target.id, `burst ${i}`);
    return s.net.depart(n.id).then(() => n.id);
  });
  const burstIds = await Promise.all(burst);
  await until("burst delivered", () => burstIds.every((id) => target.store.get(id)), 20000).catch(() => {});
  const landed = burstIds.filter((id) => target.store.get(id)).length;
  rec("simultaneous burst from every peer arrives intact", landed === senders.length,
    `${landed}/${senders.length} in ${Date.now() - b0}ms`);

  // ---------- 2b. Sustained throughput, paced the way a queue would drain ----------
  const SUSTAIN = 80, LANES = 6;
  console.log(`  sustaining ${SUSTAIN} notes at concurrency ${LANES}...`);
  const ids = [];
  const t2 = Date.now();
  let cursor = 0;
  let skipped = 0;
  await Promise.all(Array.from({ length: LANES }, async () => {
    while (cursor < SUSTAIN) {
      const i = cursor++;
      // Under a saturated event loop a sender can briefly TTL-expire the
      // target; pick one that can still see it rather than failing the run.
      const sender = senders.find((s, k) => k >= i % senders.length && s.net.peers.has(target.id))
        || senders.find((s) => s.net.peers.has(target.id));
      if (!sender) { skipped++; continue; }
      const n = compose(sender, target.id, `sustain ${i}`);
      ids.push(n.id);
      await sender.net.depart(n.id);
    }
  }));
  await until("sustained delivered", () => ids.every((id) => target.store.get(id)), 30000).catch(() => {});
  const got = ids.filter((id) => target.store.get(id)).length;
  const secs = (Date.now() - t2) / 1000;
  rec("sustained load delivered without loss", got === ids.length && skipped === 0,
    `${got}/${ids.length} sent in ${secs.toFixed(1)}s (${Math.round(ids.length / secs)}/s)` + (skipped ? `, ${skipped} skipped` : ""));

  // Contents must survive the load, not just the count.
  const sample = target.store.get(ids[Math.floor(ids.length / 2)]);
  rec("note contents intact under load", !!sample && /^sustain \d+$/.test(sample.note),
    sample ? `"${sample.note}"` : "missing");

  // ---------- 3. Store cap holds ----------
  const MAX_NOTES = 500;
  for (let i = 0; i < 400; i++) {
    target.store.put(target.store.cleanNote({
      id: `n_bulk_${i}`, dir: "in", status: "read", peerId: hub.id,
      peerName: "Bulk", note: `bulk ${i}`, createdAt: Date.now() + i,
    }));
  }
  target.store.saveNow();
  const { Store } = require("../app/store.js");
  const reloaded = new Store(target.dir);
  rec("store caps at MAX_NOTES on reload", reloaded.list().length <= MAX_NOTES,
    `${target.store.list().length} in memory -> ${reloaded.list().length} on reload`);

  // ---------- 4. Peer churn ----------
  console.log("  churning peers on and off...");
  const churnErrors = [];
  process.once("uncaughtException", (e) => churnErrors.push(e.message));
  for (let round = 0; round < 3; round++) {
    for (let i = 10; i < 20; i++) crowd[i].net.stop();
    await sleep(300);
    for (let i = 10; i < 20; i++) crowd[i].net.start();
    await sleep(300);
  }
  await sleep(500);
  rec("rapid stop/start churn raises nothing", churnErrors.length === 0,
    churnErrors.length ? churnErrors[0] : "30 stop/start cycles clean");

  // ---------- 5. Sending to a peer that vanished mid-flight ----------
  const ghost = crowd[N - 1];
  const gNote = compose(hub, ghost.id, "you vanished");
  ghost.net.stop();
  hub.net.peers.delete(ghost.id);
  const gres = await hub.net.depart(gNote.id);
  rec("delivery to a vanished peer re-queues", !gres.ok && hub.store.get(gNote.id).status === "waiting",
    "note preserved");

  // ---------- 6. Replay guard cannot be grown without bound ----------
  const guard = new ReplayGuard();
  const now = Date.now();
  for (let i = 0; i < 50000; i++) guard.accept(newNonce(), now);
  rec("replay guard bounded under 50k nonce flood", guard.seen.size <= 5000,
    `${guard.seen.size} entries retained`);

  // A nonce inside the window is still caught after the flood.
  const n1 = newNonce();
  const firstOk = guard.accept(n1, Date.now());
  const secondOk = guard.accept(n1, Date.now());
  rec("replay still detected after flood", firstOk && !secondOk);

  console.log(`\n  peak heap: ${mb()}MB for ${N} live peers`);
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} stress checks passed`);
  teardown(...crowd);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("\nERROR:", e.message, e.stack); process.exit(1); });
