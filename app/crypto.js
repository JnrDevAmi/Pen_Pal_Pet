"use strict";
/*
 * The security layer.
 *
 * The rule that makes impersonation impossible: your ID is not something you
 * claim, it is a fingerprint of your own signing key. `p_a1b2...` IS
 * SHA-256(your signing key), truncated. To announce yourself as someone else
 * you would have to produce their key, so a forged beacon is rejected by
 * arithmetic rather than by trust.
 *
 * On top of that:
 *   - every beacon and every message is signed (Ed25519)
 *   - message keys come from X25519 + HKDF, bound to both parties and the route
 *   - a timestamp and a nonce make replays useless
 *   - once a friend's key is pinned, a different key is refused, not welcomed
 */
const crypto = require("crypto");

const PROTOCOL = 2;
const CLOCK_SKEW_MS = 45000;   // how far out a beacon/message timestamp may be
const NONCE_TTL_MS = 120000;   // how long a spent nonce is remembered
const NONCE_MAX = 5000;        // hard cap so a flood cannot grow the set forever

/* ---------- key material ---------- */

function newKeys() {
  const x = crypto.generateKeyPairSync("x25519");
  const ed = crypto.generateKeyPairSync("ed25519");
  return {
    pub: x.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    priv: x.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    sigPub: ed.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sigPriv: ed.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}

/** A peer's ID is the fingerprint of its signing key. This is the whole trick. */
function deriveId(sigPubB64) {
  const h = crypto.createHash("sha256").update(Buffer.from(String(sigPubB64), "base64")).digest("hex");
  return "p_" + h.slice(0, 16);
}

function edPriv(b64) {
  return crypto.createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
}
function edPub(b64) {
  return crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

function sign(sigPrivB64, bytes) {
  return crypto.sign(null, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), edPriv(sigPrivB64)).toString("base64");
}
function verify(sigPubB64, bytes, sigB64) {
  try {
    return crypto.verify(
      null,
      Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
      edPub(sigPubB64),
      Buffer.from(String(sigB64 || ""), "base64")
    );
  } catch {
    return false;
  }
}

/* ---------- message keys ---------- */

/**
 * X25519 shared secret run through HKDF, salted with both signing keys in a
 * fixed order. Binding the key to both identities means a secret negotiated
 * with one peer is meaningless to any other.
 */
function messageKey(myPrivB64, theirPubB64, mySigPubB64, theirSigPubB64) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(myPrivB64, "base64"), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey({ key: Buffer.from(theirPubB64, "base64"), format: "der", type: "spki" });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  const pair = [String(mySigPubB64), String(theirSigPubB64)].sort().join("|");
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(pair, "utf8"), Buffer.from("penpal-pet/v2/message"), 32));
}

/**
 * Seal with AES-256-GCM. The sender, recipient and route travel as associated
 * data, so a captured envelope cannot be replayed at a different endpoint or
 * passed off as being from somebody else.
 */
function seal(key, obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function unseal(key, box, aad) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(box.iv), "base64"));
  if (aad) d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(String(box.tag), "base64"));
  const out = Buffer.concat([d.update(Buffer.from(String(box.ct), "base64")), d.final()]);
  return JSON.parse(out.toString("utf8"));
}

/* ---------- replay defence ---------- */

class ReplayGuard {
  constructor() { this.seen = new Map(); }

  /** True if this (nonce, timestamp) pair is fresh; false if stale or reused. */
  accept(nonce, ts) {
    const n = String(nonce || "");
    const t = Number(ts);
    if (!n || n.length < 16 || !Number.isFinite(t)) return false;
    const now = Date.now();
    if (Math.abs(now - t) > CLOCK_SKEW_MS) return false;
    if (this.seen.has(n)) return false;
    this.sweep(now);
    this.seen.set(n, now);
    return true;
  }

  sweep(now) {
    if (this.seen.size < NONCE_MAX) {
      for (const [k, v] of this.seen) {
        if (now - v > NONCE_TTL_MS) this.seen.delete(k);
        else break;
      }
      return;
    }
    // Under flood, drop the oldest half outright rather than grow without bound.
    const keys = [...this.seen.keys()];
    for (let i = 0; i < keys.length / 2; i++) this.seen.delete(keys[i]);
  }
}

const newNonce = () => crypto.randomBytes(16).toString("base64");

/* ---------- safety codes ---------- */

const WORDS = ("able acorn amber anchor apple arbor arrow aspen badge bagel balloon bamboo " +
  "banjo barley basil beacon beetle birch biscuit bison blossom bonfire boulder branch " +
  "bramble breeze bridge bronze bubble bucket buffalo burrow cactus canary candle canyon " +
  "cargo carrot cedar cello cherry chestnut chimney cinder citron clover cobalt cocoa " +
  "comet compass copper coral cottage cricket crimson crocus crystal cypress daffodil dahlia " +
  "daisy damson dapple dawn desert dewdrop domino donkey dragon drifter dumpling dusk " +
  "eagle ember emerald falcon fennel fern fiddle finch flint flutter forest fossil " +
  "foxglove freckle frost galaxy garnet gazelle ginger glacier glimmer granite grotto gumdrop " +
  "hamlet harbor hazel heather hedge hollow honey hornet hummock icicle indigo ivory " +
  "jackal jasmine jetty jigsaw juniper kettle kingfisher kitten koala lantern lark lattice " +
  "lavender ledger lemon lichen lilac linen lobster locket lotus lumber lupine lychee " +
  "magnet mallow mango maple marble marigold meadow medley mellow meteor mimosa minnow " +
  "mint mitten monsoon moorland mosaic moss mulberry mushroom mustard nectar nettle nimbus " +
  "nomad nutmeg oasis oatmeal ocelot olive onyx opal orbit orchard otter " +
  "outpost oyster paddle pagoda pampas pansy papaya parsnip pastel pebble pelican penguin " +
  "pepper petal pewter pigeon pillow pinecone pistachio plateau plover plum pocket pollen " +
  "pomelo poppy portal possum prairie pretzel primrose puffin pumpkin quail quarry quartz " +
  "quiver radish rafter rambler raven reef rhubarb ribbon ridge ripple river robin " +
  "rosemary rowan saffron sage salmon sandal sapphire satchel scallop seagull sequoia shale " +
  "shamrock sherbet shingle sierra silver siskin slate snapdragon sorrel sparrow spindle spruce " +
  "squash stardust starling stipple stork sugar sumac summit sunbeam sundial swallow sycamore " +
  "tadpole talon tamarind tangerine tapestry teasel tempo thicket thimble thistle thorn thrush " +
  "tidal timber tinder toffee topaz torrent tulip tundra turnip turtle twilight umber " +
  "urchin valley vanilla velvet vervain vineyard violet vireo walnut warbler wattle waxwing " +
  "whisker willow windmill wisteria wombat woodland wren yarrow yonder zephyr zinnia zircon").split(/\s+/);

/**
 * Four words both computers derive independently from the pair of signing keys.
 * They match only if each side is talking to who it thinks it is, so reading
 * them aloud once defeats a machine-in-the-middle.
 */
function safetyCode(sigPubA, sigPubB) {
  const pair = [String(sigPubA), String(sigPubB)].sort().join("|");
  const h = crypto.createHash("sha256").update("penpal-pet/v2/safety|" + pair).digest();
  const words = [];
  for (let i = 0; i < 4; i++) {
    const idx = ((h[i * 2] << 8) | h[i * 2 + 1]) % WORDS.length;
    words.push(WORDS[idx]);
  }
  return words.join("-");
}

module.exports = {
  PROTOCOL,
  newKeys, deriveId, sign, verify,
  messageKey, seal, unseal,
  ReplayGuard, newNonce,
  safetyCode, WORDS,
};
