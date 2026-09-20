"use strict";
/*
 * Everything Pen-pal Pet knows lives in two small files in the app's own folder:
 *   identity.json  who you are, what your pet looks like, and this computer's key pair
 *   notes.json     every note you've sent or received
 * Nothing leaves your Wi-Fi and there is no account anywhere.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NOTE_MAX = 140;
const NAME_MAX = 40;
const PET_NAME_MAX = 16;
const PAD_W = 320, PAD_H = 200, MAX_POINTS = 3000, MAX_STROKES = 300, INK_COUNT = 5;
const SPECIES = ["cat", "pup", "frog", "bird"];
const COLORS = ["honey", "plum", "moss", "slate", "peach"];
const MAX_NOTES = 500;

function str(v, max) {
  return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").slice(0, max) : "";
}
function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

function cleanPet(p) {
  p = p && typeof p === "object" ? p : {};
  return {
    name: str(p.name, PET_NAME_MAX).trim() || "Biscuit",
    species: SPECIES.includes(p.species) ? p.species : "cat",
    color: COLORS.includes(p.color) ? p.color : "honey",
  };
}
function cleanStrokes(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  let total = 0;
  for (const s of arr.slice(0, MAX_STROKES)) {
    if (!s || typeof s !== "object" || !Array.isArray(s.p)) continue;
    const c = Number.isInteger(s.c) && s.c >= 0 && s.c < INK_COUNT ? s.c : 0;
    const p = [];
    for (let i = 0; i + 1 < s.p.length && total < MAX_POINTS; i += 2, total++) {
      p.push(
        Math.round(Math.min(PAD_W, Math.max(0, Number(s.p[i]) || 0))),
        Math.round(Math.min(PAD_H, Math.max(0, Number(s.p[i + 1]) || 0)))
      );
    }
    if (p.length >= 2) out.push({ c, p });
  }
  return out;
}
function cleanReply(r) {
  if (!r || typeof r !== "object") return null;
  const wave = r.wave === true;
  return { wave, note: wave ? "" : str(r.note, NOTE_MAX), doodle: wave ? [] : cleanStrokes(r.doodle) };
}

const { newKeys, deriveId, safetyCode } = require("./crypto");

class Store {
  /**
   * `secure` is an optional adapter over the operating system's own keystore
   * (DPAPI, Keychain, libsecret). When present, identity.json - which holds
   * this computer's private keys - is encrypted at rest, so copying the file
   * to another machine yields nothing usable. It is injected rather than
   * imported so this file stays free of Electron and remains testable.
   */
  constructor(dir, secure = null) {
    this.secure = secure && typeof secure.encrypt === "function" ? secure : null;
    this.dir = dir;
    this.idFile = path.join(dir, "identity.json");
    this.notesFile = path.join(dir, "notes.json");
    this.identity = this.readIdentity();
    this.notes = this.readNotes();
    this.peerKeys = this.identity.peerKeys || {};
    this.saveTimer = null;
    this.idTimer = null;
  }

  readJSON(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  writeJSON(file, data) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error("Could not save", path.basename(file), err.message);
    }
  }

  /** Read identity.json, transparently handling both sealed and plain files. */
  readSecret(file) {
    const raw = this.readJSON(file);
    if (!raw) return null;
    if (typeof raw.sealed !== "string") return raw;          // written before sealing, or no keystore
    if (!this.secure) {
      console.error(path.basename(file), "is sealed but this computer cannot open it.");
      return null;
    }
    try {
      const plain = this.secure.decrypt(Buffer.from(raw.sealed, "base64"));
      return plain ? JSON.parse(plain) : null;
    } catch (err) {
      console.error("Could not open", path.basename(file) + ":", err.message);
      return null;
    }
  }

  /** Write identity.json sealed when the keystore is available, plain otherwise. */
  writeSecret(file, data) {
    if (this.secure) {
      try {
        const sealed = this.secure.encrypt(JSON.stringify(data));
        if (sealed && sealed.length) {
          return this.writeJSON(file, { v: 2, sealed: Buffer.from(sealed).toString("base64") });
        }
      } catch (err) {
        console.error("Could not seal identity.json, storing it unsealed:", err.message);
      }
    }
    return this.writeJSON(file, data);
  }

  readIdentity() {
    const d = this.readSecret(this.idFile);
    // A stored identity is only usable if its ID still matches its signing key.
    // Anything older, or tampered with on disk, is discarded and regenerated.
    if (d && d.id && d.priv && d.pub && d.sigPub && d.sigPriv && str(d.id, 40) === deriveId(d.sigPub)) {
      return {
        id: str(d.id, 40),
        name: str(d.name, NAME_MAX),
        pet: cleanPet(d.pet),
        pub: String(d.pub), priv: String(d.priv),
        sigPub: String(d.sigPub), sigPriv: String(d.sigPriv),
        peerKeys: d.peerKeys && typeof d.peerKeys === "object" ? d.peerKeys : {},
        acceptAnyone: d.acceptAnyone !== false,
        createdAt: num(d.createdAt) || Date.now(),
        ready: !!d.ready,
      };
    }
    const keys = newKeys();
    const fresh = {
      id: deriveId(keys.sigPub),
      name: "", pet: cleanPet(null),
      pub: keys.pub, priv: keys.priv,
      sigPub: keys.sigPub, sigPriv: keys.sigPriv,
      peerKeys: {}, acceptAnyone: true, createdAt: Date.now(), ready: false,
    };
    this.writeSecret(this.idFile, fresh);
    return fresh;
  }

  readNotes() {
    const d = this.readSecret(this.notesFile);
    const notes = new Map();
    if (d && Array.isArray(d.notes)) {
      for (const n of d.notes.slice(-MAX_NOTES)) {
        const clean = this.cleanNote(n);
        if (clean) notes.set(clean.id, clean);
      }
    }
    return notes;
  }

  cleanNote(n) {
    if (!n || typeof n !== "object" || !n.id) return null;
    return {
      id: str(n.id, 48),
      dir: n.dir === "in" ? "in" : "out",
      status: str(n.status, 20) || "waiting",
      peerId: str(n.peerId, 40),
      peerName: str(n.peerName, NAME_MAX) || "A friend",
      peerPet: cleanPet(n.peerPet),
      note: str(n.note, NOTE_MAX),
      doodle: cleanStrokes(n.doodle),
      reply: cleanReply(n.reply),
      createdAt: num(n.createdAt),
      sentAt: num(n.sentAt), deliveredAt: num(n.deliveredAt), arriveAt: num(n.arriveAt),
      openedAt: num(n.openedAt), repliedAt: num(n.repliedAt), returnAt: num(n.returnAt),
      readAt: num(n.readAt), recalledAt: num(n.recalledAt),
      replyPending: !!n.replyPending,
      attempts: num(n.attempts),
    };
  }

  /**
   * Debounced. Meeting a roomful of people used to mean one synchronous
   * rewrite of identity.json per person, which blocked the event loop long
   * enough to drop the very beacons we were trying to record.
   */
  saveIdentity() {
    clearTimeout(this.idTimer);
    this.idTimer = setTimeout(() => this.saveIdentityNow(), 250);
  }
  saveIdentityNow() {
    clearTimeout(this.idTimer);
    this.idTimer = null;
    this.identity.peerKeys = this.peerKeys;
    this.writeSecret(this.idFile, this.identity);
  }
  saveNotes() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const list = [...this.notes.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_NOTES);
      this.writeSecret(this.notesFile, { notes: list });
    }, 300);
  }
  saveNow() {
    clearTimeout(this.saveTimer);
    const list = [...this.notes.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_NOTES);
    this.writeSecret(this.notesFile, { notes: list });
    this.saveIdentityNow();
  }

  setProfile(name, pet) {
    this.identity.name = str(name, NAME_MAX).trim() || this.identity.name;
    this.identity.pet = cleanPet(pet);
    this.identity.ready = true;
    this.saveIdentityNow();
  }
  setAcceptAnyone(on) {
    this.identity.acceptAnyone = !!on;
    this.saveIdentity();
  }

  /**
   * Pin a friend's keys the first time we meet them. After that the pinning is
   * enforced: a beacon carrying different keys for a known ID is an impostor or
   * a genuine reinstall, and either way we refuse it until the user says
   * otherwise. Silently accepting the new key is what made v1 spoofable.
   */
  notePeerKey(id, pub, sigPub) {
    const known = this.peerKeys[id];
    if (!known) {
      this.peerKeys[id] = { pub: String(pub), sigPub: String(sigPub), verified: false, firstSeen: Date.now() };
      this.saveIdentity();
      return "new";
    }
    if (known.sigPub === sigPub && known.pub === pub) return "known";
    return "changed";   // caller must reject; only forgetPeer() clears a pin
  }

  isVerified(id) {
    const k = this.peerKeys[str(id, 40)];
    return !!(k && k.verified);
  }
  markVerified(id) {
    const k = this.peerKeys[str(id, 40)];
    if (!k) return false;
    k.verified = true;
    this.saveIdentity();
    return true;
  }
  /** Deliberately drop a pin, so a friend who really did reinstall can be re-met. */
  forgetPeer(id) {
    delete this.peerKeys[str(id, 40)];
    this.saveIdentity();
    return true;
  }
  /** The four words both sides should see for this friend. */
  safetyCodeFor(peerSigPub) {
    return safetyCode(this.identity.sigPub, peerSigPub);
  }

  put(note) {
    this.notes.set(note.id, note);
    this.saveNotes();
    return note;
  }
  get(id) { return this.notes.get(str(id, 48)); }
  remove(id) { this.notes.delete(id); this.saveNotes(); }
  list() { return [...this.notes.values()]; }
}

module.exports = { Store, cleanPet, cleanStrokes, cleanReply, str, num, NOTE_MAX, SPECIES, COLORS };
