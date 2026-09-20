"use strict";
/* Spins up real Net peers on this machine: real UDP multicast, real HTTP sockets. */
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP = path.join(__dirname, "..", "app");
const { Store } = require(path.join(APP, "store.js"));
const { Net } = require(path.join(APP, "net.js"));

const tmps = [];
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `penpal-${tag}-`));
  tmps.push(d);
  return d;
}

function makePeer(name, petName, species = "cat", color = "honey") {
  const dir = tmpdir(name.toLowerCase());
  const store = new Store(dir);
  store.setProfile(name, { name: petName, species, color });
  const net = new Net(store);
  const events = [];
  net.on("event", (ev) => events.push(ev));
  net.start();
  return { name, dir, store, net, events, id: store.identity.id };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until fn() is truthy, or throw after timeout. */
async function until(label, fn, timeoutMs = 15000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(stepMs);
  }
}

/** Mirrors what main.js actions.send does, so we exercise the real path. */
function compose(from, toPeerId, text, doodle = []) {
  const crypto = require("crypto");
  const self = toPeerId === from.store.identity.id;
  const peer = self
    ? { id: from.store.identity.id, name: from.store.identity.name, pet: from.store.identity.pet }
    : from.net.peers.get(toPeerId);
  if (!peer) throw new Error(`${from.name} does not know peer ${toPeerId}`);
  const n = from.store.cleanNote({
    id: "n_" + crypto.randomBytes(10).toString("hex"),
    dir: "out", status: "waiting",
    peerId: peer.id, peerName: peer.name, peerPet: peer.pet,
    note: text, doodle, createdAt: Date.now(),
  });
  from.store.put(n);
  return n;
}

function teardown(...peers) {
  for (const p of peers) { try { p.net.stop(); } catch {} }
  for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

module.exports = { makePeer, compose, until, sleep, teardown, APP };
