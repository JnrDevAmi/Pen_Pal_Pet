"use strict";
/*
 * The one door the sandboxed page has into privileged code. Everything here
 * arrives from the renderer and is treated as hostile.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP = path.join(__dirname, "..", "app");
const { Store } = require(path.join(APP, "store.js"));
const { Net } = require(path.join(APP, "net.js"));
const { makeActions, dispatch, cleanId } = require(path.join(APP, "actions.js"));

// Built rather than typed: a literal NUL in source makes tools treat the file
// as binary and is easily mangled in transit.
const NUL = String.fromCharCode(0);

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penpal-ipc-"));
  const store = new Store(dir);
  store.setProfile("Robin", { name: "Biscuit", species: "cat", color: "honey" });
  const net = new Net(store);            // not started: no sockets needed
  let changes = 0;
  const actions = makeActions({ store, net, onChanged: () => { changes++; } });
  return {
    store, net, actions, dir,
    changes: () => changes,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/* ---------------- the dispatcher itself ---------------- */

test("an unknown action is refused", async () => {
  const r = rig();
  try {
    for (const name of ["nope", "", null, undefined, 42, {}]) {
      const res = await dispatch(r.actions, { action: name });
      assert.strictEqual(res.ok, false, `action ${String(name)} should be refused`);
    }
  } finally { r.cleanup(); }
});

test("inherited properties cannot be invoked as actions", async () => {
  const r = rig();
  try {
    // These exist on Object.prototype / Function.prototype but are not actions.
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__",
      "valueOf", "call", "apply", "bind"]) {
      const res = await dispatch(r.actions, { action: name });
      assert.strictEqual(res.ok, false, `${name} must not be callable`);
      assert.strictEqual(res.error, "Unknown action.");
    }
  } finally { r.cleanup(); }
});

test("a malformed message never throws", async () => {
  const r = rig();
  try {
    for (const msg of [null, undefined, 42, "send", [], { action: "send" },
      { action: "send", payload: null }, { action: "send", payload: "x" }]) {
      const res = await dispatch(r.actions, msg);
      assert.ok(res && typeof res.ok === "boolean");
    }
  } finally { r.cleanup(); }
});

test("an action that throws is reported, not leaked", async () => {
  const r = rig();
  try {
    const boom = makeActions({
      store: r.store,
      net: { beacon() { throw new Error("secret internal detail /etc/passwd"); } },
    });
    const res = await dispatch(boom, { action: "setProfile", payload: { name: "x", pet: {} } });
    assert.strictEqual(res.ok, false);
    assert.ok(!/passwd/.test(res.error), "internal detail must not reach the page");
  } finally { r.cleanup(); }
});

/* ---------------- id handling ---------------- */

test("cleanId strips anything we never issue", () => {
  assert.strictEqual(cleanId("n_abc123"), "n_abc123");
  assert.strictEqual(cleanId("n_abc:in"), "n_abc:in");
  assert.strictEqual(cleanId("../../etc/passwd"), "etcpasswd");
  assert.strictEqual(cleanId("a" + NUL + "b"), "ab");
  assert.strictEqual(cleanId("<script>"), "script");
  assert.strictEqual(cleanId("x".repeat(500)).length, 48);
  for (const v of [null, undefined, 42, {}, []]) assert.strictEqual(cleanId(v), "");
});

test("actions taking an id tolerate junk", async () => {
  const r = rig();
  try {
    const junk = [null, undefined, 42, {}, [], "../../x", NUL, "z".repeat(999)];
    for (const id of junk) {
      for (const action of ["depart", "open", "recall", "takeBack", "readReply",
        "remove", "verifyFriend", "forgetFriend"]) {
        const res = await dispatch(r.actions, { action, payload: { id } });
        assert.ok(res && typeof res.ok === "boolean", `${action} broke on ${String(id)}`);
      }
    }
  } finally { r.cleanup(); }
});

/* ---------------- send ---------------- */

test("send refuses an unknown recipient", async () => {
  const r = rig();
  try {
    const res = await dispatch(r.actions, {
      action: "send", payload: { to: "p_ffffffffffffffff", note: "hi" },
    });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(r.store.list().length, 0, "nothing should be stored");
  } finally { r.cleanup(); }
});

test("send to yourself is allowed and sanitised", async () => {
  const r = rig();
  try {
    const res = await dispatch(r.actions, {
      action: "send",
      payload: {
        to: r.store.identity.id,
        note: "z".repeat(5000),
        doodle: Array.from({ length: 900 }, () => ({ c: 99, p: [NaN, 1e9] })),
      },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.note.note.length, 140, "note text must be capped");
    assert.ok(res.note.doodle.length <= 300, "doodle must be capped");
    for (const s of res.note.doodle) {
      for (const v of s.p) assert.ok(Number.isFinite(v) && v >= 0);
    }
  } finally { r.cleanup(); }
});

test("a note cannot be forged into another status or direction", async () => {
  const r = rig();
  try {
    const res = await dispatch(r.actions, {
      action: "send",
      payload: {
        to: r.store.identity.id, note: "hi",
        // all of these are attacker-controlled and must be ignored
        id: "n_attacker", dir: "in", status: "home", peerId: "p_someone_else",
        peerName: "Priya", reply: { wave: true }, deliveredAt: 1, arriveAt: 1,
      },
    });
    assert.strictEqual(res.ok, true);
    assert.notStrictEqual(res.note.id, "n_attacker", "id must be issued by us");
    assert.strictEqual(res.note.dir, "out");
    assert.strictEqual(res.note.status, "waiting");
    assert.strictEqual(res.note.peerId, r.store.identity.id);
    assert.strictEqual(res.note.reply, null);
  } finally { r.cleanup(); }
});

/* ---------------- state leaving the main process ---------------- */

const SECRET_KEYS = ["priv", "sigPriv", "peerKeys"];

function findSecret(value, seen = new Set(), trail = "") {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.includes(k)) return `${trail}.${k}`;
    const hit = findSecret(v, seen, `${trail}.${k}`);
    if (hit) return hit;
  }
  return null;
}

test("the snapshot sent to the page carries no private key material", () => {
  const r = rig();
  try {
    const snap = r.net.snapshot();
    const leak = findSecret(snap);
    assert.strictEqual(leak, null, `snapshot leaked ${leak}`);

    // and the raw secrets really are absent, not merely renamed
    const text = JSON.stringify(snap);
    assert.ok(!text.includes(r.store.identity.priv), "x25519 private key leaked");
    assert.ok(!text.includes(r.store.identity.sigPriv), "ed25519 signing key leaked");
  } finally { r.cleanup(); }
});

test("a note returned to the page carries no key material", async () => {
  const r = rig();
  try {
    const res = await dispatch(r.actions, {
      action: "send", payload: { to: r.store.identity.id, note: "hi" },
    });
    assert.strictEqual(findSecret(res.note), null);
    const text = JSON.stringify(res.note);
    assert.ok(!text.includes(r.store.identity.sigPriv));
  } finally { r.cleanup(); }
});

test("the snapshot exposes safety codes but not the keys behind them", () => {
  const r = rig();
  try {
    const snap = r.net.snapshot();
    assert.ok(snap.me && snap.me.id && snap.me.pet, "the page still gets what it needs");
    assert.strictEqual(snap.me.priv, undefined);
    assert.strictEqual(snap.me.sigPriv, undefined);
    assert.ok(Array.isArray(snap.peers));
    assert.ok(Array.isArray(snap.notes));
  } finally { r.cleanup(); }
});

/* ---------------- state changes are announced ---------------- */

test("a successful action notifies the app, a refused one does not", async () => {
  const r = rig();
  try {
    const before = r.changes();
    await dispatch(r.actions, { action: "send", payload: { to: "p_nobody", note: "x" } });
    assert.strictEqual(r.changes(), before, "a refusal must not claim a change");

    await dispatch(r.actions, { action: "send", payload: { to: r.store.identity.id, note: "x" } });
    assert.ok(r.changes() > before, "a real send must notify");
  } finally { r.cleanup(); }
});
