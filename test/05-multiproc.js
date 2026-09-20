"use strict";
/* The realistic topology: one peer per OS process, the way real machines run. */
const { fork } = require("child_process");
const path = require("path");
const N = Number(process.argv[2] || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`  forking ${N} separate peer processes (one per "machine")...`);
  const kids = [];
  const reports = new Map();
  const ready = new Set();
  const died = [];
  const errs = [];

  for (let i = 0; i < N; i++) {
    const k = fork(path.join(__dirname, "peer-proc.js"), [String(i)], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    });
    k.on("message", (m) => {
      if (m && m.ready) ready.add(m.idx);
      if (m && m.seen !== undefined) reports.set(m.idx, m.seen);
    });
    k.on("exit", (code, sig) => { if (code !== 0) died.push(`#${i} exit=${code} sig=${sig}`); });
    k.on("error", (e) => died.push(`#${i} error=${e.message}`));
    if (k.stderr) {
      k.stderr.on("data", (d) => {
        const first = String(d).trim().split(/\r?\n/)[0];
        if (first) errs.push(`#${i}: ${first}`);
      });
    }
    kids.push(k);
    await sleep(40);
  }

  await sleep(14000);
  for (const k of kids) { try { k.send("report"); } catch (e) { died.push(`send failed: ${e.message}`); } }
  await sleep(6000);

  const seen = [...reports.values()];
  const min = seen.length ? Math.min(...seen) : -1;
  const max = seen.length ? Math.max(...seen) : -1;
  const full = seen.filter((s) => s === N - 1).length;

  console.log(`\n  started ok : ${ready.size}/${N}`);
  console.log(`  reported   : ${seen.length}/${N}`);
  if (died.length) console.log(`  died       : ${died.length} -> ${died.slice(0, 3).join("; ")}`);
  if (errs.length) console.log(`  stderr     : ${errs.length} -> ${errs.slice(0, 3).join(" | ")}`);
  console.log(`  peers seen : min=${min} max=${max} (expected ${N - 1})`);
  console.log(`  ${full}/${seen.length} processes see the whole room`);

  const converged = seen.length === N && min === N - 1;
  console.log(`\n  ${converged ? "FULL CONVERGENCE" : "INCOMPLETE"}`);

  for (const k of kids) { try { k.send("quit"); } catch {} }
  await sleep(1500);
  for (const k of kids) { try { k.kill(); } catch {} }
  process.exit(converged ? 0 : 1);
})();
