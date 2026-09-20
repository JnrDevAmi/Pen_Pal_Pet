"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const fs = require("fs");
const path = require("path");

const S = require("../app/store.js");
const C = require("../app/crypto.js");

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const US = String.fromCharCode(31);
const DEL = String.fromCharCode(127);

/* ---------------- string and number sanitising ---------------- */

test("str() strips control characters", () => {
  assert.strictEqual(S.str(`a${NUL}b${BEL}c${US}d${DEL}e`, 100), "abcde");
});
test("str() keeps newlines out but leaves ordinary text alone", () => {
  assert.strictEqual(S.str("hello world", 100), "hello world");
  assert.strictEqual(S.str("héllo 😺 ünïcode", 100), "héllo 😺 ünïcode");
});
test("str() truncates to the cap", () => {
  assert.strictEqual(S.str("z".repeat(500), 140).length, 140);
});
test("str() rejects non-strings", () => {
  for (const v of [null, undefined, 42, {}, [], true, () => {}]) {
    assert.strictEqual(S.str(v, 10), "");
  }
});
test("num() only accepts finite numbers", () => {
  assert.strictEqual(S.num(5), 5);
  assert.strictEqual(S.num(-1.5), -1.5);
  for (const v of [NaN, Infinity, -Infinity, "5", null, undefined, {}]) {
    assert.strictEqual(S.num(v), 0);
  }
});

/* ---------------- pet and doodle sanitising ---------------- */

test("cleanPet() forces species and colour onto the whitelist", () => {
  const p = S.cleanPet({ name: "X", species: "dragon", color: "neon" });
  assert.ok(S.SPECIES.includes(p.species));
  assert.ok(S.COLORS.includes(p.color));
});
test("cleanPet() survives hostile input", () => {
  for (const v of [null, undefined, "str", 42, [], { name: {} }]) {
    const p = S.cleanPet(v);
    assert.strictEqual(typeof p.name, "string");
    assert.ok(p.name.length > 0);
  }
});
test("cleanPet() caps the pet name", () => {
  assert.ok(S.cleanPet({ name: "N".repeat(99) }).name.length <= 16);
});

test("cleanStrokes() clamps coordinates into the pad", () => {
  const out = S.cleanStrokes([{ c: 0, p: [-500, -500, 9999, 9999] }]);
  for (const v of out[0].p) assert.ok(Number.isFinite(v) && v >= 0);
  assert.ok(out[0].p[0] >= 0 && out[0].p[1] >= 0);
  assert.ok(out[0].p[2] <= 320 && out[0].p[3] <= 200);
});
test("cleanStrokes() drops NaN and Infinity", () => {
  const out = S.cleanStrokes([{ c: 0, p: [NaN, Infinity, -Infinity, 10] }]);
  for (const s of out) for (const v of s.p) assert.ok(Number.isFinite(v));
});
test("cleanStrokes() caps stroke and point counts", () => {
  const many = Array.from({ length: 5000 }, () => ({ c: 0, p: [1, 1, 2, 2] }));
  assert.ok(S.cleanStrokes(many).length <= 300);
  const long = [{ c: 0, p: Array.from({ length: 50000 }, (_, i) => i % 100) }];
  assert.ok(S.cleanStrokes(long)[0].p.length <= 3000 * 2);
});
test("cleanStrokes() forces the ink index into range", () => {
  for (const c of [-1, 5, 99, NaN, "2", null, 1.5]) {
    const out = S.cleanStrokes([{ c, p: [1, 1, 2, 2] }]);
    assert.ok(out[0].c >= 0 && out[0].c < 5 && Number.isInteger(out[0].c));
  }
});
test("cleanStrokes() rejects non-arrays", () => {
  for (const v of [null, undefined, "x", 42, {}]) assert.deepStrictEqual(S.cleanStrokes(v), []);
});

test("cleanReply() empties a wave", () => {
  const r = S.cleanReply({ wave: true, note: "should vanish", doodle: [{ c: 0, p: [1, 1, 2, 2] }] });
  assert.strictEqual(r.wave, true);
  assert.strictEqual(r.note, "");
  assert.deepStrictEqual(r.doodle, []);
});
test("cleanReply() returns null for junk", () => {
  for (const v of [null, undefined, "x", 42]) assert.strictEqual(S.cleanReply(v), null);
});

test("cleanNote() refuses a note with no id", () => {
  assert.strictEqual(S.Store.prototype.cleanNote.call(null, { note: "x" }), null);
  assert.strictEqual(S.Store.prototype.cleanNote.call(null, null), null);
});
test("cleanNote() forces direction to in or out", () => {
  const n = S.Store.prototype.cleanNote.call(null, { id: "n_1", dir: "sideways" });
  assert.strictEqual(n.dir, "out");
});

/* ---------------- identity ---------------- */

test("deriveId() is deterministic and unique per key", () => {
  const a = C.newKeys(), b = C.newKeys();
  assert.strictEqual(C.deriveId(a.sigPub), C.deriveId(a.sigPub));
  assert.notStrictEqual(C.deriveId(a.sigPub), C.deriveId(b.sigPub));
  assert.match(C.deriveId(a.sigPub), /^p_[0-9a-f]{16}$/);
});
test("an ID cannot be claimed without the matching key", () => {
  const victim = C.newKeys(), attacker = C.newKeys();
  assert.notStrictEqual(C.deriveId(attacker.sigPub), C.deriveId(victim.sigPub));
});

test("sign/verify round trips and rejects tampering", () => {
  const k = C.newKeys();
  const sig = C.sign(k.sigPriv, "hello");
  assert.ok(C.verify(k.sigPub, "hello", sig));
  assert.ok(!C.verify(k.sigPub, "hello!", sig));
  assert.ok(!C.verify(C.newKeys().sigPub, "hello", sig));
  assert.ok(!C.verify(k.sigPub, "hello", "garbage"));
  assert.ok(!C.verify(k.sigPub, "hello", ""));
});

/* ---------------- message keys ---------------- */

test("both sides derive the same message key", () => {
  const a = C.newKeys(), b = C.newKeys();
  const ka = C.messageKey(a.priv, b.pub, a.sigPub, b.sigPub);
  const kb = C.messageKey(b.priv, a.pub, b.sigPub, a.sigPub);
  assert.deepStrictEqual(ka, kb);
  assert.strictEqual(ka.length, 32);
});
test("a third party derives a different key", () => {
  const a = C.newKeys(), b = C.newKeys(), c = C.newKeys();
  const ab = C.messageKey(a.priv, b.pub, a.sigPub, b.sigPub);
  const ac = C.messageKey(a.priv, c.pub, a.sigPub, c.sigPub);
  assert.notDeepStrictEqual(ab, ac);
});

test("seal/unseal round trips with matching AAD", () => {
  const a = C.newKeys(), b = C.newKeys();
  const k = C.messageKey(a.priv, b.pub, a.sigPub, b.sigPub);
  const box = C.seal(k, { hi: "there", n: 5 }, "route-1");
  assert.deepStrictEqual(C.unseal(k, box, "route-1"), { hi: "there", n: 5 });
});
test("unseal fails when the AAD differs", () => {
  const a = C.newKeys(), b = C.newKeys();
  const k = C.messageKey(a.priv, b.pub, a.sigPub, b.sigPub);
  const box = C.seal(k, { x: 1 }, "route-1");
  assert.throws(() => C.unseal(k, box, "route-2"));
});
test("unseal fails on a tampered ciphertext", () => {
  const a = C.newKeys(), b = C.newKeys();
  const k = C.messageKey(a.priv, b.pub, a.sigPub, b.sigPub);
  const box = C.seal(k, { x: 1 }, "r");
  const buf = Buffer.from(box.ct, "base64");
  buf[0] ^= 0xff;
  assert.throws(() => C.unseal(k, { ...box, ct: buf.toString("base64") }, "r"));
});
test("unseal fails with the wrong key", () => {
  const a = C.newKeys(), b = C.newKeys(), c = C.newKeys();
  const k1 = C.messageKey(a.priv, b.pub, a.sigPub, b.sigPub);
  const k2 = C.messageKey(a.priv, c.pub, a.sigPub, c.sigPub);
  assert.throws(() => C.unseal(k2, C.seal(k1, { x: 1 }, "r"), "r"));
});

/* ---------------- safety codes ---------------- */

test("both sides see the same safety code", () => {
  const a = C.newKeys(), b = C.newKeys();
  assert.strictEqual(C.safetyCode(a.sigPub, b.sigPub), C.safetyCode(b.sigPub, a.sigPub));
});
test("a different pair gives a different code", () => {
  const a = C.newKeys(), b = C.newKeys(), c = C.newKeys();
  assert.notStrictEqual(C.safetyCode(a.sigPub, b.sigPub), C.safetyCode(a.sigPub, c.sigPub));
});
test("safety codes are four known words", () => {
  const a = C.newKeys(), b = C.newKeys();
  const parts = C.safetyCode(a.sigPub, b.sigPub).split("-");
  assert.strictEqual(parts.length, 4);
  for (const p of parts) assert.ok(C.WORDS.includes(p), `${p} not in wordlist`);
});
test("the wordlist has no duplicates", () => {
  assert.strictEqual(new Set(C.WORDS).size, C.WORDS.length);
});

/* ---------------- replay guard ---------------- */

test("replay guard accepts once then refuses", () => {
  const g = new C.ReplayGuard();
  const n = C.newNonce();
  assert.ok(g.accept(n, Date.now()));
  assert.ok(!g.accept(n, Date.now()));
});
test("replay guard refuses stale and future timestamps", () => {
  const g = new C.ReplayGuard();
  assert.ok(!g.accept(C.newNonce(), Date.now() - 600000));
  assert.ok(!g.accept(C.newNonce(), Date.now() + 600000));
});
test("replay guard refuses junk nonces", () => {
  const g = new C.ReplayGuard();
  for (const v of ["", "short", null, undefined, 42]) {
    assert.ok(!g.accept(v, Date.now()));
  }
});

/* ---------------- store persistence ---------------- */

test("a fresh identity has an ID matching its signing key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-unit-"));
  try {
    const st = new S.Store(dir);
    assert.strictEqual(st.identity.id, C.deriveId(st.identity.sigPub));
    assert.ok(st.identity.sigPriv && st.identity.priv);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an identity file whose ID does not match its key is discarded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-unit-"));
  try {
    const st = new S.Store(dir);
    st.setProfile("Robin", { name: "Biscuit" });
    const original = st.identity.id;

    const file = path.join(dir, "identity.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.id = "p_ffffffffffffffff";           // tamper: claim a different ID
    fs.writeFileSync(file, JSON.stringify(raw));

    const reopened = new S.Store(dir);
    assert.notStrictEqual(reopened.identity.id, "p_ffffffffffffffff");
    assert.notStrictEqual(reopened.identity.id, original);
    assert.strictEqual(reopened.identity.id, C.deriveId(reopened.identity.sigPub));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pinned peer keys are enforced, and forgetting clears the pin", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-unit-"));
  try {
    const st = new S.Store(dir);
    const friend = C.newKeys();
    const impostor = C.newKeys();
    const id = C.deriveId(friend.sigPub);

    assert.strictEqual(st.notePeerKey(id, friend.pub, friend.sigPub), "new");
    assert.strictEqual(st.notePeerKey(id, friend.pub, friend.sigPub), "known");
    assert.strictEqual(st.notePeerKey(id, impostor.pub, impostor.sigPub), "changed");
    // A refused key must not overwrite the pin.
    assert.strictEqual(st.notePeerKey(id, friend.pub, friend.sigPub), "known");

    assert.ok(!st.isVerified(id));
    st.markVerified(id);
    assert.ok(st.isVerified(id));

    st.forgetPeer(id);
    assert.strictEqual(st.notePeerKey(id, impostor.pub, impostor.sigPub), "new");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- identity sealed at rest ---------------- */

/** A stand-in for the OS keystore, with the same shape Electron's safeStorage has. */
function fakeKeystore() {
  const key = require("crypto").randomBytes(32);
  return {
    encrypt: (text) => {
      const iv = require("crypto").randomBytes(12);
      const c = require("crypto").createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]);
    },
    decrypt: (buf) => {
      const d = require("crypto").createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
    },
  };
}

test("with a keystore, identity.json holds no readable key material", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  try {
    const st = new S.Store(dir, fakeKeystore());
    st.setProfile("Robin", { name: "Biscuit" });
    const onDisk = fs.readFileSync(path.join(dir, "identity.json"), "utf8");

    assert.ok(!onDisk.includes(st.identity.sigPriv), "signing key must not be on disk in the clear");
    assert.ok(!onDisk.includes(st.identity.priv), "exchange key must not be on disk in the clear");
    assert.ok(!onDisk.includes("Robin"), "even the name should be inside the sealed blob");
    assert.match(onDisk, /"sealed"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a sealed identity reopens with the same keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  const ks = fakeKeystore();
  try {
    const a = new S.Store(dir, ks);
    a.setProfile("Robin", { name: "Biscuit" });
    const b = new S.Store(dir, ks);
    assert.strictEqual(b.identity.id, a.identity.id);
    assert.strictEqual(b.identity.sigPriv, a.identity.sigPriv);
    assert.strictEqual(b.identity.name, "Robin");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a sealed identity is useless to another computer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  try {
    const a = new S.Store(dir, fakeKeystore());
    a.setProfile("Robin", { name: "Biscuit" });
    // A thief copies the file but cannot reproduce this machine's keystore.
    const thief = new S.Store(dir, fakeKeystore());
    assert.notStrictEqual(thief.identity.sigPriv, a.identity.sigPriv,
      "a different keystore must not recover the keys");
    assert.notStrictEqual(thief.identity.id, a.identity.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an existing plain identity still opens, then seals on next write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  const ks = fakeKeystore();
  try {
    const plain = new S.Store(dir);                 // no keystore: written in the clear
    plain.setProfile("Robin", { name: "Biscuit" });
    const before = fs.readFileSync(path.join(dir, "identity.json"), "utf8");
    assert.ok(before.includes(plain.identity.sigPriv), "precondition: it really is plain");

    const upgraded = new S.Store(dir, ks);          // same machine, keystore now present
    assert.strictEqual(upgraded.identity.id, plain.identity.id, "identity must survive the upgrade");
    upgraded.saveIdentityNow();
    const after = fs.readFileSync(path.join(dir, "identity.json"), "utf8");
    assert.ok(!after.includes(plain.identity.sigPriv), "it must be sealed after the next write");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("without a keystore the app still works, just unsealed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  try {
    const st = new S.Store(dir, null);
    st.setProfile("Robin", { name: "Biscuit" });
    const again = new S.Store(dir, null);
    assert.strictEqual(again.identity.id, st.identity.id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("notes are sealed at rest too, and survive a reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  const ks = fakeKeystore();
  try {
    const a = new S.Store(dir, ks);
    a.setProfile("Robin", { name: "Biscuit" });
    a.put(a.cleanNote({
      id: "n_secret", dir: "in", status: "read", peerId: "p_1111111111111111",
      peerName: "Priya", note: "the spare key is under the mat", createdAt: Date.now(),
    }));
    a.saveNow();

    const onDisk = fs.readFileSync(path.join(dir, "notes.json"), "utf8");
    assert.ok(!onDisk.includes("spare key"), "note text must not be readable on disk");
    assert.match(onDisk, /"sealed"/);

    const b = new S.Store(dir, ks);
    assert.strictEqual(b.get("n_secret").note, "the spare key is under the mat");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("existing plain notes still load after sealing is introduced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  try {
    const plain = new S.Store(dir);
    plain.put(plain.cleanNote({ id: "n_old", dir: "in", status: "read",
      peerId: "p_1111111111111111", peerName: "Priya", note: "hello", createdAt: Date.now() }));
    plain.saveNow();

    const upgraded = new S.Store(dir, fakeKeystore());
    assert.strictEqual(upgraded.get("n_old").note, "hello", "old notes must not be lost");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unreadable notes do not stop the app starting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-seal-"));
  try {
    const a = new S.Store(dir, fakeKeystore());
    a.put(a.cleanNote({ id: "n_x", dir: "in", status: "read", peerId: "p_1",
      peerName: "P", note: "hi", createdAt: Date.now() }));
    a.saveNow();
    // A different keystore cannot open them; the app must still come up.
    const b = new S.Store(dir, fakeKeystore());
    assert.strictEqual(b.list().length, 0, "unreadable notes yield an empty mailbag");
    assert.ok(b.identity.id, "and a usable identity");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
