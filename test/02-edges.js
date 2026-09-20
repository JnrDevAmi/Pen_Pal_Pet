"use strict";
const { makePeer, compose, until, sleep, teardown } = require("./harness");
const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); };

(async () => {
  const A = makePeer("Robin", "Biscuit");
  const B = makePeer("Priya", "Mochi", "frog", "moss");
  await until("discovery", () => A.net.peers.has(B.id) && B.net.peers.has(A.id));

  // 1. Self-send ("Me (test run)")
  const selfNote = compose(A, A.id, "note to myself");
  await A.net.depart(selfNote.id);
  const selfCopy = await until("self copy", () => A.store.get(selfNote.id + ":in"));
  check("self-send creates local :in copy", selfCopy && selfCopy.note === "note to myself");
  await until("self arrives", () => A.store.get(selfNote.id + ":in").status === "arrived", 14000);
  await A.net.markOpened(selfNote.id + ":in");
  await A.net.sendReply(selfNote.id + ":in", { wave: true });
  check("self-reply mirrors to outgoing", A.store.get(selfNote.id).status === "replied" && A.store.get(selfNote.id).reply.wave === true);

  // 2. Duplicate delivery is idempotent (replay of same note)
  const dupNote = compose(A, B.id, "only once please");
  await A.net.depart(dupNote.id);
  await until("delivered", () => B.store.get(dupNote.id));
  const peerB = A.net.peers.get(B.id);
  const again = await A.net.post(peerB, "/note", { noteId: dupNote.id, note: "TAMPERED", doodle: [], sentAt: Date.now() });
  check("duplicate note rejected", again.ok && again.data.duplicate === true && B.store.get(dupNote.id).note === "only once please",
        `text still "${B.store.get(dupNote.id).note}"`);

  // 3. Recall brings the pet home
  const recNote = compose(A, B.id, "come back!");
  await A.net.depart(recNote.id);
  await until("delivered", () => B.store.get(recNote.id));
  await A.net.recall(recNote.id);
  check("recall marks sender recalled", A.store.get(recNote.id).status === "recalled");
  await until("B honours recall", () => B.store.get(recNote.id).status === "recalled", 5000);
  check("recall propagates to recipient", B.store.get(recNote.id).status === "recalled");

  // 4. acceptAnyone=false refuses strangers
  B.store.setAcceptAnyone(false);
  const C = makePeer("Stranger", "Rex", "pup", "slate");
  await until("C discovered by B", () => B.net.peers.has(C.id) && C.net.peers.has(B.id));
  const snub = compose(C, B.id, "hi stranger here");
  await C.net.depart(snub.id);
  await sleep(1200);
  check("stranger note refused when locked down", !B.store.get(snub.id) && C.store.get(snub.id).status === "waiting",
        "sender re-queued to waiting");
  const refusedEv = C.events.find((e) => e.kind === "refused");
  check("sender told they were refused", !!refusedEv);
  B.store.setAcceptAnyone(true);

  // 5. Delivery to an offline peer queues instead of losing the note
  const offNote = compose(A, B.id, "you were asleep");
  B.net.stop();
  await sleep(200);
  A.net.peers.delete(B.id);             // simulate TTL expiry
  const res = await A.net.depart(offNote.id);
  check("offline delivery fails safely", !res.ok && A.store.get(offNote.id).status === "waiting",
        "note held, not lost");
  const failEv = A.events.find((e) => e.kind === "deliveryFailed");
  check("deliveryFailed event emitted", !!failEv);

  // 6. Store survives a reload from disk
  A.store.saveNow();
  const { Store } = require("../app/store.js");
  const reloaded = new Store(A.dir);
  check("notes survive restart", reloaded.get(dupNote.id) && reloaded.get(dupNote.id).note === "only once please",
        `${reloaded.list().length} notes reloaded`);
  check("identity survives restart", reloaded.identity.id === A.id && reloaded.identity.name === "Robin");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} edge cases passed`);
  teardown(A, B, C);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("\nERROR:", e.message); process.exit(1); });
