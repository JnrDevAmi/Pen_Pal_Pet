<p align="center">
  <img src="banner.svg" alt="Pen-pal Pet - notes that walk across your Wi-Fi" width="100%">
</p>

<p align="center">
  <b>No server · No accounts · No internet access</b>
</p>

# Pen-pal Pet

A small pet lives along the bottom of the Pen-pal Pet window. Hand it a doodle
or a note, and it walks off the edge of the window and onto a friend's
computer, where it waits until they read it. Then it walks home with their
reply.

Notes travel straight from one computer to the other over your Wi-Fi. There is
no server, no account, no sign-up, and nothing to keep running: install the app
on two computers on the same network and you can send notes.

## Install  ·  Windows only

### ➜ **[Download](https://github.com/JnrDevAmi/Pen_Pal_Pet/releases/latest)**

1. Download the zip and **unzip it**
2. Double-click **`Pen-pal-Pet-Setup-2.0.0.exe`**
3. Windows says *"Windows protected your PC"* — click **More info** →
   **Run anyway**. It only means the app isn't code-signed.
4. **I Agree** → **Next** → pick a folder → **Install** → **Finish**
5. Type your name and choose a pet
6. When Windows asks about the firewall, tick **Private networks** and allow it

That's it — no administrator password, nothing else to install. Do the same on
a second computer on the same Wi-Fi and the two find each other by themselves.

**Rather not install anything?** `Pen-pal-Pet-2.0.0-portable.exe` runs straight
from the file and works from a USB stick.

**To remove it:** Settings → Apps → Pen-pal Pet → Uninstall. Your notes are
kept in case you reinstall; delete `%APPDATA%\Pen-pal Pet` to clear those too.

## Using it

1. Use the shortcuts down the left: **Write a note**, **Mailbag**, **Add a pen
   pal**, **My pet**. Clicking the pet itself works too, as does the tray icon.
2. **Write a note**: pick whoever is nearby, doodle something, add a few words,
   and hand it to your pet.
3. Your pet dawdles for a moment, then walks off the edge of the window.
4. A few seconds later it walks into your friend's window carrying an envelope.
   They click it, read it, and choose **Write back** or **Just wave back**.
5. Your pet walks back in with a yellow envelope. Click it to read the reply.

Other things worth knowing:

- **Me (test run)** in the "To" list sends a note to yourself, so you can watch
  the whole trip without a second computer — your pet walks off, comes back as
  a visitor, and you can reply to yourself.
- If your friend's computer is asleep, the note **waits in the satchel** and goes
  out by itself as soon as they're back on the Wi-Fi.
- If they never reply, **Call home** in the Mailbag brings your pet back.
- Closing the window leaves the app running in the tray, so notes still arrive.
  Quit properly from the tray menu when you want it to stop.
- The tray menu can start the app at login and stop strangers on the same
  network from sending you notes.

## Safety codes

Open **Nearby friends** and each person shows four words underneath their name —
something like `otter-lantern-brisk-fig`. Both computers work those words out
independently from each other's keys, so they match only if you are really
talking to each other.

Read them aloud once, press **Check**, and that friend gets a ✓. You never have
to do it again, and notes work fine if you skip it — checking only upgrades what
the app can promise from "encrypted" to "encrypted, and definitely them".

If a computer ever claims to be a friend you've already met but its keys don't
match, the app **blocks it and tells you**. Nothing is sent. If your friend
genuinely reinstalled, you can forget them from that warning and meet them
again fresh.

## Privacy and security

- Notes never leave your local network, and no copy is stored anywhere else.
  The app makes no internet connections at all — there is nothing to opt out of.
- **Your identity can't be borrowed.** Your ID is a fingerprint of your own
  signing key, so claiming to be someone else would mean holding their key.
- **Everything is signed.** Every announcement and every note carries an Ed25519
  signature. Anything unsigned, mis-signed, stale or repeated is dropped.
- **Everything is encrypted**, with a key derived per pair of friends (X25519 +
  HKDF, AES-256-GCM). Someone sniffing the Wi-Fi sees nothing readable, and a
  captured message can't be replayed or redirected.
- The app only accepts connections from computers on your own networks, and the
  listener caps connections and times out anything that dawdles.
- **Your keys are sealed on disk** with Windows' own encryption, so copying
  `identity.json` to another computer yields nothing usable.
- Everything is kept in two small files in the app's own folder: `identity.json`
  and `notes.json`.

What it still doesn't do: **display names aren't unique**. Anyone can call
themselves "Priya" — they simply arrive as a *separate* person with a different
safety code, not as your Priya. Checking the code once is what tells the two
apart.

## Limits

- **Same Wi-Fi only.** Both computers must be on the same network. This is not a
  way to reach a friend across town.
- **The app must be running on both computers** for a note to be handed over.
  It sits in the tray and can start automatically at login.
- Some networks block the discovery messages between devices, usually guest
  Wi-Fi and larger corporate networks with "client isolation" switched on. On
  those, friends won't appear in the list.

## Using this code

No licence is granted. The source is here to read, and to build for yourself if
you want to; it is not offered for redistribution or reuse. If you would like to
do something with it, ask.

## For developers only

Everything below is for changing the app. **If you just want to use it, stop
here** and take the download at the top — you do not need Node, npm, or any of
this.

<details>
<summary>Building from source</summary>

```bash
cd app
npm install
npm start               # run it from source

npm run dist:portable   # single portable .exe, nothing to install
npm run dist            # the setup wizard
```

macOS and Linux targets were removed rather than left in untested. Adding them
back means building on those machines and checking the window, the tray and the
keystore actually work.

### Publishing a version

Tag it, and GitHub Actions runs the tests, builds the Windows installer, and
publishes a release with it attached:

```bash
git tag v2.0.0
git push origin v2.0.0
```

The tag is what makes a public download link. Running the workflow by hand
instead puts the files in the run's Artifacts, which is fine for checking a
build but no use to anyone else: those need a GitHub login and expire.

</details>

<details>
<summary>Testing</summary>

### Two peers on one machine

Each copy needs its own identity, which means its own data folder:

```bash
cd app
npm run peer:a      # first window
npm run peer:b      # second window
```

As far as the app is concerned those are separate installs — different keys,
different IDs, real sockets between them — so they discover each other, show
each other's safety codes, and hand notes over exactly as two computers would.
Their data lives in `app/.peers/a` and `app/.peers/b`.

### The suites

The tests drive real peers over real sockets — real UDP multicast, real HTTP,
real key exchange. No Electron needed; they run on plain Node.

```bash
cd app && npm test          # everything, in order
npm run test:stress         # load, flood, churn, bounded memory
npm run test:multiproc      # 30 peers in separate processes
```

`npm test` covers the renderer too, which needs Electron installed. Without
`node_modules` the rest still runs on plain Node and that suite is skipped.

| File | What it proves |
| --- | --- |
| `test/06-units.js` | Sanitisers and crypto primitives |
| `test/07-ipc.js` | The one door from the page into privileged code |
| `test/08-hardening.js` | Sandbox, CSP, permissions, key leakage, build contents |
| `test/00-discovery.js` | Two peers find each other over the network |
| `test/01-roundtrip.js` | Send, deliver, open, reply, return |
| `test/02-edges.js` | Self-send, recall, refusal, offline queueing, restart |
| `test/03-attacks.js` | Forged beacons, replays, tampering, hostile input |
| `test/04-stress.js` | Many peers, note floods, churn, memory bounds |
| `test/09-renderer.js` | The real page: every screen, hostile content, XSS |
| `test/05-multiproc.js` | Realistic scaling, one peer per process |

</details>

<details>
<summary>What's inside</summary>

```
app/
  main.js        the app window, tray menu, app plumbing
  net.js         finding friends on the Wi-Fi and handing notes over
  actions.js     the only things the page may ask the app to do
  crypto.js      identities, signatures, message keys, safety codes
  store.js       the two small files on disk
  preload.js     the narrow bridge between the two halves
  renderer/      the home page, the pets, the paper windows, the doodle pad
test/            real-socket tests, from unit to adversarial
banner.svg       the animated README banner (self-contained, no requests)
```

</details>
