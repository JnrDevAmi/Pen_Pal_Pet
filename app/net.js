"use strict";
/*
 * Finding friends and handing notes over, with no server in the middle.
 *
 * Every app shouts a short "I'm here" beacon on the local network a few times a
 * minute (UDP multicast, plus a plain broadcast for networks that block it), and
 * listens for everyone else's. That gives each app a live list of who is nearby.
 *
 * A note is delivered straight to the friend's computer over HTTP on the port
 * they advertised. The contents are encrypted with a key the two computers agree
 * on from their beacon keys, so anyone sniffing the Wi-Fi sees nothing readable.
 * If the friend's computer is asleep, the note simply waits in the satchel and
 * goes out as soon as they show up again.
 */
const dgram = require("dgram");
const http = require("http");
const os = require("os");
const { EventEmitter } = require("events");
const { cleanPet, cleanStrokes, cleanReply, str, num, NOTE_MAX } = require("./store");
const {
  PROTOCOL, deriveId, sign, verify, messageKey, seal, unseal, ReplayGuard, newNonce, safetyCode,
} = require("./crypto");

const DISCOVERY_PORT = 41234;
const MULTICAST = "239.255.41.17";
const BEACON_MS = 3000;
const PEER_TTL = 12000;
const TRAVEL_MS = 8000;      // how long a pet takes to walk from one desktop to the other
const RETRY_MS = 4000;
const MAX_BODY = 500 * 1024;

const nowMs = () => Date.now();

/* ---------- network helpers ---------- */
// Enumerating interfaces is a syscall, and this is consulted for every beacon
// and every request. Cache it briefly; addresses do not change by the second.
let subnetCache = null;
let subnetCachedAt = 0;
const SUBNET_TTL_MS = 5000;

function localSubnets() {
  const t = nowMs();
  if (subnetCache && t - subnetCachedAt < SUBNET_TTL_MS) return subnetCache;
  const nets = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== "IPv4") continue;
      const ip = ni.address.split(".").map(Number);
      const mask = (ni.netmask || "255.255.255.0").split(".").map(Number);
      nets.push({ ip, mask, internal: ni.internal });
    }
  }
  subnetCache = nets;
  subnetCachedAt = t;
  return nets;
}
function broadcastTargets() {
  const out = new Set();
  for (const { ip, mask, internal } of localSubnets()) {
    if (internal) continue;
    out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join("."));
  }
  // Only fall back to the global broadcast address when no interface gave us a
  // usable subnet one; sending both just doubles the traffic for no gain.
  if (!out.size) out.add("255.255.255.255");
  return [...out];
}
/**
 * True only for addresses on a network this machine is actually attached to.
 * The note listener refuses everything else, so a port forwarded in from the
 * internet finds nothing to talk to.
 */
function isLocalAddress(addr) {
  const a = String(addr || "").replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  const parts = a.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  for (const { ip, mask } of localSubnets()) {
    if (parts.every((o, i) => (o & mask[i]) === (ip[i] & mask[i]))) return true;
  }
  return false;
}

class Net extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.peers = new Map();     // id -> {id, name, pet, ip, port, pub, sigPub, lastSeen}
    this.port = 0;
    this.server = null;
    this.sock = null;
    this.timers = [];
    this.replay = new ReplayGuard();
    this.impostors = new Map(); // id -> lastWarnedAt, so we warn once not every 3s
  }

  /** The key material we use to talk to a given peer, or null if unusable. */
  keyFor(peer) {
    if (!peer || !peer.pub || !peer.sigPub) return null;
    const me = this.store.identity;
    return messageKey(me.priv, peer.pub, me.sigPub, peer.sigPub);
  }

  /* ---------- lifecycle ---------- */
  start() {
    this.startServer();
    this.startDiscovery();
    this.timers.push(setInterval(() => this.tick(), 1500));
  }
  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.beaconTimer);
    this.beaconTimer = null;
    try { this.sock && this.sock.close(); } catch {}
    try { this.server && this.server.close(); } catch {}
  }

  /* ---------- incoming notes ---------- */
  startServer() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("error", (err) => {
      console.error("Note server error:", err.message);
      this.emit("event", { kind: "error", message: "This computer couldn’t open a port to receive notes." });
    });
    // A note is a few hundred bytes handed over in one shot. Anything that
    // dawdles, floods or holds connections open is not a friend.
    this.server.maxConnections = 64;
    this.server.headersTimeout = 5000;
    this.server.requestTimeout = 10000;
    this.server.keepAliveTimeout = 2000;
    this.server.timeout = 15000;
    this.server.listen(0, "0.0.0.0", () => {
      this.port = this.server.address().port;
      this.beacon();
    });
  }

  reply(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body || {}));
  }

  /**
   * Two bindings, deliberately separate:
   *   aad()        travels inside the AES-GCM tag, so decryption itself fails if
   *                the envelope is replayed at a different route or moment.
   *   transcript() is what gets signed, and additionally covers the ciphertext,
   *                so the bytes cannot be swapped for another peer's.
   */
  static aad(from, to, path, ts, nonce) {
    return ["penpal-pet/v2", from, to, path, ts, nonce].join("|");
  }
  static transcript(from, to, path, ts, nonce, box) {
    return [Net.aad(from, to, path, ts, nonce), box.iv, box.ct, box.tag].join("|");
  }

  handle(req, res) {
    // Nothing off this machine's own networks is allowed to talk to us at all.
    if (!isLocalAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      req.destroy();
      return;
    }
    if (req.method === "GET" && req.url === "/hello") {
      return this.reply(res, 200, { app: "penpal-pet", v: PROTOCOL });
    }
    if (req.method !== "POST") return this.reply(res, 404, { error: "not found" });
    if (!["/note", "/reply", "/opened", "/recall"].includes(req.url)) {
      return this.reply(res, 404, { error: "not found" });
    }

    let body = "";
    let killed = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY && !killed) { killed = true; req.destroy(); }
    });
    req.on("end", () => {
      if (killed) return;
      let msg;
      try { msg = JSON.parse(body); } catch { return this.reply(res, 400, { error: "bad json" }); }
      if (!msg || typeof msg !== "object" || !msg.box || typeof msg.box !== "object") {
        return this.reply(res, 400, { error: "bad envelope" });
      }

      const from = str(msg.from, 40);
      const peer = this.peers.get(from);
      // Only a peer whose signed beacon we have accepted may send us anything.
      if (!peer) return this.reply(res, 409, { error: "unknown sender" });
      // The sender's own beacon IP must match where this connection came from.
      if (peer.ip !== String(req.socket.remoteAddress || "").replace(/^::ffff:/, "")) {
        return this.reply(res, 409, { error: "unknown sender" });
      }
      if (!this.replay.accept(msg.nonce, msg.ts)) {
        return this.reply(res, 409, { error: "stale or repeated" });
      }

      const me = this.store.identity;
      // The envelope must also be addressed to us, not merely aimed at our port.
      if (str(msg.to, 40) !== me.id) return this.reply(res, 409, { error: "not for me" });
      // A signed message is stronger proof of life than a beacon, so it keeps
      // the peer fresh. Without this a busy machine can drop a friend from the
      // list in the middle of a conversation with them.
      peer.lastSeen = nowMs();
      if (!verify(peer.sigPub, Net.transcript(from, me.id, req.url, msg.ts, msg.nonce, msg.box), msg.sig)) {
        return this.reply(res, 401, { error: "bad signature" });
      }

      let inner;
      try {
        inner = unseal(this.keyFor(peer), msg.box, Net.aad(from, me.id, req.url, msg.ts, msg.nonce));
      } catch {
        return this.reply(res, 400, { error: "could not open" });
      }
      if (!inner || typeof inner !== "object") return this.reply(res, 400, { error: "bad contents" });

      try {
        if (req.url === "/note") return this.onNote(peer, inner, res);
        if (req.url === "/reply") return this.onReply(peer, inner, res);
        if (req.url === "/opened") return this.onOpened(peer, inner, res);
        if (req.url === "/recall") return this.onRecall(peer, inner, res);
      } catch (err) {
        console.error(err);
        return this.reply(res, 500, { error: "problem" });
      }
      this.reply(res, 404, { error: "not found" });
    });
  }

  onNote(peer, inner, res) {
    const id = str(inner.noteId, 48);
    if (!id) return this.reply(res, 400, { error: "bad note" });
    if (!this.store.identity.acceptAnyone) {
      const known = this.store.list().some((n) => n.peerId === peer.id);
      if (!known) return this.reply(res, 403, { error: "not accepting notes" });
    }
    const existing = this.store.get(id);
    if (existing) return this.reply(res, 200, { ok: true, duplicate: true });
    const t = nowMs();
    const note = this.store.cleanNote({
      id, dir: "in", status: "incoming",
      peerId: peer.id, peerName: peer.name, peerPet: peer.pet,
      note: str(inner.note, NOTE_MAX), doodle: cleanStrokes(inner.doodle),
      createdAt: num(inner.sentAt) || t, sentAt: num(inner.sentAt) || t,
      deliveredAt: t, arriveAt: t + TRAVEL_MS,
    });
    this.store.put(note);
    this.changed();
    this.reply(res, 200, { ok: true });
  }

  onReply(peer, inner, res) {
    const note = this.store.get(str(inner.noteId, 48));
    if (!note || note.dir !== "out" || note.peerId !== peer.id) return this.reply(res, 404, { error: "no such note" });
    if (note.reply) return this.reply(res, 200, { ok: true, duplicate: true });
    const t = nowMs();
    note.reply = cleanReply(inner.reply);
    note.status = "replied";
    note.repliedAt = num(inner.repliedAt) || t;
    note.returnAt = t + TRAVEL_MS;
    this.store.put(note);
    this.changed();
    this.reply(res, 200, { ok: true });
  }

  onOpened(peer, inner, res) {
    const note = this.store.get(str(inner.noteId, 48));
    if (note && note.dir === "out" && note.peerId === peer.id && note.status === "delivered") {
      note.status = "reading";
      note.openedAt = nowMs();
      this.store.put(note);
      this.changed();
    }
    this.reply(res, 200, { ok: true });
  }

  onRecall(peer, inner, res) {
    const note = this.store.get(str(inner.noteId, 48));
    if (note && note.dir === "in" && note.peerId === peer.id && !note.reply) {
      note.status = "recalled";
      note.recalledAt = nowMs();
      this.store.put(note);
      this.changed();
    }
    this.reply(res, 200, { ok: true });
  }

  /* ---------- discovery ---------- */
  startDiscovery() {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sock = sock;
    sock.on("error", (err) => {
      console.error("Discovery error:", err.message);
      this.emit("event", { kind: "error", message: "Couldn’t listen for friends on this network." });
      try { sock.close(); } catch {}
    });
    sock.on("message", (buf, rinfo) => this.onBeacon(buf, rinfo));
    sock.bind(DISCOVERY_PORT, () => {
      try { sock.setBroadcast(true); } catch {}
      try { sock.setMulticastTTL(1); } catch {}
      try { sock.setMulticastLoopback(true); } catch {}
      // A busy room can deliver a lot of beacons at once; a roomy receive
      // buffer is the difference between seeing everyone and seeing half.
      try { sock.setRecvBufferSize(1024 * 1024); } catch {}
      try { sock.addMembership(MULTICAST); } catch (err) { console.warn("Multicast unavailable:", err.message); }
      this.beacon();
      this.scheduleBeacon();
    });
  }

  /**
   * Beacons are spread out rather than fired on a shared tick. Without the
   * jitter every app in the room announces itself at the same instant and the
   * resulting burst is what gets dropped.
   */
  scheduleBeacon() {
    clearTimeout(this.beaconTimer);
    const wait = BEACON_MS * (0.75 + Math.random() * 0.5);
    this.beaconTimer = setTimeout(() => { this.beacon(); this.scheduleBeacon(); }, wait);
  }

  beacon() {
    if (!this.sock || !this.port) return;
    const me = this.store.identity;
    if (!me.ready) return; // don't announce until the pet has a name
    const body = JSON.stringify({
      id: me.id, name: me.name, pet: me.pet, port: this.port,
      pub: me.pub, sigPub: me.sigPub, ts: Date.now(), nonce: newNonce(),
    });
    const payload = Buffer.from(JSON.stringify({
      v: PROTOCOL, t: "hi", b: Buffer.from(body, "utf8").toString("base64"), sig: sign(me.sigPriv, body),
    }));
    for (const addr of [MULTICAST, ...broadcastTargets()]) {
      try { this.sock.send(payload, DISCOVERY_PORT, addr, () => {}); } catch {}
    }
  }

  onBeacon(buf, rinfo) {
    if (!isLocalAddress(rinfo.address)) return;
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || m.v !== PROTOCOL || m.t !== "hi" || typeof m.b !== "string") return;

    let body, raw;
    try {
      raw = Buffer.from(m.b, "base64").toString("utf8");
      body = JSON.parse(raw);
    } catch { return; }
    if (!body || typeof body !== "object") return;

    const sigPub = String(body.sigPub || "");
    const pub = String(body.pub || "");
    const port = Number(body.port);
    const id = str(body.id, 40);
    if (!sigPub || !pub || !id) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (id === this.store.identity.id) return;

    // Order matters here, cheapest first. Each beacon reaches us twice (once by
    // multicast, once by broadcast), so dropping the duplicate before the
    // signature check halves the verification work on a busy network.
    //
    // 1. The ID must be the fingerprint of the signing key it arrived with.
    //    This is what makes claiming someone else's identity impossible, and it
    //    is a single hash.
    if (id !== deriveId(sigPub)) return;
    // 2. Fresh, and not a copy we already handled. Scoped to the claimed ID, so
    //    nobody can burn a nonce on another peer's behalf.
    if (!this.replay.accept(id + "|" + body.nonce, body.ts)) return;
    // 3. Only now the expensive part: the beacon must be signed by that key.
    if (!verify(sigPub, raw, m.sig)) return;

    // 4. If we already pinned this friend's keys, they may not change silently.
    const keyState = this.store.notePeerKey(id, pub, sigPub);
    if (keyState === "changed") {
      const last = this.impostors.get(id) || 0;
      if (nowMs() - last > 60000) {
        this.impostors.set(id, nowMs());
        const pinned = this.store.peerKeys[id];
        this.emit("event", {
          kind: "impostor", id,
          name: str(body.name, 40) || "Someone",
          wasVerified: !!(pinned && pinned.verified),
        });
      }
      return;   // refuse outright: do not route anything to this address
    }

    const known = this.peers.get(id);
    const peer = {
      id,
      name: str(body.name, 40) || "A friend",
      pet: cleanPet(body.pet),
      ip: rinfo.address,
      port, pub, sigPub,
      verified: this.store.isVerified(id),
      // Derived once per peer, not once per beacon: the keys cannot change
      // without the pin check above rejecting the beacon outright.
      safety: known && known.sigPub === sigPub ? known.safety : safetyCode(this.store.identity.sigPub, sigPub),
      lastSeen: nowMs(),
      firstSeen: known ? known.firstSeen : nowMs(),
    };
    this.peers.set(id, peer);

    if (!known) {
      this.emit("event", {
        kind: "peerOnline", name: peer.name, petName: peer.pet.name,
        id, safety: peer.safety, verified: peer.verified,
      });
      this.changed();
      this.tick();
    } else if (known.name !== peer.name || known.pet.name !== peer.pet.name
      || known.pet.species !== peer.pet.species || known.pet.color !== peer.pet.color) {
      this.changed();
    }
  }

  onlinePeers() {
    const t = nowMs();
    const out = [];
    for (const [id, p] of this.peers) {
      if (t - p.lastSeen > PEER_TTL) { this.peers.delete(id); this.changed(); continue; }
      out.push(p);
    }
    return out;
  }
  isOnline(id) {
    const p = this.peers.get(id);
    return !!p && nowMs() - p.lastSeen <= PEER_TTL;
  }

  /* ---------- sending ---------- */
  post(peer, path, inner) {
    return new Promise((resolve) => {
      let body;
      try {
        const me = this.store.identity;
        const ts = nowMs();
        const nonce = newNonce();
        // Seal first with a placeholder-free transcript: the AAD and the
        // signature both cover the ciphertext, so neither can be swapped.
        const key = this.keyFor(peer);
        if (!key) return resolve({ ok: false, error: "no key for peer" });
        const box = seal(key, inner, Net.aad(me.id, peer.id, path, ts, nonce));
        body = JSON.stringify({
          from: me.id, to: peer.id, ts, nonce, box,
          sig: sign(me.sigPriv, Net.transcript(me.id, peer.id, path, ts, nonce, box)),
        });
      } catch { return resolve({ ok: false, error: "could not encrypt" }); }
      const req = http.request({
        host: peer.ip, port: peer.port, path, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 6000,
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(data || "{}"); } catch {}
          // They answered, so they are demonstrably still there.
          const live = this.peers.get(peer.id);
          if (live) live.lastSeen = nowMs();
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: parsed });
        });
      });
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.end(body);
    });
  }

  /** Called by the pet layer once the pet has walked off the screen with a note. */
  async depart(noteId) {
    const note = this.store.get(noteId);
    if (!note || note.dir !== "out" || note.status !== "waiting") return { ok: false };
    note.status = "travelling";
    note.sentAt = nowMs();
    note.attempts = 0;
    this.store.put(note);
    this.changed();
    return this.tryDeliver(note);
  }

  /** A note addressed to yourself: hand it over locally so you can watch the whole trip. */
  selfDeliver(note) {
    const t = nowMs();
    const me = this.store.identity;
    note.status = "delivered";
    note.deliveredAt = t;
    this.store.put(note);
    const copy = this.store.cleanNote({
      id: note.id + ":in", dir: "in", status: "incoming",
      peerId: me.id, peerName: me.name, peerPet: me.pet,
      note: note.note, doodle: note.doodle,
      createdAt: t, sentAt: note.sentAt, deliveredAt: t, arriveAt: t + TRAVEL_MS,
    });
    this.store.put(copy);
    this.changed();
    return { ok: true };
  }

  async tryDeliver(note) {
    if (note.peerId === this.store.identity.id) return this.selfDeliver(note);
    const peer = this.peers.get(note.peerId);
    if (!peer || !this.isOnline(note.peerId)) return this.deliveryFailed(note);
    note.attempts = (note.attempts || 0) + 1;
    const res = await this.post(peer, "/note", {
      noteId: note.id, note: note.note, doodle: note.doodle, sentAt: note.sentAt,
    });
    if (res.ok) {
      note.status = "delivered";
      note.deliveredAt = nowMs();
      note.peerName = peer.name;
      note.peerPet = peer.pet;
      this.store.put(note);
      this.changed();
      return { ok: true };
    }
    if (res.status === 403) {
      this.emit("event", { kind: "refused", name: peer.name });
      return this.deliveryFailed(note, true);
    }
    if (note.attempts >= 4) return this.deliveryFailed(note);
    return { ok: false, retry: true };
  }

  deliveryFailed(note, refused = false) {
    note.status = "waiting";
    note.attempts = 0;
    this.store.put(note);
    this.emit("event", { kind: "deliveryFailed", name: note.peerName, refused, noteId: note.id });
    this.changed();
    return { ok: false };
  }

  async sendReply(noteId, reply) {
    const note = this.store.get(noteId);
    if (!note || note.dir !== "in") return { ok: false, error: "That note is gone." };
    if (note.reply) return { ok: false, error: "You already replied to this note." };
    const t = nowMs();
    note.reply = cleanReply(reply);
    note.status = "replied";
    note.repliedAt = t;
    note.replyPending = note.peerId !== this.store.identity.id;
    this.store.put(note);
    if (note.peerId === this.store.identity.id) {
      const out = this.store.get(note.id.replace(/:in$/, ""));
      if (out) {
        out.reply = note.reply;
        out.status = "replied";
        out.repliedAt = t;
        out.returnAt = t + TRAVEL_MS;
        this.store.put(out);
      }
    }
    this.changed();
    this.pushReply(note);
    return { ok: true };
  }

  async pushReply(note) {
    if (note.peerId === this.store.identity.id) return;
    const peer = this.peers.get(note.peerId);
    if (!peer || !this.isOnline(note.peerId)) return;
    const res = await this.post(peer, "/reply", { noteId: note.id, reply: note.reply, repliedAt: note.repliedAt });
    if (res.ok) {
      note.replyPending = false;
      this.store.put(note);
      this.changed();
    }
  }

  async markOpened(noteId) {
    const note = this.store.get(noteId);
    if (!note || note.dir !== "in") return { ok: false };
    if (note.status === "incoming" || note.status === "arrived") {
      note.status = "read";
      note.readAt = nowMs();
      this.store.put(note);
      this.changed();
    }
    if (note.peerId === this.store.identity.id) {
      const out = this.store.get(note.id.replace(/:in$/, ""));
      if (out && out.status === "delivered") { out.status = "reading"; out.openedAt = nowMs(); this.store.put(out); this.changed(); }
      return { ok: true };
    }
    const peer = this.peers.get(note.peerId);
    if (peer && this.isOnline(note.peerId)) this.post(peer, "/opened", { noteId: note.id });
    return { ok: true };
  }

  async recall(noteId) {
    const note = this.store.get(noteId);
    if (!note || note.dir !== "out") return { ok: false };
    if (!["travelling", "delivered", "reading"].includes(note.status)) return { ok: false, error: "Your pet isn’t out with this note." };
    note.status = "recalled";
    note.recalledAt = nowMs();
    note.returnAt = nowMs() + TRAVEL_MS;
    this.store.put(note);
    const local = this.store.get(note.id + ":in");
    if (local && !local.reply) { local.status = "recalled"; local.recalledAt = nowMs(); this.store.put(local); }
    this.changed();
    const peer = this.peers.get(note.peerId);
    if (peer && this.isOnline(note.peerId)) this.post(peer, "/recall", { noteId: note.id });
    return { ok: true };
  }

  /* ---------- the ticking clock ---------- */
  tick() {
    const t = nowMs();
    this.onlinePeers();
    let changed = false;
    for (const note of this.store.list()) {
      if (note.dir === "in" && note.status === "incoming" && t >= note.arriveAt) {
        note.status = "arrived";
        this.store.put(note);
        this.emit("event", { kind: "arrived", noteId: note.id, name: note.peerName, petName: note.peerPet.name });
        changed = true;
      }
      if (note.dir === "in" && note.replyPending && this.isOnline(note.peerId)) this.pushReply(note);
      if (note.dir === "out" && note.status === "travelling" && this.isOnline(note.peerId)) {
        if (t - (note.sentAt || 0) > RETRY_MS * (note.attempts || 1)) this.tryDeliver(note);
      }
      if (note.dir === "out" && note.status === "travelling" && note.peerId !== this.store.identity.id
        && !this.isOnline(note.peerId) && t - (note.sentAt || 0) > RETRY_MS) {
        this.deliveryFailed(note);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  changed() { this.emit("changed"); }

  snapshot() {
    const me = this.store.identity;
    return {
      me: { id: me.id, name: me.name, pet: me.pet, ready: me.ready, acceptAnyone: me.acceptAnyone },
      peers: this.onlinePeers().map((p) => ({
        id: p.id, name: p.name, pet: p.pet, ip: p.ip,
        safety: p.safety, verified: this.store.isVerified(p.id),
      })),
      notes: this.store.list(),
      travelMs: TRAVEL_MS,
      port: this.port,
    };
  }
}

module.exports = { Net, TRAVEL_MS };
