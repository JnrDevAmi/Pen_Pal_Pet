"use strict";
/*
 * Everything the page is allowed to ask the app to do.
 *
 * This is the one door between the sandboxed renderer and privileged code, so
 * it is a closed whitelist: an action that is not a own-property of this object
 * does not run. Every argument arrives from the page and is treated as hostile
 * - coerced, bounded, and checked against what the note actually is before
 * anything is written.
 *
 * It lives apart from main.js so it can be exercised without Electron.
 */
const crypto = require("crypto");

const MAX_ID = 48;

/** Ids arrive from the page; keep them to the shape we actually issue. */
function cleanId(v) {
  return typeof v === "string" ? v.replace(/[^A-Za-z0-9_:-]/g, "").slice(0, MAX_ID) : "";
}

function makeActions({ store, net, onChanged = () => {} }) {
  const changed = () => { try { onChanged(); } catch {} };

  return {
    setProfile({ name, pet }) {
      store.setProfile(name, pet);
      net.beacon();
      changed();
      return { ok: true };
    },

    setAcceptAnyone({ on }) {
      store.setAcceptAnyone(!!on);
      changed();
      return { ok: true };
    },

    send({ to, note, doodle }) {
      const target = cleanId(to);
      const self = target === store.identity.id;
      const peer = self
        ? { id: store.identity.id, name: store.identity.name, pet: store.identity.pet }
        : net.peers.get(target);
      if (!peer) return { ok: false, error: "That friend just went offline." };
      const n = store.cleanNote({
        id: "n_" + crypto.randomBytes(10).toString("hex"),
        dir: "out", status: "waiting",
        peerId: peer.id, peerName: peer.name, peerPet: peer.pet,
        note, doodle, createdAt: Date.now(),
      });
      store.put(n);
      changed();
      return { ok: true, note: n };
    },

    /** The user compared the four words with their friend and they matched. */
    verifyFriend({ id }) {
      const ok = store.markVerified(cleanId(id));
      if (ok) changed();
      return ok ? { ok: true } : { ok: false, error: "That friend isn't nearby any more." };
    },

    /** Drop a pinned key, so someone who genuinely reinstalled can be met again. */
    forgetFriend({ id }) {
      const target = cleanId(id);
      if (!target) return { ok: false, error: "Unknown friend." };
      store.forgetPeer(target);
      net.peers.delete(target);
      changed();
      return { ok: true };
    },

    depart({ id }) { return net.depart(cleanId(id)); },
    open({ id }) { return net.markOpened(cleanId(id)); },
    reply({ id, reply }) { return net.sendReply(cleanId(id), reply); },
    recall({ id }) { return net.recall(cleanId(id)); },

    takeBack({ id }) {
      const n = store.get(cleanId(id));
      if (!n || n.dir !== "out" || n.status !== "waiting") {
        return { ok: false, error: "Your pet already left with it." };
      }
      store.remove(n.id);
      changed();
      return { ok: true };
    },

    readReply({ id }) {
      const n = store.get(cleanId(id));
      if (!n || n.dir !== "out") return { ok: false };
      if (n.status === "replied" && Date.now() >= n.returnAt - 2000) {
        n.status = "home";
        n.readAt = Date.now();
        store.put(n);
        changed();
      }
      return { ok: true };
    },

    remove({ id }) {
      const n = store.get(cleanId(id));
      if (!n) return { ok: true };
      const finished = ["home", "recalled"].includes(n.status)
        || (n.dir === "in" && ["replied", "recalled"].includes(n.status));
      if (!finished) return { ok: false, error: "That note is still in progress." };
      store.remove(n.id);
      changed();
      return { ok: true };
    },
  };
}

/**
 * Dispatch one request from the page. Inherited properties are refused, so a
 * payload carrying `__proto__` or `constructor` cannot reach a function that
 * was never meant to be callable.
 */
async function dispatch(actions, msg) {
  const name = msg && typeof msg.action === "string" ? msg.action : "";
  if (!Object.prototype.hasOwnProperty.call(actions, name)) {
    return { ok: false, error: "Unknown action." };
  }
  const fn = actions[name];
  if (typeof fn !== "function") return { ok: false, error: "Unknown action." };
  const payload = msg && msg.payload && typeof msg.payload === "object" ? msg.payload : {};
  try {
    const res = await fn(payload);
    return res || { ok: true };
  } catch (err) {
    console.error(err);
    return { ok: false, error: "Something went wrong on this computer." };
  }
}

module.exports = { makeActions, dispatch, cleanId };
