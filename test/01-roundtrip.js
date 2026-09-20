"use strict";
const { makePeer, compose, until, teardown } = require("./harness");

const step = (m) => console.log(`  ${m}`);

(async () => {
  const A = makePeer("Robin", "Biscuit");
  const B = makePeer("Priya", "Mochi", "frog", "moss");
  await until("discovery", () => A.net.peers.has(B.id) && B.net.peers.has(A.id));
  step("both peers discovered");

  // --- A writes a note with a doodle and hands it to the pet ---
  const doodle = [{ c: 2, p: [10, 10, 60, 40, 120, 90] }, { c: 0, p: [200, 20, 240, 150] }];
  const note = compose(A, B.id, "hello from the other desktop", doodle);
  step(`A composed note ${note.id} (status=${note.status})`);

  const dep = await A.net.depart(note.id);
  if (!dep.ok) throw new Error("depart failed");
  await until("A marks delivered", () => A.store.get(note.id).status === "delivered");
  step("A: travelling -> delivered (handover succeeded)");

  // --- B received it, encrypted, intact ---
  const inb = await until("B has the note", () => B.store.get(note.id));
  if (inb.note !== "hello from the other desktop") throw new Error(`text corrupted: ${inb.note}`);
  if (inb.doodle.length !== 2) throw new Error(`doodle lost: ${JSON.stringify(inb.doodle)}`);
  if (inb.doodle[0].c !== 2 || inb.doodle[0].p[3] !== 40) throw new Error("doodle corrupted");
  if (inb.peerName !== "Robin") throw new Error(`sender wrong: ${inb.peerName}`);
  step(`B: received "${inb.note}" + ${inb.doodle.length} strokes, from ${inb.peerName}`);
  step(`B: status=${inb.status}, pet arrives in ${Math.round((inb.arriveAt - Date.now()) / 1000)}s`);

  // --- the 8s walk is enforced server-side ---
  await until("pet arrives on B's screen", () => B.store.get(note.id).status === "arrived", 14000);
  step("B: incoming -> arrived (8s walk elapsed)");
  const arrived = B.events.find((e) => e.kind === "arrived");
  if (!arrived) throw new Error("no 'arrived' event emitted");
  step(`B: event fired -> "${arrived.petName} from ${arrived.name}"`);

  // --- B opens it; A should learn it's being read ---
  await B.net.markOpened(note.id);
  await until("A sees it opened", () => A.store.get(note.id).status === "reading");
  step("A: delivered -> reading (read receipt came back)");

  // --- B replies ---
  await B.net.sendReply(note.id, { note: "got it! waving back", doodle: [{ c: 4, p: [5, 5, 90, 90] }] });
  await until("A gets the reply", () => A.store.get(note.id).status === "replied");
  const back = A.store.get(note.id);
  if (back.reply.note !== "got it! waving back") throw new Error(`reply corrupted: ${back.reply.note}`);
  if (back.reply.doodle.length !== 1) throw new Error("reply doodle lost");
  step(`A: reply received -> "${back.reply.note}" + ${back.reply.doodle.length} stroke`);
  step(`A: pet walking home, arrives in ${Math.round((back.returnAt - Date.now()) / 1000)}s`);

  console.log("\nROUND TRIP OK - send, deliver, walk, open, receipt, reply, return");
  teardown(A, B);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
