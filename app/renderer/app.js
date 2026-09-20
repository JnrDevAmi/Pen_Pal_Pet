(() => {
"use strict";

/* ================= bridge (Electron preload; a shim keeps it openable in a browser for testing) ================= */
const bridge = window.penpal || {
  platform: "web",
  getState: async () => null,
  call: async () => ({ ok: false, error: "Not running inside the app." }),
  setStatus() {}, quit() {},
  onState() {}, onEvent() {}, onCommand() {},
};

/* ================= constants ================= */
const NOTE_MAX = 140;
const PAD_W = 320, PAD_H = 200, MAX_POINTS = 3000, MAX_STROKES = 300;
const INKS = ["#1f2433", "#d6423b", "#2b4ba0", "#e0a21a", "#2f8a57"];
const INK_NAMES = ["Black ink", "Red ink", "Blue ink", "Yellow ink", "Green ink"];
const COLORS = {
  honey: { body: "#f0ad4e", dark: "#bf7a1f", label: "Honey" },
  plum:  { body: "#a987cf", dark: "#6c4b95", label: "Plum" },
  moss:  { body: "#86c46f", dark: "#4c8a3b", label: "Moss" },
  slate: { body: "#9aaec4", dark: "#5a6e86", label: "Slate" },
  peach: { body: "#f4a193", dark: "#c35f4e", label: "Peach" },
};
const SPECIES_LABEL = { cat: "Cat", pup: "Pup", frog: "Frog", bird: "Puffbird" };

const CARRY = (tf) => `<g class="carry" transform="${tf}">
  <rect class="env" x="0" y="0" width="20" height="13" rx="1.5" stroke="#1f2433" stroke-width="1.1"/>
  <path d="M0.8 1 L10 7.6 L19.2 1" fill="none" stroke="#1f2433" stroke-width="1.1" stroke-linejoin="round"/>
  <rect x="2" y="9.8" width="3" height="1.6" fill="#d6423b"/><rect x="6.5" y="9.8" width="3" height="1.6" fill="#2b4ba0"/>
  <rect x="11" y="9.8" width="3" height="1.6" fill="#d6423b"/><rect x="15.5" y="9.8" width="3" height="1.6" fill="#2b4ba0"/>
</g>`;
/*
 * A lateral-sequence walk - the gait cats and dogs actually use. Each foot
 * falls a quarter-cycle after the last, in the order:
 *
 *     front-right -> rear-left -> front-left -> rear-right
 *
 * so three feet are always on the ground. The classes carry that identity
 * rather than a bare a/b, because the phase offsets in the stylesheet only
 * make sense if you can see which leg is which. Head end is +x, so the legs
 * at 44/53 are the front pair. The far-side pair sits slightly back in tone,
 * which is what gives the four legs depth instead of reading as two.
 */
const LEG = (cls, x) => `
  <g class="leg ${cls}">
    <rect class="thigh" x="${x}" y="46" width="7" height="10" rx="3.5" fill="var(--pd)"/>
    <g class="shin">
      <rect x="${x + 0.3}" y="54" width="6.4" height="8" rx="3.2" fill="var(--pd)"/>
      <rect class="paw" x="${x - 0.4}" y="59.5" width="7.8" height="3.6" rx="1.8" fill="var(--pd)"/>
    </g>
  </g>`;

const LEGS4 = `
  ${LEG("rr far", 18)}
  ${LEG("rl", 27)}
  ${LEG("fr far", 44)}
  ${LEG("fl", 53)}`;
const SPECIES_SVG = {
  cat: `
  <g class="tail"><path d="M17 40 C6 36 5 24 11 17" fill="none" stroke="var(--pd)" stroke-width="5" stroke-linecap="round"/></g>
  ${LEGS4}
  <g class="body-g">
    <ellipse cx="38" cy="43" rx="24" ry="13" fill="var(--pc)"/>
    <path d="M51 25 L53 7 L63 18 Z" fill="var(--pc)"/>
    <path d="M65 18 L74 7 L76 26 Z" fill="var(--pc)"/>
    <path d="M54.5 20 L55.3 12 L59.5 16.5 Z" fill="var(--pd)" opacity=".55"/>
    <path d="M68.5 16.5 L72.5 12 L73 20 Z" fill="var(--pd)" opacity=".55"/>
    <circle cx="63" cy="30" r="13" fill="var(--pc)"/>
    <circle cx="59.5" cy="28.5" r="2.1" fill="#1f2433"/>
    <circle cx="68.5" cy="28.5" r="2.1" fill="#1f2433"/>
    <path d="M62.3 33 q1.9 1.7 3.8 0" stroke="#1f2433" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    <circle cx="56.5" cy="33" r="2.3" fill="#ff7f7f" opacity=".45"/>
    <circle cx="72" cy="33" r="2.3" fill="#ff7f7f" opacity=".45"/>
    ${CARRY("translate(68 31) rotate(-10)")}
  </g>`,
  pup: `
  <g class="tail"><path d="M17 38 C10 32 10 25 14 20" fill="none" stroke="var(--pd)" stroke-width="5.5" stroke-linecap="round"/></g>
  ${LEGS4}
  <g class="body-g">
    <ellipse cx="38" cy="43" rx="23" ry="13.5" fill="var(--pc)"/>
    <circle cx="62" cy="28" r="13.5" fill="var(--pc)"/>
    <ellipse cx="71" cy="33" rx="8" ry="6" fill="#ffffff" opacity=".45"/>
    <circle cx="77.5" cy="30.5" r="2.4" fill="#1f2433"/>
    <circle cx="65" cy="25" r="2.1" fill="#1f2433"/>
    <path d="M52 17 C44 19 45 36 51 39 C56 37 58 26 57 18 Z" fill="var(--pd)"/>
    <path d="M70 37.5 q2.5 2 5 0" stroke="#1f2433" stroke-width="1.3" fill="none" stroke-linecap="round"/>
    ${CARRY("translate(69 34) rotate(-6)")}
  </g>`,
  frog: `
  <path class="leg a" d="M13 60 C10 48 24 42 31 49 L29 61 Z" fill="var(--pd)"/>
  <rect class="leg b" x="46" y="49" width="7" height="12" rx="3.5" fill="var(--pd)"/>
  <rect class="leg a" x="56" y="49" width="7" height="12" rx="3.5" fill="var(--pd)"/>
  <g class="body-g">
    <ellipse cx="40" cy="46" rx="26" ry="13" fill="var(--pc)"/>
    <ellipse cx="46" cy="51" rx="15" ry="6" fill="#ffffff" opacity=".3"/>
    <ellipse cx="60" cy="38" rx="17" ry="11.5" fill="var(--pc)"/>
    <circle cx="51" cy="28" r="8" fill="var(--pc)"/>
    <circle cx="68" cy="29" r="8" fill="var(--pc)"/>
    <circle cx="51.5" cy="27" r="5" fill="#fffdf6"/>
    <circle cx="68.5" cy="28" r="5" fill="#fffdf6"/>
    <circle cx="53.5" cy="27" r="2.5" fill="#1f2433"/>
    <circle cx="70.5" cy="28" r="2.5" fill="#1f2433"/>
    <path d="M53 42 q10 6 21 -1" stroke="#1f2433" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    ${CARRY("translate(69 38) rotate(-8)")}
  </g>`,
  bird: `
  <g class="leg a"><path d="M39 52 L39 61 M35.5 61.5 L43 61.5" stroke="#dd8a2c" stroke-width="2.6" stroke-linecap="round"/></g>
  <g class="leg b"><path d="M50 52 L50 61 M46.5 61.5 L54 61.5" stroke="#dd8a2c" stroke-width="2.6" stroke-linecap="round"/></g>
  <g class="body-g">
    <g class="tail"><path d="M26 34 L9 27 L13 42 Z" fill="var(--pd)"/></g>
    <circle cx="44" cy="35" r="20" fill="var(--pc)"/>
    <ellipse cx="50" cy="42" rx="11" ry="10" fill="#ffffff" opacity=".35"/>
    <ellipse cx="37" cy="37" rx="10.5" ry="7" fill="var(--pd)" transform="rotate(-18 37 37)"/>
    <path d="M43 16 C41 8 48 7 47 15 Z" fill="var(--pd)"/>
    <path d="M47 16 C48 10 54 11 51 17 Z" fill="var(--pd)"/>
    <circle cx="54" cy="29" r="2.4" fill="#1f2433"/>
    <circle cx="55" cy="36" r="2.4" fill="#ff7f7f" opacity=".45"/>
    <path d="M62 31 L73 35 L62 39 Z" fill="#f2a53a" stroke="#c77a1a" stroke-width=".8" stroke-linejoin="round"/>
    ${CARRY("translate(66 33) rotate(-6)")}
  </g>`,
};

/* ================= helpers ================= */
const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const rand = (a, b) => a + Math.random() * (b - a);
function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label, cls = "btn", onClick) {
  const b = h("button", cls, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  return b;
}
function petSVG(species, colorId, cls = "") {
  const sp = SPECIES_SVG[species] || SPECIES_SVG.cat;
  const c = COLORS[colorId] || COLORS.honey;
  return `<svg class="pet-svg ${cls}" viewBox="0 0 90 64" aria-hidden="true" focusable="false" style="--pc:${c.body};--pd:${c.dark}">${sp}</svg>`;
}
function face(pet) { const f = h("span", "face"); f.innerHTML = petSVG(pet.species, pet.color); return f; }
function ago(t) {
  if (!t) return "";
  const s = Math.max(0, (now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function possessive(name, self) { return self ? "your" : name + "’s"; }

/* The pets walk on the stage, which is narrower than the window: the airmail
   stripe and the shortcut rail sit to its left. */
const stage = $("stage");
function stageW() { return stage ? stage.clientWidth : innerWidth; }
function stageH() { return stage ? stage.clientHeight : innerHeight; }

/* ================= state ================= */
const S = {
  me: null,
  ready: false,
  peers: new Map(),
  notes: new Map(),
  out: [], inn: [],
  travelMs: 8000,
  firstPassDone: false,
  seenVisitors: new Set(),
  announcedReturns: new Set(),
  win: null,
  popover: null,
  dragging: false,
};

function rebuild() {
  const all = [...S.notes.values()];
  S.out = all.filter((n) => n.dir === "out");
  S.inn = all.filter((n) => n.dir === "in");
}
function myPet() { return S.me ? S.me.pet : { name: "Biscuit", species: "cat", color: "honey" }; }
function isSelf(id) { return !!S.me && id === S.me.id; }
function petOfNote(n) {
  const peer = S.peers.get(n.peerId);
  return peer ? peer.pet : n.peerPet;
}
function nameOfNote(n) {
  if (isSelf(n.peerId)) return "you";
  const peer = S.peers.get(n.peerId);
  return peer ? peer.name : n.peerName;
}
const isOnline = (id) => isSelf(id) || S.peers.has(id);

/* derived trip state */
const AWAY = ["travelling", "delivered", "reading"];
function isActive(n) {
  if (AWAY.includes(n.status)) return true;
  if ((n.status === "replied" || n.status === "recalled") && now() < n.returnAt) return true;
  return false;
}
function activeTrip() { return S.out.find(isActive) || null; }
function isAway() { return !!activeTrip(); }
function waiting() { return S.out.filter((n) => n.status === "waiting").sort((a, b) => a.createdAt - b.createdAt); }
function readyToGo() { return waiting().filter((n) => isOnline(n.peerId)); }
function returned() { return S.out.filter((n) => n.status === "replied" && now() >= n.returnAt).sort((a, b) => a.returnAt - b.returnAt); }
function visitorNotes() { return S.inn.filter((n) => n.status === "arrived" || n.status === "read").sort((a, b) => a.arriveAt - b.arriveAt); }

/* ================= toasts & notifications ================= */
function toast(msg, warn = false) {
  const t = h("div", "toast" + (warn ? " warn" : ""), msg);
  $("toasts").append(t);
  setTimeout(() => t.remove(), 5600);
}
function notify(title, body) {
  if (bridge.platform === "web" || typeof Notification === "undefined") return;
  try { new Notification(title, { body }); } catch {}
}
async function call(action, payload) {
  const res = await bridge.call(action, payload);
  if (!res || !res.ok) {
    if (res && res.error) toast(res.error, true);
    return null;
  }
  return res;
}

/* ================= pointer ================= */
/* The window is an ordinary one, so clicks land normally. The pet menu just
   needs to know when the pointer has wandered away from it. */
document.addEventListener("pointermove", (ev) => {
  if (!S.popover) return;
  const r = S.popover.el.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const px = sr.left + S.popover.entity.x;
  const nearMenu = ev.clientX > r.left - 40 && ev.clientX < r.right + 40
    && ev.clientY > r.top - 40 && ev.clientY < r.bottom + 40;
  const nearPet = ev.clientX > px - 70 && ev.clientX < px + 70 && ev.clientY > sr.bottom - 120;
  if (nearMenu || nearPet) S.popover.lastNear = performance.now();
  else if (performance.now() - S.popover.lastNear > 1400) closePetMenu();
});

/* ================= pet entities ================= */
const entities = new Map();
const layer = $("pets");

function spawn(key, pet, opts = {}) {
  const el = h("div", "pet");
  const above = h("div", "above");
  const bubble = h("div", "bubble"); bubble.hidden = true;
  const tag = h("div", "tag"); tag.hidden = true;
  above.append(bubble, tag);
  const btn = h("button", "pet-btn hit");
  btn.type = "button";
  el.append(above, btn);
  layer.append(el);
  const W = stageW();
  const e = {
    key, el, btn, bubble, tag,
    kind: opts.kind || "mine",
    noteId: opts.noteId || null,
    x: rand(W * 0.3, W * 0.7),
    lane: opts.kind === "visitor" ? rand(2, 7) : rand(0, 3),
    dir: 1, target: null, speed: 60, onArrive: null,
    idleUntil: performance.now() + rand(600, 2000),
    scripted: false, leaving: false, carry: null, carryId: null,
    sleeping: false, lookKey: "", departAt: 0, bubbleTimer: 0, tripToken: null,
  };
  el.style.zIndex = String(40 - Math.round(e.lane));
  setLook(e, pet);
  btn.addEventListener("click", () => onPetClick(e));
  entities.set(key, e);
  place(e);
  return e;
}
function setLook(e, pet) {
  const key = pet.species + "|" + pet.color;
  if (key !== e.lookKey) {
    e.btn.innerHTML = petSVG(pet.species, pet.color);
    for (const sp of Object.keys(SPECIES_SVG)) e.el.classList.toggle("sp-" + sp, sp === pet.species);
    e.lookKey = key;
  }
  e.petName = pet.name;
  labelPet(e);
}
function labelPet(e) {
  const label = e.kind === "mine"
    ? `${e.petName}, your pet` + (e.carry === "reply" ? ". Carrying a reply, press to read it" : ". Press for options")
    : `${e.tagText || e.petName}, visiting with a note. Press to read it`;
  e.btn.setAttribute("aria-label", label);
}
function setCarry(e, kind, id = null) {
  e.carry = kind; e.carryId = id;
  e.el.classList.toggle("carrying", !!kind);
  e.el.classList.toggle("carrying-reply", kind === "reply");
  labelPet(e);
}
function removeEntity(e) {
  clearTimeout(e.bubbleTimer);
  if (S.popover && S.popover.entity === e) closePetMenu();
  e.el.remove();
  entities.delete(e.key);
}
function place(e) {
  e.el.style.transform = `translate3d(${(e.x - 45).toFixed(1)}px, ${(-e.lane).toFixed(1)}px, 0)`;
  e.el.classList.toggle("flip", e.dir < 0);
}
function setWalking(e, on) {
  if (e.walking === on) return;
  e.walking = on;
  e.el.classList.toggle("walking", on);
}
function say(e, text, ms = 1800) {
  clearTimeout(e.bubbleTimer);
  e.bubble.textContent = text;
  e.bubble.hidden = false;
  if (ms) e.bubbleTimer = setTimeout(() => { e.bubble.hidden = true; }, ms);
}
function wake(e) {
  if (!e.sleeping) return;
  e.sleeping = false;
  e.el.classList.remove("sleep");
  e.bubble.hidden = true;
}
function walkTo(e, x, speed, cb) {
  wake(e);
  e.scripted = true;
  e.target = x; e.speed = speed; e.onArrive = cb || null;
}
function wander(e) {
  const W = stageW();
  const lo = 70, hi = Math.max(lo + 10, W - 70);
  let x = rand(lo, hi);
  if (Math.abs(x - e.x) < 60) x = Math.min(hi, Math.max(lo, e.x + (Math.random() < 0.5 ? -120 : 120)));
  e.target = x;
  e.speed = rand(48, 72);
  e.onArrive = () => {
    const t = performance.now();
    if (Math.random() < 0.16) {
      e.sleeping = true;
      e.el.classList.add("sleep");
      say(e, "z z z", 0);
      e.idleUntil = t + rand(8000, 14000);
    } else {
      e.idleUntil = t + rand(1600, 5200);
    }
  };
}
function nearestEdge(e) { return e.x < stageW() / 2 ? "left" : "right"; }
function exitEntity(e, cb, side) {
  e.leaving = true;
  const s = side || nearestEdge(e);
  walkTo(e, s === "left" ? -70 : stageW() + 70, 92, () => { removeEntity(e); if (cb) cb(); });
}
function enterEntity(e, side) {
  const W = stageW();
  const s = side || (Math.random() < 0.5 ? "left" : "right");
  e.x = s === "left" ? -70 : W + 70;
  e.dir = s === "left" ? 1 : -1;
  place(e);
  walkTo(e, s === "left" ? rand(W * 0.15, W * 0.45) : rand(W * 0.55, W * 0.85), 86, () => {
    e.scripted = false;
    e.idleUntil = performance.now() + 1500;
  });
}

let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  for (const e of entities.values()) {
    if (e.target != null) {
      const dx = e.target - e.x;
      const step = e.speed * dt;
      if (Math.abs(dx) <= step) {
        e.x = e.target; e.target = null;
        setWalking(e, false);
        const cb = e.onArrive; e.onArrive = null;
        if (cb) cb();
      } else {
        e.x += Math.sign(dx) * step;
        e.dir = Math.sign(dx);
        setWalking(e, true);
      }
    } else if (!e.scripted && t > e.idleUntil) {
      wake(e);
      wander(e);
    } else {
      setWalking(e, false);
    }
    if (entities.has(e.key)) place(e);
  }
  if (S.popover) positionPetMenu();
  requestAnimationFrame(frame);
}

function onPetClick(e) {
  if (e.kind === "visitor") {
    const n = S.notes.get(e.noteId);
    if (n && !e.leaving) openReceived(n);
    return;
  }
  wake(e);
  if (e.carry === "reply" && e.carryId) {
    const n = S.notes.get(e.carryId);
    if (n) { openReturned(n); return; }
  }
  e.el.classList.remove("hop");
  void e.el.offsetWidth;
  e.el.classList.add("hop");
  setTimeout(() => e.el.classList.remove("hop"), 460);
  if (e.leaving) { say(e, "off to deliver!"); return; }
  if (S.popover && S.popover.entity === e) { closePetMenu(); return; }
  openPetMenu(e);
}

/* ---------- the little menu over your pet ---------- */
function openPetMenu(e) {
  closePetMenu();
  const pop = h("div", "popover hit");
  pop.setAttribute("role", "menu");
  pop.append(h("div", "who", `${myPet().name} says hi`));
  const item = (label, fn) => {
    const b = button(label, "", () => { closePetMenu(); fn(); });
    b.setAttribute("role", "menuitem");
    pop.append(b);
  };
  item("Write a note", openWrite);
  const badge = visitorNotes().length + returned().length;
  item(badge ? `Mailbag (${badge})` : "Mailbag", openMailbag);
  item(S.peers.size ? `Nearby friends (${S.peers.size})` : "Nearby friends", openNearby);
  item("My pet", openPetEditor);
  document.body.append(pop);
  e.scripted = true; e.target = null; e.onArrive = null;
  S.popover = { el: pop, entity: e, lastNear: performance.now() };
  positionPetMenu();
  say(e, waiting().length ? "I’ll take it soon" : "♥", 1200);
}
function positionPetMenu() {
  const p = S.popover;
  if (!p) return;
  const sr = stage.getBoundingClientRect();
  const x = sr.left + p.entity.x;
  p.el.style.left = Math.round(Math.min(innerWidth - 198, Math.max(8, x - 95))) + "px";
}
function closePetMenu() {
  if (!S.popover) return;
  const { el, entity } = S.popover;
  S.popover = null;
  el.remove();
  if (entities.get(entity.key) === entity && !entity.leaving) {
    entity.scripted = false;
    entity.idleUntil = performance.now() + 800;
  }
}

/* ---------- departures ---------- */
function maybeDepart() {
  const me = entities.get("mine");
  if (!me || me.leaving || me.scripted) return;
  if (isAway() || returned().length) return;
  const q = readyToGo();
  if (!q.length) { me.departAt = 0; return; }
  const t = now();
  if (!me.departAt) { me.departAt = t + rand(2500, 7000); return; }
  if (t < me.departAt) return;
  me.departAt = 0;
  const note = q[0];
  const token = {};
  const live = () => entities.get("mine") === me && me.tripToken === token;
  me.tripToken = token;
  me.leaving = true;
  walkTo(me, floorMailX(), 80, () => {
    if (!live()) return;
    setCarry(me, "letter", note.id);
    renderFloorMail();
    say(me, "!", 900);
    setTimeout(() => {
      if (!live()) return;
      const side = Math.random() < 0.5 ? "left" : "right";
      const W = stageW();
      const mid = side === "left" ? rand(W * 0.3, W * 0.6) : rand(W * 0.4, W * 0.7);
      walkTo(me, mid, 70, () => {
        setTimeout(() => {
          if (!live()) return;
          exitEntity(me, () => depart(note), side);
        }, rand(500, 1400));
      });
    }, 900);
  });
}
async function depart(note) {
  const res = await bridge.call("depart", { id: note.id });
  if (!res || !res.ok) {
    // the friend disappeared between the pet leaving and the handover
    toast(`${myPet().name} couldn’t find ${note.peerName} and is bringing the note back.`);
  }
  refreshAll();
}

/* ================= scene ================= */
function floorMailX() { return Math.round(Math.max(90, stageW() * 0.42)); }

function reconcile() {
  if (!S.ready || !S.me) return;
  const pet = myPet();
  let mine = entities.get("mine");
  const firstPass = !S.firstPassDone;
  S.firstPassDone = true;
  const wantMine = !isAway();

  if (wantMine && !mine) {
    mine = spawn("mine", pet);
    const ret = returned()[0];
    if (ret) {
      setCarry(mine, "reply", ret.id);
      enterEntity(mine);
      announceReturn(ret);
    } else if (firstPass) {
      mine.el.classList.add("appear");
    } else {
      enterEntity(mine);
    }
  } else if (mine) {
    setLook(mine, pet);
    if (!wantMine && !mine.leaving) {
      exitEntity(mine);
    } else if (!mine.leaving) {
      const ret = returned()[0];
      if (ret && mine.carryId !== ret.id) { setCarry(mine, "reply", ret.id); announceReturn(ret); }
      if (!ret && mine.carry) setCarry(mine, null);
    }
  }

  const want = new Map(visitorNotes().map((n) => ["v:" + n.id, n]));
  for (const [k, n] of want) {
    const vp = petOfNote(n);
    let e = entities.get(k);
    if (!e) {
      e = spawn(k, vp, { kind: "visitor", noteId: n.id });
      setCarry(e, "letter", n.id);
      enterEntity(e);
      if (!S.seenVisitors.has(n.id)) {
        S.seenVisitors.add(n.id);
        announceVisitor(n, vp);
      }
    } else {
      setLook(e, vp);
    }
    const text = isSelf(n.peerId) ? `your ${vp.name} (test)` : `${nameOfNote(n)}’s ${vp.name}`;
    if (e.tagText !== text) { e.tagText = text; e.tag.textContent = text; labelPet(e); }
    e.tag.hidden = false;
  }
  for (const [k, e] of entities) {
    if (k.startsWith("v:") && !want.has(k) && !e.leaving) exitEntity(e);
  }

  maybeDepart();
  renderFloorMail();
}

function announceVisitor(n, vp) {
  if (isSelf(n.peerId)) { toast(`Your ${vp.name} came back around with your test note.`); return; }
  toast(`${n.peerName}’s ${vp.name} walked in with a note. Click it to read.`);
  notify(`${vp.name} is on your desktop`, `${n.peerName} sent you a note.`);
}
function announceReturn(n) {
  if (S.announcedReturns.has(n.id)) return;
  S.announcedReturns.add(n.id);
  const pet = myPet();
  const who = isSelf(n.peerId) ? "you" : n.peerName;
  toast(`${pet.name} is back with a reply from ${who}. Click ${pet.name} to read it.`);
  notify(`${pet.name} is back`, `${who} ${n.reply && n.reply.wave ? "waved back" : "wrote back"}.`);
}

function renderFloorMail() {
  const fm = $("floor-mail");
  const me = entities.get("mine");
  const w = S.ready ? waiting() : [];
  let n = w.length;
  if (me && me.carry === "letter" && w.some((x) => x.id === me.carryId)) n -= 1;
  fm.hidden = n <= 0;
  if (n > 0) {
    fm.style.left = (floorMailX() - 23) + "px";
    $("floor-count").textContent = String(n);
    fm.setAttribute("aria-label", `${n} ${n === 1 ? "note" : "notes"} waiting for ${myPet().name} to pick up`);
  }
}

function statusText() {
  if (!S.ready) return "Setting up…";
  const pet = myPet();
  const trip = activeTrip();
  const ret = returned()[0];
  const me = entities.get("mine");
  let text;
  if (trip) {
    const who = nameOfNote(trip), self = isSelf(trip.peerId);
    if (trip.status === "travelling") text = `${pet.name} is walking over to ${who}`;
    else if (trip.status === "delivered") text = `${pet.name} is waiting on ${possessive(who, self)} desktop`;
    else if (trip.status === "reading") text = `${self ? "You are" : who + " is"} reading ${pet.name}’s note`;
    else if (trip.status === "replied") text = `${pet.name} is walking home with ${possessive(who, self)} reply`;
    else text = `${pet.name} is walking home`;
  } else if (ret) {
    text = `${pet.name} brought back a reply`;
  } else if (me && me.leaving && me.carry === "letter") {
    const n = S.notes.get(me.carryId);
    text = `${pet.name} is heading out to ${n ? nameOfNote(n) : "a friend"}`;
  } else if (readyToGo().length) {
    text = `${pet.name} has a note to deliver`;
  } else if (waiting().length) {
    const n = waiting()[0];
    text = `Waiting for ${n.peerName} to come online`;
  } else {
    text = `${pet.name} is home`;
  }
  const near = S.peers.size;
  return text + (near ? `. ${near} nearby` : ". No one nearby");
}
let lastStatusKey = "";
function renderStatus() {
  const text = statusText();
  const badge = S.ready ? visitorNotes().length + returned().length : 0;
  const key = text + "|" + badge;
  if (key !== lastStatusKey) {
    lastStatusKey = key;
    bridge.setStatus(text, badge);
  }
}
function refreshAll() {
  reconcile();
  renderStatus();
  renderRail();
  renderStatusBar();
  if (S.win && S.win.refresh) S.win.refresh();
}


/* ================= app shell: rail + status bar ================= */
const ICONS = {
  write: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <rect x="3" y="11" width="30" height="21" rx="2.5" fill="#fffdf6" stroke="#1f2433" stroke-width="2"/>
    <path d="M4 12.5 L18 24 L32 12.5" fill="none" stroke="#1f2433" stroke-width="2" stroke-linecap="round"/>
    <path d="M25 21 L35.5 10.5 L38.5 13.5 L28 24 L24 25 Z" fill="#f2c14e" stroke="#1f2433" stroke-width="2" stroke-linejoin="round"/>
  </svg>`,
  mailbag: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <path d="M13 12 v-2 a7 7 0 0 1 14 0 v2" fill="none" stroke="#1f2433" stroke-width="2.4" stroke-linecap="round"/>
    <rect x="5" y="12" width="30" height="21" rx="3" fill="#b9762f" stroke="#1f2433" stroke-width="2"/>
    <rect x="5" y="12" width="30" height="7" rx="2.5" fill="#a0641f" stroke="#1f2433" stroke-width="2"/>
    <rect x="16" y="20" width="8" height="7" rx="1.5" fill="#f2c14e" stroke="#1f2433" stroke-width="1.8"/>
  </svg>`,
  friends: `<svg viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="16" cy="14" r="6.5" fill="#cfe0f7" stroke="#1f2433" stroke-width="2"/>
    <path d="M5.5 32 a10.5 9 0 0 1 21 0" fill="#cfe0f7" stroke="#1f2433" stroke-width="2" stroke-linecap="round"/>
    <circle cx="30" cy="26" r="8" fill="#2b4ba0" stroke="#1f2433" stroke-width="2"/>
    <path d="M30 22 v8 M26 26 h8" stroke="#fffdf6" stroke-width="2.4" stroke-linecap="round"/>
  </svg>`,
};

function railButton(key, label, icon, onClick, badgeCount, quiet) {
  const b = h("button", "rail-btn hit");
  b.type = "button";
  b.dataset.key = key;
  const ico = h("span", "rail-ico");
  ico.innerHTML = icon;
  // Red means "this wants you". A count of who is nearby is information, not a
  // demand, so it gets a quiet badge instead.
  if (badgeCount) ico.append(h("span", "rail-badge" + (quiet ? " quiet" : ""), String(badgeCount)));
  b.append(ico, h("span", "rail-label", label));
  b.addEventListener("click", onClick);
  return b;
}

let lastRailKey = "";
function renderRail() {
  const rail = $("rail");
  if (!rail) return;
  if (!S.ready) { rail.replaceChildren(); lastRailKey = ""; return; }
  const bag = visitorNotes().length + returned().length;
  const near = S.peers.size;
  const pet = myPet();
  const key = [bag, near, pet.species, pet.color, pet.name].join("|");
  if (key === lastRailKey) return;
  lastRailKey = key;

  rail.replaceChildren(
    railButton("write", "Write a note", ICONS.write, openWrite),
    railButton("mailbag", "Mailbag", ICONS.mailbag, openMailbag, bag),
    railButton("friends", "Add a pen pal", ICONS.friends, openNearby, near, true),
    railButton("pet", "My pet", petSVG(pet.species, pet.color), openPetEditor)
  );
}

let lastBarKey = "";
function renderStatusBar() {
  const textEl = $("sb-text");
  const petEl = $("sb-pet");
  if (!textEl) return;
  const text = S.ready ? statusText() : "Setting up…";
  const pet = myPet();
  const key = text + "|" + pet.species + "|" + pet.color;
  if (key === lastBarKey) return;
  lastBarKey = key;
  textEl.textContent = text;
  if (petEl) petEl.innerHTML = petSVG(pet.species, pet.color);
}

function renderClock() {
  const el = $("sb-clock");
  if (!el) return;
  el.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* ================= windows ================= */
function openWindow(title, { wide = false, kind = "", onClose, closable = true } = {}) {
  if (S.win) S.win.close(true);
  closePetMenu();
  const win = h("section", "win hit" + (wide ? " wide" : ""));
  win.setAttribute("role", "dialog");
  const stripe = h("div", "win-stripe");
  const head = h("div", "win-head");
  const h2 = h("h2", "", title);
  h2.id = "win-title-" + Math.random().toString(36).slice(2);
  win.setAttribute("aria-labelledby", h2.id);
  const x = button("×", "close");
  x.setAttribute("aria-label", "Close");
  x.hidden = !closable;
  head.append(h2, x);
  const body = h("div", "win-body");
  win.append(stripe, head, body);
  document.body.append(win);

  const w = {
    el: win, body, kind, refresh: null,
    setTitle: (t) => { h2.textContent = t; },
    close: (force = false) => {
      if (S.win !== w) return;
      if (!closable && !force) return;
      S.win = null;
      win.remove();
      if (onClose) onClose();
    },
  };
  x.addEventListener("click", () => w.close());
  win.addEventListener("keydown", (ev) => { if (ev.key === "Escape") w.close(); });

  head.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button")) return;
    const r = win.getBoundingClientRect();
    win.style.transform = "none";
    win.style.left = r.left + "px";
    win.style.top = r.top + "px";
    const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
    head.setPointerCapture(ev.pointerId);
    S.dragging = true;
    const move = (m) => {
      win.style.left = Math.min(innerWidth - 80, Math.max(-r.width + 80, m.clientX - ox)) + "px";
      win.style.top = Math.min(innerHeight - 60, Math.max(0, m.clientY - oy)) + "px";
    };
    const up = () => {
      S.dragging = false;
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });

  S.win = w;
  setTimeout(() => {
    const f = body.querySelector("input, textarea, button.primary, button");
    (f || x).focus();
  }, 60);
  return w;
}

/* ================= doodles ================= */
function strokePath(p) {
  if (p.length < 4) return `M${p[0]} ${p[1]} l0.01 0`;
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    d += ` Q${p[i]} ${p[i + 1]} ${mx} ${my}`;
  }
  return d + ` L${p[p.length - 2]} ${p[p.length - 1]}`;
}
function doodleSVG(strokes) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${PAD_W} ${PAD_H}`);
  svg.setAttribute("class", "doodle");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Hand-drawn doodle");
  for (const s of strokes) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", strokePath(s.p));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", INKS[s.c] || INKS[0]);
    path.setAttribute("stroke-width", "3.4");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}
function makePad(onChange) {
  const wrap = h("div", "stack");
  const pad = h("div", "pad");
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-label", "Doodle area. Draw with a mouse, finger or pen.");
  cv.setAttribute("role", "img");
  const hint = h("div", "hint", "Doodle here");
  pad.append(cv, hint);
  const tools = h("div", "pad-tools");
  let ink = 0;
  const swatches = INKS.map((c, i) => {
    const b = button("", "swatch", () => {
      ink = i;
      swatches.forEach((s, j) => s.setAttribute("aria-pressed", String(j === i)));
    });
    b.style.background = c;
    b.setAttribute("aria-label", INK_NAMES[i]);
    b.setAttribute("aria-pressed", String(i === 0));
    return b;
  });
  const undo = button("Undo", "btn small");
  const clear = button("Clear", "btn small");
  tools.append(...swatches, h("span", "spacer"), undo, clear);
  wrap.append(pad, tools);

  const ctx = cv.getContext("2d");
  let strokes = [], cur = null, total = 0, full = false;
  function draw() {
    const r = cv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = devicePixelRatio || 1;
    const wpx = Math.round(r.width * dpr), hpx = Math.round(r.height * dpr);
    if (cv.width !== wpx || cv.height !== hpx) { cv.width = wpx; cv.height = hpx; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(cv.width / PAD_W, 0, 0, cv.height / PAD_H, 0, 0);
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.lineWidth = 3.4;
    for (const s of strokes) {
      ctx.strokeStyle = INKS[s.c];
      ctx.stroke(new Path2D(strokePath(s.p)));
    }
    hint.textContent = full ? "This card is full" : "Doodle here";
    hint.hidden = !full && strokes.length > 0;
  }
  function pt(ev) {
    const r = cv.getBoundingClientRect();
    return [
      Math.round(Math.min(PAD_W, Math.max(0, (ev.clientX - r.left) / r.width * PAD_W))),
      Math.round(Math.min(PAD_H, Math.max(0, (ev.clientY - r.top) / r.height * PAD_H))),
    ];
  }
  cv.addEventListener("pointerdown", (ev) => {
    if (total >= MAX_POINTS || strokes.length >= MAX_STROKES) { full = true; draw(); return; }
    ev.preventDefault();
    cv.setPointerCapture(ev.pointerId);
    S.dragging = true;
    const [x, y] = pt(ev);
    cur = { c: ink, p: [x, y] };
    total++;
    strokes.push(cur);
    draw();
    onChange();
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!cur) return;
    const [x, y] = pt(ev);
    const lx = cur.p[cur.p.length - 2], ly = cur.p[cur.p.length - 1];
    if (Math.hypot(x - lx, y - ly) < 2) return;
    if (total >= MAX_POINTS) { full = true; cur = null; draw(); return; }
    cur.p.push(x, y);
    total++;
    draw();
  });
  const end = () => { cur = null; S.dragging = false; };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  undo.addEventListener("click", () => {
    const s = strokes.pop();
    if (s) total -= s.p.length / 2;
    full = false; draw(); onChange();
  });
  clear.addEventListener("click", () => { strokes = []; total = 0; full = false; draw(); onChange(); });
  const ro = new ResizeObserver(draw);
  ro.observe(cv);
  return {
    el: wrap,
    isEmpty: () => strokes.length === 0,
    value: () => strokes.map((s) => ({ c: s.c, p: s.p.slice() })),
    destroy: () => ro.disconnect(),
  };
}

/* ================= picker: who's on this Wi-Fi ================= */
function makePicker(onChange) {
  const wrap = h("div");
  const lab = h("label", "field");
  lab.append(h("span", "", "To"));
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filter by name";
  input.autocomplete = "off";
  lab.append(input);
  const list = h("div", "picker-list");
  list.setAttribute("role", "listbox");
  wrap.append(lab, list);
  let selected = null;

  function render() {
    const q = input.value.trim().toLowerCase();
    if (selected && selected !== S.me.id && !S.peers.has(selected)) selected = null;
    list.replaceChildren();
    const peers = [...S.peers.values()]
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.pet.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const row = (id, name, pet, note) => {
      const b = button("", "result", () => { selected = id; render(); onChange(); });
      b.setAttribute("role", "option");
      b.setAttribute("aria-pressed", String(selected === id));
      b.append(face(pet), h("span", "", name));
      if (note) b.append(h("span", "note", note));
      list.append(b);
    };
    for (const p of peers) row(p.id, p.name, p.pet, `with ${p.pet.name}`);
    if (!q || "me myself test".includes(q)) row(S.me.id, "Me (test run)", S.me.pet, "your own desktop");
    if (!S.peers.size) {
      const empty = h("div", "empty", "No one else on this Wi-Fi has the app open right now. ");
      empty.append(button("How this works", "linkish", openNearby));
      list.prepend(empty);
    } else if (!peers.length && q) {
      list.prepend(h("div", "empty", "Nobody nearby matches that."));
    }
  }
  input.addEventListener("input", render);
  render();
  return { el: wrap, value: () => selected, refresh: render };
}

/* ================= composer ================= */
function buildComposer(body, { mode, sendLabel, onSend, onCancel }) {
  body.replaceChildren();
  const form = h("div", "stack");
  let picker = null, busy = false;
  const noteEl = document.createElement("textarea");
  const counter = h("div", "counter", `0 / ${NOTE_MAX}`);
  const send = button(sendLabel, "btn primary");
  send.disabled = true;
  const update = () => {
    const hasContent = noteEl.value.trim().length > 0 || !pad.isEmpty();
    send.disabled = busy || !hasContent || (mode === "new" && !picker.value());
    counter.textContent = `${noteEl.value.length} / ${NOTE_MAX}`;
  };
  if (mode === "new") { picker = makePicker(update); form.append(picker.el); }
  const pad = makePad(update);
  const noteLab = h("label", "field");
  noteLab.append(h("span", "", "A tiny note"));
  noteEl.maxLength = NOTE_MAX;
  noteEl.rows = 2;
  noteEl.placeholder = mode === "new" ? "Thinking of you…" : "Write back…";
  noteLab.append(noteEl);
  noteEl.addEventListener("input", update);
  form.append(pad.el, noteLab, counter);
  const actions = h("div", "actions");
  const cancel = button(mode === "new" ? "Cancel" : "Back", "btn", () => { pad.destroy(); onCancel(); });
  send.addEventListener("click", async () => {
    busy = true; update();
    const ok = await onSend({
      to: picker ? picker.value() : null,
      note: noteEl.value.trim().slice(0, NOTE_MAX),
      doodle: pad.value(),
    });
    busy = false;
    if (ok) pad.destroy(); else update();
  });
  actions.append(cancel, send);
  form.append(actions);
  body.append(form);
  return { refresh: () => { if (picker) picker.refresh(); update(); } };
}

function openWrite() {
  if (!S.ready) return;
  const pet = myPet();
  const w = openWindow("Write a note", { wide: true, kind: "compose" });
  const c = buildComposer(w.body, {
    mode: "new",
    sendLabel: `Give it to ${pet.name}`,
    onCancel: () => w.close(),
    onSend: async ({ to, note, doodle }) => {
      if (!to) return false;
      const res = await call("send", { to, note, doodle });
      if (!res) return false;
      S.notes.set(res.note.id, res.note);
      rebuild();
      w.close();
      if (isAway()) toast(`${pet.name} is out right now and will take this next.`);
      else if (returned().length) toast(`Read the reply ${pet.name} brought back, then it’ll head out with this one.`);
      else toast(`Left it on the floor for ${pet.name}. It’ll trot over and set off.`);
      refreshAll();
      return true;
    },
  });
  w.refresh = () => { if (w.kind === "compose") c.refresh(); };
}

/* ================= postcards & readers ================= */
function stamp(pet) {
  const s = h("div", "stamp");
  const inner = h("div", "inner");
  inner.innerHTML = petSVG(pet.species, pet.color);
  s.append(inner);
  return s;
}
function postcard({ note, doodle, wave, sig, pet, small }) {
  const c = h("div", "postcard" + (small ? " small" : ""));
  if (pet && !small) c.append(stamp(pet));
  if (wave) c.append(h("div", "wave", "👋 waved back"));
  if (doodle && doodle.length) c.append(doodleSVG(doodle));
  c.append(h("p", "hand", note || ""));
  if (sig) c.append(h("div", "sig", sig));
  return c;
}
function doneButton(w) {
  const a = h("div", "actions");
  a.append(button("Done", "btn primary", () => w.close()));
  return a;
}

function openReceived(note) {
  const vp = petOfNote(note);
  const fromName = isSelf(note.peerId) ? "you" : note.peerName;
  const title = isSelf(note.peerId) ? "A note from you (test run)" : `A note from ${fromName}`;
  const e = entities.get("v:" + note.id);
  if (e) { e.scripted = true; e.target = null; say(e, "for you!", 1600); }
  const release = () => {
    const ee = entities.get("v:" + note.id);
    if (ee && !ee.leaving) { ee.scripted = false; ee.idleUntil = performance.now() + 1200; }
  };
  const w = openWindow(title, { wide: true, kind: "read", onClose: release });
  if (note.status === "arrived") bridge.call("open", { id: note.id });

  const showCard = () => {
    w.setTitle(title);
    w.body.replaceChildren();
    w.body.append(postcard({
      note: note.note, doodle: note.doodle, pet: vp,
      sig: `from ${fromName}, carried by ${vp.name}`,
    }));
    const live = S.notes.get(note.id) || note;
    const canReply = live.status === "arrived" || live.status === "read";
    const a = h("div", "actions");
    if (!canReply) {
      a.append(h("span", "small muted", live.status === "recalled"
        ? `${vp.name} was called home before you replied.` : "You already replied."));
    } else {
      const waveBtn = button("Just wave back", "btn", async () => {
        waveBtn.disabled = true;
        if (await sendReply(live, { wave: true })) w.close();
        else waveBtn.disabled = false;
      });
      const write = button("Write back", "btn primary", () => {
        w.setTitle(`Write back to ${fromName}`);
        buildComposer(w.body, {
          mode: "reply",
          sendLabel: `Send ${vp.name} home`,
          onCancel: showCard,
          onSend: async ({ note: text, doodle }) => {
            const ok = await sendReply(live, { note: text, doodle, wave: false });
            if (ok) w.close();
            return ok;
          },
        });
      });
      a.append(waveBtn, write);
    }
    w.body.append(a);
  };
  showCard();
}

async function sendReply(note, reply) {
  const e = entities.get("v:" + note.id);
  if (e) {
    e.leaving = true; e.scripted = true; e.target = null; e.onArrive = null;
    setCarry(e, "reply", note.id);
  }
  const res = await call("reply", { id: note.id, reply });
  if (!res) {
    if (e && entities.has(e.key)) { e.leaving = false; e.scripted = false; setCarry(e, "letter", note.id); }
    refreshAll();
    return false;
  }
  const vp = petOfNote(note);
  if (e && entities.has(e.key)) {
    say(e, "♪", 1000);
    setTimeout(() => { if (entities.has(e.key)) exitEntity(e); }, 900);
  }
  const online = isOnline(note.peerId);
  toast(online
    ? `${vp.name} tucked your ${reply.wave ? "wave" : "reply"} away and is heading home.`
    : `${vp.name} is holding your reply until ${note.peerName} comes back online.`);
  refreshAll();
  return true;
}

function openReturned(note) {
  const pet = myPet();
  const who = isSelf(note.peerId) ? "You" : note.peerName;
  const r = note.reply || { note: "", doodle: [], wave: false };
  const w = openWindow(r.wave ? `${who} waved back` : `${who} wrote back`, { wide: true, kind: "read" });
  w.body.append(postcard({
    note: r.note, doodle: r.doodle, wave: r.wave, pet,
    sig: `from ${isSelf(note.peerId) ? "you" : who}, carried home by ${pet.name}`,
  }));
  w.body.append(h("div", "label", "Your note"));
  w.body.append(postcard({ note: note.note, doodle: note.doodle, small: true }));
  w.body.append(doneButton(w));
  const me = entities.get("mine");
  if (me && me.carryId === note.id) { setCarry(me, null); say(me, "♥", 1200); }
  if (note.status === "replied") bridge.call("readReply", { id: note.id }).then(refreshAll);
}

function openExchange(note) {
  const out = note.dir === "out";
  const who = isSelf(note.peerId) ? "yourself" : note.peerName;
  const w = openWindow(out ? `Your note to ${who}` : `Note from ${who}`, { wide: true, kind: "read" });
  const carrier = out ? myPet() : petOfNote(note);
  w.body.append(postcard({
    note: note.note, doodle: note.doodle, pet: carrier,
    sig: out ? `from you, carried by ${carrier.name}` : `from ${who}, carried by ${carrier.name}`,
  }));
  if (note.reply) {
    w.body.append(h("div", "label", out ? "Their reply" : "Your reply"));
    w.body.append(postcard({ note: note.reply.note, doodle: note.reply.doodle, wave: note.reply.wave, small: true }));
  }
  w.body.append(doneButton(w));
}

/* ================= mailbag ================= */
function lastActivity(n) {
  return Math.max(n.createdAt, n.sentAt, n.deliveredAt, n.openedAt, n.repliedAt, n.readAt, n.recalledAt,
    n.status === "replied" ? n.returnAt : 0);
}
function openMailbag() {
  if (!S.ready) return;
  const w = openWindow("Mailbag", { wide: true, kind: "bag" });
  w.refresh = () => {
    const list = [...S.notes.values()]
      .filter((n) => !(n.dir === "in" && n.status === "incoming"))
      .sort((a, b) => lastActivity(b) - lastActivity(a))
      .slice(0, 80);
    const next = document.createElement("div");
    if (!list.length) {
      next.append(h("p", "", "No notes yet. Write one and your pet will carry it off the edge of your screen to a friend on this Wi-Fi."));
      const a = h("div", "actions left");
      a.append(button("Write a note", "btn primary", openWrite));
      next.append(a);
    } else {
      const ul = h("ul", "rows");
      for (const n of list) ul.append(mailRow(n));
      next.append(ul);
      next.append(h("p", "small muted", `Pets take about ${Math.round(S.travelMs / 1000)} seconds to walk between desktops.`));
    }
    if (next.innerHTML === w.body.innerHTML) return;
    const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : "";
    w.body.replaceChildren(...next.childNodes);
    if (focusedKey) {
      const again = w.body.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`);
      if (again) again.focus();
    }
  };
  w.refresh();
}
function mailRow(n) {
  const out = n.dir === "out";
  const self = isSelf(n.peerId);
  const who = self ? "yourself" : n.peerName;
  const mine = myPet();
  const theirPet = petOfNote(n);
  const li = h("li", "row");
  li.append(face(out ? theirPet : theirPet));
  const mid = h("div");
  mid.append(h("div", "row-title", self ? (out ? "Test note to yourself" : "Your test note") : out ? `To ${who}` : `From ${who}`));
  const actions = h("div", "row-actions");
  const btn = (label, fn, primary = false, key = "") => {
    const b = button(label, "btn small" + (primary ? " primary" : ""), fn);
    b.dataset.key = n.id + ":" + (key || label);
    actions.append(b);
  };
  let sub;
  if (out && n.status === "waiting") {
    sub = isOnline(n.peerId)
      ? `Waiting for ${mine.name} to pick it up`
      : `${who} is offline. ${mine.name} will go as soon as they’re back`;
    btn("View", () => openExchange(n));
    btn("Take it back", () => takeBack(n));
  } else if (out && n.status === "travelling") {
    sub = `${mine.name} is walking over`;
    btn("View", () => openExchange(n));
  } else if (out && (n.status === "delivered" || n.status === "reading")) {
    sub = n.status === "reading" ? `${self ? "You’re" : who + " is"} reading it` : `${mine.name} is waiting on ${possessive(who, self)} desktop`;
    btn("View", () => openExchange(n));
    if (!self) btn(`Call ${mine.name} home`, () => recall(n), false, "recall");
  } else if (out && n.status === "replied" && now() < n.returnAt) {
    sub = `${mine.name} is walking home with a reply`;
  } else if (out && n.status === "replied") {
    sub = `${mine.name} brought back a reply`;
    li.classList.add("hot");
    btn("Read reply", () => openReturned(n), true);
  } else if (out && n.status === "recalled") {
    const back = now() >= n.returnAt;
    sub = back ? `You called ${mine.name} home` : `${mine.name} is walking home`;
    btn("View", () => openExchange(n));
    if (back) btn("Remove", () => removeNote(n));
  } else if (out) {
    sub = n.reply ? (n.reply.wave ? `${who} waved back` : `${who} replied`) : "Finished";
    btn("View", () => openExchange(n));
    btn("Remove", () => removeNote(n));
  } else if (n.status === "arrived" || n.status === "read") {
    sub = `${theirPet.name} is waiting on your desktop for a reply`;
    li.classList.add("hot");
    btn("Read", () => openReceived(n), true);
  } else if (n.status === "recalled") {
    sub = `${who} called ${theirPet.name} home before you replied`;
    btn("View", () => openExchange(n));
    btn("Remove", () => removeNote(n));
  } else {
    sub = n.replyPending ? `${theirPet.name} is holding your reply until ${who} is back` : "You replied";
    btn("View", () => openExchange(n));
    if (!n.replyPending) btn("Remove", () => removeNote(n));
  }
  const subEl = h("div", "row-sub", sub);
  subEl.append(h("span", "", ` (${ago(lastActivity(n))})`));
  mid.append(subEl);
  li.append(mid, actions);
  return li;
}
async function recall(n) {
  const res = await call("recall", { id: n.id });
  if (res) toast(`${myPet().name} is walking home.`);
  refreshAll();
}
async function takeBack(n) {
  const me = entities.get("mine");
  const res = await call("takeBack", { id: n.id });
  if (!res) return;
  S.notes.delete(n.id);
  rebuild();
  if (me && me.carryId === n.id) {
    me.tripToken = null; me.leaving = false; me.scripted = false;
    me.target = null; me.onArrive = null;
    setCarry(me, null);
    say(me, "oh, okay", 1400);
  }
  refreshAll();
}
async function removeNote(n) {
  const res = await call("remove", { id: n.id });
  if (res) { S.notes.delete(n.id); rebuild(); }
  refreshAll();
}

/* ================= nearby friends ================= */
function openNearby() {
  if (!S.ready) return;
  const w = openWindow("Nearby friends", { wide: true, kind: "nearby" });
  const body = w.body;
  body.append(h("p", "", "Anyone on this Wi-Fi with Pen-pal Pet open shows up here. There’s no sign-up and nothing to add: open the app on both computers and you can send notes."));
  const listHost = h("div");
  body.append(listHost);
  const tip = h("p", "small muted", "");
  body.append(tip);
  const toggleRow = h("div", "actions left");
  const toggle = button("", "btn small", async () => {
    const on = !S.me.acceptAnyone;
    const res = await call("setAcceptAnyone", { on });
    if (res) { S.me.acceptAnyone = on; w.refresh(); }
  });
  toggleRow.append(toggle);
  body.append(toggleRow);

  w.refresh = () => {
    const peers = [...S.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
    const next = document.createElement("div");
    if (!peers.length) {
      next.append(h("p", "muted", "Nobody nearby right now."));
    } else {
      const ul = h("ul", "rows");
      for (const p of peers) {
        const li = h("li", "row");
        const mid = h("div");
        const title = h("div", "row-title", p.name);
        if (p.verified) title.append(h("span", "verified-tick", " ✓"));
        mid.append(title,
          h("div", "row-sub", `${p.pet.name} the ${SPECIES_LABEL[p.pet.species].toLowerCase()}`));
        if (p.safety) {
          const code = h("div", "safety" + (p.verified ? " ok" : ""));
          code.append(
            h("span", "safety-label", p.verified ? "Checked:" : "Safety code:"),
            h("code", "safety-code", p.safety)
          );
          mid.append(code);
        }
        const acts = h("div", "row-actions");
        if (!p.verified) {
          const check = button("Check", "btn small", () => openSafetyCheck(p));
          check.title = "Compare the four words with your friend";
          acts.append(check);
        }
        const write = button("Write", "btn small primary", openWrite);
        write.dataset.key = p.id + ":write";
        acts.append(write);
        li.append(face(p.pet), mid, acts);
        ul.append(li);
      }
      next.append(ul);
    }
    if (next.innerHTML !== listHost.innerHTML) listHost.replaceChildren(...next.childNodes);
    tip.textContent = peers.length
      ? "If someone is missing, check they’re on the same Wi-Fi with the app running."
      : "Both computers need the same Wi-Fi and the app open. On the first run, allow Pen-pal Pet through the firewall when your computer asks, and pick the private or home network option.";
    toggle.textContent = S.me.acceptAnyone
      ? "Accepting notes from anyone on this Wi-Fi"
      : "Only accepting notes from people you’ve written to";
  };
  w.refresh();
}

/* ================= safety codes ================= */
/**
 * Both computers work out the same four words from each other's keys. If the
 * words match on both screens, nobody is sitting in the middle. Skipping this
 * still lets notes flow — it only downgrades what the app can promise.
 */
function openSafetyCheck(peer) {
  const w = openWindow(`Is this really ${peer.name}?`, { kind: "safety" });
  const body = w.body;
  body.append(h("p", "", `Ask ${peer.name} to open Nearby friends on their computer and read out the four words next to your name. They should be exactly these:`));
  const big = h("div", "safety-big");
  big.append(h("code", "", peer.safety || "—"));
  body.append(big);
  body.append(h("p", "small muted", "If the words are different, someone else on this Wi-Fi is pretending to be them. Don’t send anything private."));

  const acts = h("div", "actions");
  acts.append(button("They match", "btn primary", async () => {
    const res = await call("verifyFriend", { id: peer.id });
    if (res) {
      toast(`${peer.name} is confirmed.`);
      w.close(true);
    }
  }));
  acts.append(button("Not now", "btn", () => w.close(true)));
  body.append(acts);
}

/** Someone is announcing a friend's identity with the wrong keys. */
function openImpostorWarning(ev) {
  const w = openWindow("Something is wrong", { kind: "impostor" });
  const body = w.body;
  body.append(h("p", "warn-text",
    `Another computer on this Wi-Fi is claiming to be ${ev.name}, but its keys don’t match the ${ev.name} you met before.`));
  body.append(h("p", "",
    ev.wasVerified
      ? "You checked this friend's safety code before, so this is unlikely to be a genuine reinstall. Nothing has been sent to them, and nothing will be."
      : "This usually means they reinstalled the app — but it can also mean someone is impersonating them. Nothing has been sent to them."));
  body.append(h("p", "small muted",
    "If you know they reinstalled, forget them here and you'll meet them fresh. Check the new safety code together afterwards."));

  const acts = h("div", "actions");
  acts.append(button("Keep blocking them", "btn primary", () => w.close(true)));
  acts.append(button(`${ev.name} did reinstall — forget and re-meet`, "btn", async () => {
    const res = await call("forgetFriend", { id: ev.id });
    if (res) {
      toast(`Forgot ${ev.name}. They'll reappear as a new friend shortly.`);
      w.close(true);
    }
  }));
  body.append(acts);
}

/* ================= pet editor and first run ================= */
function petChooser(body, initial, onChange) {
  const pick = Object.assign({}, initial);
  const preview = h("div", "preview");
  body.append(preview);
  body.append(h("div", "label", "Creature"));
  const choices = h("div", "choices");
  choices.setAttribute("role", "group");
  choices.setAttribute("aria-label", "Creature");
  const speciesBtns = Object.keys(SPECIES_SVG).map((sp) => {
    const b = button("", "choice", () => { pick.species = sp; paint(); });
    b.dataset.sp = sp;
    b.append(h("span", "", SPECIES_LABEL[sp]));
    choices.append(b);
    return b;
  });
  body.append(choices);
  body.append(h("div", "label", "Color"));
  const colors = h("div", "colors");
  colors.setAttribute("role", "group");
  colors.setAttribute("aria-label", "Color");
  const colorBtns = Object.keys(COLORS).map((c) => {
    const b = button("", "swatch", () => { pick.color = c; paint(); });
    b.style.background = COLORS[c].body;
    b.setAttribute("aria-label", COLORS[c].label);
    colors.append(b);
    return { b, c };
  });
  body.append(colors);
  const nameLab = h("label", "field");
  nameLab.style.marginTop = "14px";
  nameLab.append(h("span", "", "Pet’s name"));
  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.maxLength = 16;
  nameIn.placeholder = "Biscuit";
  nameIn.value = initial.name || "";
  nameLab.append(nameIn);
  body.append(nameLab);
  function paint() {
    preview.innerHTML = petSVG(pick.species, pick.color);
    speciesBtns.forEach((b) => {
      const old = b.querySelector("svg");
      if (old) old.remove();
      b.insertAdjacentHTML("afterbegin", petSVG(b.dataset.sp, pick.color));
      b.setAttribute("aria-pressed", String(b.dataset.sp === pick.species));
    });
    colorBtns.forEach(({ b, c }) => b.setAttribute("aria-pressed", String(c === pick.color)));
    onChange();
  }
  nameIn.addEventListener("input", onChange);
  setTimeout(paint);
  return { value: () => ({ species: pick.species, color: pick.color, name: (nameIn.value.trim() || "Biscuit").slice(0, 16) }) };
}

function openPetEditor() {
  if (!S.ready) return;
  const w = openWindow("My pet", { kind: "pet" });
  const youLab = h("label", "field");
  youLab.append(h("span", "", "Your name (friends nearby see this)"));
  const youIn = document.createElement("input");
  youIn.type = "text";
  youIn.maxLength = 40;
  youIn.value = S.me.name;
  youLab.append(youIn);
  w.body.append(youLab);
  const chooser = petChooser(w.body, S.me.pet, () => {});
  const save = button("Save changes", "btn primary", async () => {
    save.disabled = true;
    const pet = chooser.value();
    const name = youIn.value.trim() || S.me.name;
    const res = await call("setProfile", { name, pet });
    save.disabled = false;
    if (!res) return;
    w.close();
    toast(`Saved. ${pet.name} looks great.`);
  });
  const a = h("div", "actions");
  a.append(save);
  w.body.append(a);
}

function openSetup() {
  if (S.win && S.win.kind === "setup") return;
  const w = openWindow("Welcome to Pen-pal Pet", { kind: "setup", closable: false });
  const body = w.body;
  body.append(h("p", "", "Your pet lives along the bottom of this window. Hand it a doodle or a note and it walks off the edge to a friend’s computer, then comes back with their reply."));
  body.append(h("p", "small muted", "Notes travel straight between computers on the same Wi-Fi. No accounts, no server, nothing leaves your network."));
  const youLab = h("label", "field");
  youLab.append(h("span", "", "Your name (friends nearby see this)"));
  const youIn = document.createElement("input");
  youIn.type = "text";
  youIn.maxLength = 40;
  youIn.placeholder = "Priya";
  youLab.append(youIn);
  body.append(youLab);
  body.append(h("div", "label", "Your pet"));
  const go = button("Adopt Biscuit", "btn primary");
  const chooser = petChooser(body, { species: "cat", color: "honey", name: "" }, () => {
    go.textContent = `Adopt ${chooser.value().name}`;
  });
  const err = h("p", "error");
  const a = h("div", "actions");
  a.append(button("Quit", "btn", () => bridge.quit()), h("span", "grow"), go);
  body.append(err, a);
  go.addEventListener("click", async () => {
    const name = youIn.value.trim();
    if (!name) { err.textContent = "Add your name so friends know who sent the note."; youIn.focus(); return; }
    go.disabled = true;
    const pet = chooser.value();
    const res = await call("setProfile", { name, pet });
    if (!res) { go.disabled = false; return; }
    w.close(true);
    toast(`${pet.name} has moved in. Click ${pet.name} to write your first note.`);
  });
}

/* ================= wiring ================= */
function applyState(s) {
  if (!s) return;
  S.travelMs = s.travelMs || S.travelMs;
  const wasReady = S.ready;
  S.me = s.me;
  S.ready = !!(s.me && s.me.ready);
  S.peers = new Map((s.peers || []).map((p) => [p.id, p]));
  S.notes = new Map((s.notes || []).map((n) => [n.id, n]));
  rebuild();
  if (!S.ready) {
    openSetup();
  } else {
    if (!wasReady && S.win && S.win.kind === "setup") S.win.close(true);
    for (const n of S.inn) {
      if ((n.status === "arrived" || n.status === "read") && now() - n.arriveAt > 10 * 60 * 1000) S.seenVisitors.add(n.id);
    }
  }
  refreshAll();
}
bridge.onState(applyState);
bridge.onEvent((ev) => {
  if (!ev) return;
  if (ev.kind === "deliveryFailed" && ev.refused) toast(`${ev.name} isn’t accepting notes from new people right now.`, true);
  else if (ev.kind === "peerOnline" && S.ready) toast(`${ev.name} is nearby with ${ev.petName}.`);
  else if (ev.kind === "impostor" && S.ready) {
    // Never quietly accept this: it is the one signal of an active attack.
    toast(`Blocked someone pretending to be ${ev.name}.`, true);
    notify("Pen-pal Pet", `Blocked someone pretending to be ${ev.name}.`);
    if (!S.win) openImpostorWarning(ev);
  } else if (ev.kind === "error") toast(ev.message, true);
});
bridge.onCommand((c) => {
  if (!S.ready) { openSetup(); return; }
  if (c === "write") openWrite();
  else if (c === "mailbag") openMailbag();
  else if (c === "friends") openNearby();
  else if (c === "pet") openPetEditor();
});
$("floor-mail").addEventListener("click", () => {
  const n = waiting()[0];
  if (n && !isOnline(n.peerId)) toast(`${myPet().name} is waiting for ${n.peerName} to come online.`);
  else toast(`${myPet().name} will pick this up soon.`);
});
addEventListener("resize", () => {
  const W = stageW();
  for (const e of entities.values()) {
    if (!e.leaving && e.target == null && (e.x < 40 || e.x > W - 40)) e.x = Math.min(W - 60, Math.max(60, e.x));
  }
  renderFloorMail();
});

async function boot() {
  requestAnimationFrame(frame);
  renderClock();
  setInterval(renderClock, 10000);
  setInterval(refreshAll, 1000);
  applyState(await bridge.getState());
}
boot();
})();
