import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { buildState } from "../scripts/floor-state.mjs";
import { buildModel, tally } from "../site/floor.js";

const fixture = JSON.parse(fs.readFileSync("test/fixtures/floor-inputs.json", "utf8"));
const get = (s, n) => s.items.find((i) => i.number === n);
const issue = (number, labels, comments = []) => ({ number, title: "t", state: "open", url: `u${number}`, labels, comments });
const started = (n, thread, at) => ({ body: `Build started, attempt ${n}: thread \`${thread}\` http://x/${thread}`, createdAt: at });

test("fixture items, order and values", () => {
  const s = buildState(fixture);
  assert.deepEqual(s.items.map((i) => i.number), [10, 11, 12, 14, 15, 21]);
  assert.deepEqual(Object.keys(s), ["phases", "items"]);
  assert.deepEqual(Object.keys(s.items[0]), ["number", "title", "phase", "status", "strikes", "thread_url", "issue_url", "started_at", "defect"]);
  assert.equal(get(s, 21).phase, "backlog");
  assert.equal(get(s, 21).status, "waiting");
  const a = get(s, 11);
  assert.deepEqual([a.phase, a.status, a.thread_url, a.started_at], ["intake", "running", "http://localhost/threads/thr_a", "2026-01-01T00:05:00Z"]);
  assert.deepEqual([get(s, 12).phase, get(s, 12).status, get(s, 12).strikes], ["build", "waiting", 2]);
  assert.deepEqual([get(s, 14).phase, get(s, 14).status, get(s, 14).strikes, get(s, 14).thread_url], ["review", "failed", 5, null]);
  assert.deepEqual([get(s, 10).phase, get(s, 10).status], ["release", "merged"]);
  assert.equal(get(s, 12).defect, "Gate failed: missing test");
  assert.equal(get(s, 15).defect, null);
});

test("defect survives a missing report and is cleared by a passing one", () => {
  const run = (reports) => get(buildState({ issues: [issue(1, ["factory", "factory:build"])], reports }), 1).defect;
  const bad = { issue: 1, attempt: 1, kind: "gate", ok: false, text: "bad" };
  assert.equal(run([bad]), "bad");
  assert.equal(run([bad]), "bad");
  assert.equal(run([bad, { issue: 1, attempt: 2, kind: "gate", ok: true, text: "" }]), null);
  assert.equal(run([{ issue: 1, attempt: 1, kind: "gate", ok: true, text: "" }, { issue: 1, attempt: 1, kind: "review", ok: false, text: "rev" }]), "rev");
});

test("merged items stay and tally counts them", () => {
  const s = buildState(fixture);
  assert.ok(get(s, 10));
  assert.deepEqual(tally(s.items), { merged: 1, failed: 1, retried: 2 });
});

test("output feeds buildModel and overflow appears once", () => {
  assert.doesNotThrow(() => buildModel(buildState(fixture), Date.parse(fixture.now)));
  const issues = [11, 12, 13].map((n) => issue(n, ["factory", "factory:intake"], [started(1, `thr_${n}`, "2026-01-01T00:00:00Z")]));
  const threads = { thr_11: "running", thr_12: "running", thr_13: "running" };
  const s = buildState({ issues, threads });
  const model = buildModel(s, 0);
  const text = JSON.stringify(model);
  for (const n of [11, 12, 13]) assert.equal(text.split(`"number":${n},`).length - 1, 1);
});

test("input variants", () => {
  assert.deepEqual(buildState({ issues: [], threads: {}, reports: [] }).items, []);
  assert.equal(get(buildState({ issues: [issue(1, ["factory"])] }), 1).strikes, 0);
  assert.equal(get(buildState({ issues: [issue(1, ["factory", "strike:1", "strike:3"])] }), 1).strikes, 3);
  const two = issue(1, ["factory", "factory:build"], [started(1, "thr_old", "2026-01-01T00:00:00Z"), started(2, "thr_new", "2026-01-01T00:05:00Z")]);
  const r = get(buildState({ issues: [two], threads: { thr_old: "running", thr_new: "running" } }), 1);
  assert.equal(r.thread_url, "http://x/thr_new");
  assert.equal(r.started_at, "2026-01-01T00:05:00Z");
  const idle = get(buildState({ issues: [two], threads: { thr_new: "idle" } }), 1);
  assert.deepEqual([idle.status, idle.thread_url, idle.started_at], ["waiting", null, null]);
  assert.deepEqual([get(buildState({ issues: [issue(1, ["factory", "factory:failed"])] }), 1).phase], ["backlog"]);
});

test("CLI writes valid JSON, skips unchanged writes, spares site/state.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-"));
  const out = path.join(dir, "state.json");
  const before = fs.readFileSync("site/state.json", "utf8");
  const go = () => execFileSync("node", ["scripts/floor-state.mjs", "--input", "test/fixtures/floor-inputs.json", "--out", out]);
  go();
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).items.length, 6);
  const m = fs.statSync(out).mtimeMs;
  fs.utimesSync(out, 1, 1);
  go();
  assert.equal(fs.statSync(out).mtimeMs, 1000);
  assert.notEqual(m, 1000);
  assert.equal(fs.readFileSync("site/state.json", "utf8"), before);
});

import { parseReport, gatherInputs } from "../scripts/floor-state.mjs";

const rev = (defects, verdict, extra = "- [x] a\n") => `# Review\n\n## Criteria\n\n${extra}\n## Defects\n\n${defects}\n## Verdict\n\n${verdict}\n`;

test("parseReport review: defect text and verdict", () => {
  assert.deepEqual(parseReport("review", rev("1. `a.js:1` — boom\n2. other\n", "FINDINGS")), { ok: false, text: "`a.js:1` — boom" });
  assert.equal(parseReport("review", rev("- bullet\n", "FINDINGS")).text, "bullet");
  assert.deepEqual(parseReport("review", rev("", "FINDINGS")), { ok: false, text: "review findings" });
  assert.equal(parseReport("review", rev("", "READY")).ok, true);
  assert.equal(parseReport("review", rev("", "READY", "- [x] FINDINGS none\n")).ok, true);
  assert.deepEqual(parseReport("review", "# R\n\n## Criteria\n\n- [x] FINDINGS none\n"), { ok: false, text: "review unreadable" });
  assert.deepEqual(parseReport("review", rev("", "MAYBE")), { ok: false, text: "review unreadable" });
  assert.equal(parseReport("review", "# R\n\n## Verdict\n\n").ok, false);
});

test("parseReport gate", () => {
  assert.equal(parseReport("gate", "# G\n\nResult: **PASS**\n").ok, true);
  assert.deepEqual(parseReport("gate", "# G\n\nResult: **FAIL**\n\n## check: fail\n"), { ok: false, text: "Gate failed: check" });
  assert.deepEqual(parseReport("gate", "# G\n\nResult: **FAIL**\n"), { ok: false, text: "gate failed" });
  assert.equal(parseReport("gate", "# G\n").ok, false);
});

const fakeRun = (over = {}) => (cmd, args) => {
  const key = `${cmd} ${args.slice(0, cmd === "git" ? 1 : 2).join(" ")}`;
  if (key in over) {
    if (over[key] instanceof Error) throw over[key];
    return over[key];
  }
  if (key === "gh issue list") return JSON.stringify([1, 2].map((n) => ({ number: n, title: "t", url: "u", labels: [{ name: "factory" }, { name: "factory:build" }] })));
  if (key === "gh issue view") return JSON.stringify({ comments: [{ body: `Build started, attempt 1: thread \`thr_${args[2]}\` http://x`, createdAt: "2026-01-01T00:00:00Z" }] });
  if (key === "bb thread show") return JSON.stringify({ status: "running" });
  if (key === "bb factory repos") return "[]";
  return "";
};

test("gatherInputs succeeds and maps running", async () => {
  const s = buildState(await gatherInputs(fakeRun()));
  assert.equal(get(s, 1).status, "running");
});

test("gatherInputs rejects on failures and invalid JSON", async () => {
  const boom = new Error("boom");
  for (const key of ["gh issue list", "gh issue view", "bb thread show", "bb factory repos", "git for-each-ref"]) {
    await assert.rejects(gatherInputs(fakeRun({ [key]: boom })), new RegExp(key.split(" ")[0]));
  }
  for (const key of ["gh issue list", "gh issue view", "bb thread show", "bb factory repos"]) {
    await assert.rejects(gatherInputs(fakeRun({ [key]: "not json" })), /invalid JSON/);
  }
  const one = (cmd, args) => {
    if (cmd === "gh" && args[1] === "view" && args[2] === "2") throw new Error("x");
    return fakeRun()(cmd, args);
  };
  await assert.rejects(gatherInputs(one), /issue #2/);
});

test("CLI: missing out dir created, unwritable fails cleanly, failed gather keeps file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "floor-"));
  const inp = ["scripts/floor-state.mjs", "--input", "test/fixtures/floor-inputs.json"];
  const nested = path.join(dir, "a/b/state.json");
  execFileSync("node", [...inp, "--out", nested]);
  JSON.parse(fs.readFileSync(nested, "utf8"));
  fs.writeFileSync(path.join(dir, "file"), "x");
  const r = spawnSync("node", [...inp, "--out", path.join(dir, "file/state.json")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /^\s*at /m);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const keep = path.join(dir, "keep.json");
  fs.writeFileSync(keep, "keep");
  const g = spawnSync("node", ["scripts/floor-state.mjs", "--out", keep], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.notEqual(g.status, 0);
  assert.doesNotMatch(g.stderr, /^\s*at /m);
  assert.equal(fs.readFileSync(keep, "utf8"), "keep");
});
