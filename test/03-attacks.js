"use strict";
const dgram = require("dgram");
const http = require("http");
const crypto = require("crypto");
const { makePeer, compose, until, sleep, teardown } = require("./harness");
const { Net } = require("../app/net.js");
const C = require("../app/crypto.js");

const DISCOVERY_PORT = 41234, MULTICAST = "239.255.41.17";
const CTRL = String.fromCharCode(0) + String.fromCharCode(7) + "bad" + String.fromCharCode(31) + "chars";
const CTRL_RE = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + "]");

const out = [];
const rec = (name, secure, detail = "") => {
  out.push({ name, secure });
  console.log(`  ${secure ? "BLOCKED " : "*VULN*  "} ${name}${detail ? "  -> " + detail : ""}`);
};

function rawPost(port, path, body, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const req = http.request({
      host, port, path, method: "POST", timeout: 4000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => resolve({ code: res.statusCode, body: d }));
    });
    req.on("error", (e) => resolve({ code: 0, err: e.code }));
    req.on("timeout", () => { req.destroy(); resolve({ code: 0, err: "timeout" }); });
    req.end(body);
  });
}

/** Build a genuine, correctly signed envelope from one peer to another. */
function envelope(from, to, path, inner, over = {}) {
  const me = from.store.identity;
  const ts = over.ts !== undefined ? over.ts : Date.now();
  const nonce = over.nonce !== undefined ? over.nonce : C.newNonce();
  const key = C.messageKey(me.priv, to.store.identity.pub, me.sigPub, to.store.identity.sigPub);
  const box = C.seal(key, inner, Net.aad(me.id, to.id, path, ts, nonce));
  return JSON.stringify({
    from: me.id, to: to.id, ts, nonce, box,
    sig: C.sign(me.sigPriv, Net.transcript(me.id, to.id, path, ts, nonce, box)),
  });
}

(async () => {
  const A = makePeer("Robin", "Biscuit");
  const B = makePeer("Priya", "Mochi", "frog", "moss");
  await until("discovery", () => A.net.peers.has(B.id) && B.net.peers.has(A.id));
  const LAN = B.net.peers.get(A.id).ip;
  console.log(`  (A and B are legitimate, mutually discovered on ${LAN})\n`);

  // ---- input handling (regression from v1) ----
  let r = await rawPost(A.net.port, "/note", JSON.stringify({ from: "p_deadbeefdeadbeef", box: {} }));
  rec("POST from unknown sender", r.code === 409, `HTTP ${r.code}`);

  r = await rawPost(A.net.port, "/note", "{not json at all");
  rec("malformed JSON body", r.code === 400, `HTTP ${r.code}`);

  r = await rawPost(A.net.port, "/note", JSON.stringify({ from: B.id, box: {}, pad: "x".repeat(600 * 1024) }));
  rec("oversized body (600KB)", r.code === 0 || r.code >= 400, r.err || `HTTP ${r.code}`);

  r = await rawPost(A.net.port, "/nonsense", JSON.stringify({ from: B.id, box: {} }));
  rec("unknown endpoint", r.code === 404, `HTTP ${r.code}`);

  const peerA = B.net.peers.get(A.id);
  await B.net.post(peerA, "/note", JSON.parse(JSON.stringify({
    noteId: "n_proto", note: "hi", doodle: [], sentAt: Date.now(),
    __proto__: { polluted: "yes" }, constructor: { prototype: { polluted: "yes" } },
  })));
  await sleep(400);
  rec("prototype pollution via note payload", {}.polluted === undefined);

  const huge = [];
  for (let i = 0; i < 900; i++) huge.push({ c: 99, p: [NaN, Infinity, -1e9, 1e9, "x", null] });
  await B.net.post(peerA, "/note", { noteId: "n_doodle", note: CTRL, doodle: huge, sentAt: Date.now() });
  const dn = await until("hostile doodle", () => A.store.get("n_doodle"), 5000).catch(() => null);
  let sane = false;
  if (dn) {
    const pts = dn.doodle.flatMap((s) => s.p);
    sane = dn.doodle.length <= 300 && pts.every((v) => Number.isFinite(v) && v >= 0 && v <= 320)
      && dn.doodle.every((s) => s.c >= 0 && s.c < 5) && !CTRL_RE.test(dn.note);
  }
  rec("hostile doodle (NaN/Infinity/900 strokes)", sane, dn ? `clamped to ${dn.doodle.length} strokes` : "rejected");

  await B.net.post(peerA, "/note", { noteId: "n_long", note: "z".repeat(50000), doodle: [], sentAt: Date.now() });
  const ln = await until("long note", () => A.store.get("n_long"), 5000).catch(() => null);
  rec("50KB note text", !!ln && ln.note.length === 140, ln ? `truncated to ${ln.note.length}` : "rejected");

  // ================= v2: message-layer attacks =================
  console.log("\n  --- message forgery ---");

  // Replay a genuine envelope a second time.
  const body = envelope(B, A, "/note", { noteId: "n_replay", note: "replay me", doodle: [], sentAt: Date.now() });
  const first = await rawPost(A.net.port, "/note", body, LAN);
  const second = await rawPost(A.net.port, "/note", body, LAN);
  rec("replay of a genuine envelope", first.code === 200 && second.code === 409,
    `first HTTP ${first.code}, replay HTTP ${second.code}`);

  // A genuine envelope, but delivered from an address the sender never announced.
  const wrongSrc = await rawPost(A.net.port, "/note",
    envelope(B, A, "/note", { noteId: "n_src", note: "x", doodle: [], sentAt: Date.now() }), "127.0.0.1");
  rec("genuine envelope from an unannounced address", wrongSrc.code === 409, `HTTP ${wrongSrc.code}`);

  // Same envelope, delivered to a different endpoint.
  const crossBody = envelope(B, A, "/note", { noteId: "n_cross", note: "cross", doodle: [], sentAt: Date.now() });
  const cross = await rawPost(A.net.port, "/reply", crossBody, LAN);
  rec("envelope replayed at a different endpoint", cross.code >= 400, `HTTP ${cross.code}`);

  // Tamper with one byte of ciphertext, keep the signature.
  const t = JSON.parse(envelope(B, A, "/note", { noteId: "n_tamper", note: "x", doodle: [], sentAt: Date.now() }));
  const ctBuf = Buffer.from(t.box.ct, "base64");
  ctBuf[0] ^= 0xff;
  t.box.ct = ctBuf.toString("base64");
  const tampered = await rawPost(A.net.port, "/note", JSON.stringify(t), LAN);
  rec("tampered ciphertext", tampered.code >= 400 && !A.store.get("n_tamper"), `HTTP ${tampered.code}`);

  // Stale timestamp, well outside the skew window.
  const stale = await rawPost(A.net.port, "/note",
    envelope(B, A, "/note", { noteId: "n_stale", note: "old", doodle: [], sentAt: 0 }, { ts: Date.now() - 600000 }), LAN);
  rec("stale timestamp (10 min old)", stale.code === 409, `HTTP ${stale.code}`);

  // Valid signature from B, but addressed to someone else.
  const mis = JSON.parse(envelope(B, A, "/note", { noteId: "n_mis", note: "x", doodle: [], sentAt: Date.now() }));
  mis.to = "p_0000000000000000";
  const misres = await rawPost(A.net.port, "/note", JSON.stringify(mis), LAN);
  rec("envelope addressed to a different peer", misres.code >= 400, `HTTP ${misres.code}`);

  // ---- a peer you accepted tries to push your notes out of the mailbag ----
  // The store keeps only the newest notes, so without a limit a flood from
  // somebody whose key you once accepted silently destroys what you kept.
  A.store.put(A.store.cleanNote({
    id: "n_keepsake", dir: "in", status: "read", peerId: B.id,
    peerName: "Priya", note: "worth keeping", createdAt: Date.now() - 600000,
  }));
  A.store.saveNow();
  let flooded = 0;
  for (let i = 0; i < 60; i++) {
    const r = await B.net.post(peerA, "/note",
      { noteId: "n_flood_" + i, note: "spam", doodle: [], sentAt: Date.now() });
    if (r.ok) flooded++;
  }
  A.store.saveNow();
  const { Store: S2 } = require("../app/store.js");
  const survived = !!new S2(A.dir).get("n_keepsake");
  rec("note flood from an accepted peer", flooded < 60 && survived,
    `${flooded}/60 accepted, keepsake ${survived ? "survived" : "DESTROYED"}`);

  // ================= v2: THE BIG ONE, retried =================
  console.log("\n  --- identity spoofing (the v1 hole) ---");
  const evilX = crypto.generateKeyPairSync("x25519");
  const evilEd = crypto.generateKeyPairSync("ed25519");
  const evilPub = evilX.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const evilPriv = evilX.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const evilSigPub = evilEd.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const evilSigPriv = evilEd.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

  let stolen = null;
  const evilServer = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => { b += d; });
    req.on("end", () => {
      try {
        const msg = JSON.parse(b);
        const key = C.messageKey(evilPriv, A.store.identity.pub, evilSigPub, A.store.identity.sigPub);
        stolen = C.unseal(key, msg.box, Net.aad(msg.from, msg.to, "/note", msg.ts, msg.nonce));
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((res) => evilServer.listen(0, "0.0.0.0", res));
  const evilPort = evilServer.address().port;

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  await new Promise((res) => sock.bind(res));
  sock.setBroadcast(true);

  async function blast(bodyObj, sigPriv) {
    const raw = JSON.stringify(bodyObj);
    const pkt = Buffer.from(JSON.stringify({
      v: 2, t: "hi", b: Buffer.from(raw, "utf8").toString("base64"),
      sig: sigPriv ? C.sign(sigPriv, raw) : "AAAA",
    }));
    for (let i = 0; i < 3; i++) { sock.send(pkt, DISCOVERY_PORT, MULTICAST); await sleep(120); }
    await sleep(500);
  }

  // Attack 1: claim B's ID, sign with the attacker's own key.
  await blast({
    id: B.id, name: "Priya", pet: { name: "Mochi", species: "frog", color: "moss" },
    port: evilPort, pub: evilPub, sigPub: evilSigPub, ts: Date.now(), nonce: C.newNonce(),
  }, evilSigPriv);
  let hj = A.net.peers.get(B.id);
  rec("forged beacon claiming a friend's ID", !hj || hj.port !== evilPort,
    hj && hj.port === evilPort ? `HIJACKED to port ${evilPort}` : "ID/key mismatch rejected");

  // Attack 2: claim B's ID *and* B's real signing key, but the attacker's address.
  await blast({
    id: B.id, name: "Priya", pet: { name: "Mochi", species: "frog", color: "moss" },
    port: evilPort, pub: evilPub, sigPub: B.store.identity.sigPub, ts: Date.now(), nonce: C.newNonce(),
  }, evilSigPriv);
  hj = A.net.peers.get(B.id);
  rec("forged beacon with a stolen public key", !hj || hj.port !== evilPort,
    hj && hj.port === evilPort ? `HIJACKED to port ${evilPort}` : "signature check failed");

  // Attack 3: an honest attacker ID, but impersonating the display name.
  const evilId = C.deriveId(evilSigPub);
  await blast({
    id: evilId, name: "Priya", pet: { name: "Mochi", species: "frog", color: "moss" },
    port: evilPort, pub: evilPub, sigPub: evilSigPub, ts: Date.now(), nonce: C.newNonce(),
  }, evilSigPriv);
  const twin = A.net.peers.get(evilId);
  const realSafety = A.net.peers.get(B.id) ? A.net.peers.get(B.id).safety : null;
  rec("name-twin appears as a separate identity with its own safety code",
    !!twin && twin.id !== B.id && twin.safety !== realSafety,
    twin ? `real Priya=${realSafety}, twin=${twin.safety}` : "not seen");

  // Did anything leak?
  const victimNote = compose(A, B.id, "SECRET: the spare key is under the mat");
  await A.net.depart(victimNote.id);
  await sleep(900);
  rec("private note readable by impostor", !stolen,
    stolen ? `attacker decrypted: "${stolen.note}"` : "delivered only to the real Priya");
  const landed = B.store.get(victimNote.id);
  rec("note still reached the genuine friend", !!landed, landed ? `"${landed.note}"` : "LOST");

  const imp = A.events.find((e) => e.kind === "impostor");
  console.log(`\n  user-visible warning: ${imp ? `impostor alert for "${imp.name}"` : "none (attack never got far enough to warn)"}`);

  sock.close();
  evilServer.close();
  const vulns = out.filter((o) => !o.secure);
  console.log(`\n${out.length - vulns.length}/${out.length} attacks blocked`);
  if (vulns.length) console.log(`VULNERABLE: ${vulns.map((v) => v.name).join("; ")}`);
  teardown(A, B);
  process.exit(vulns.length ? 1 : 0);
})().catch((e) => { console.error("\nERROR:", e.message, e.stack); process.exit(1); });
