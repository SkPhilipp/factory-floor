import test from "node:test";
import assert from "node:assert/strict";
import { barState, tally, orbit, cardHref, buildModel } from "../site/floor.js";

const phase = { timeout_s: 100 };
const t0 = Date.parse("2026-01-01T00:00:00Z");
const item = (o = {}) => ({ number: 1, title: "t", phase: "build", status: "waiting", strikes: 0, thread_url: null, issue_url: "i", started_at: null, defect: null, ...o });

test("barState", () => {
  const it = item({ started_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(barState(it, phase, t0 + 50000), { pct: 50, hot: false });
  assert.equal(barState(it, phase, t0 + 80000).hot, true);
  assert.equal(barState(it, phase, t0 + 500000).pct, 100);
  assert.deepEqual(barState(item(), phase, t0), { pct: 0, hot: false });
});

test("tally", () => {
  const list = [item({ status: "merged" }), item({ status: "failed", strikes: 5 }), item({ strikes: 1 }), item()];
  assert.deepEqual(tally(list), { merged: 1, failed: 1, retried: 1 });
  assert.deepEqual(tally([...list, item({ status: "merged" })]), { merged: 2, failed: 1, retried: 1 });
});

test("orbit clamps", () => {
  const hi = orbit({ rotateX: 50, rotateY: 0 }, 100000, -100000);
  assert.deepEqual(hi, { rotateX: 80, rotateY: 45 });
  const lo = orbit({ rotateX: 50, rotateY: 0 }, -100000, 100000);
  assert.deepEqual(lo, { rotateX: 20, rotateY: -45 });
});

test("cardHref", () => {
  assert.equal(cardHref(item({ thread_url: "th" })), "th");
  assert.equal(cardHref(item()), "i");
});

test("defect survives re-render", () => {
  const state = { phases: [{ id: "build", title: "Build", seats: 1, timeout_s: 100, agent: true }], items: [item({ defect: "bad" })] };
  for (let n = 0; n < 2; n++) assert.equal(buildModel(state, t0)[0].queue[0].model.defect, "bad");
});

test("barState guards", () => {
  const it = item({ started_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(barState(it, { timeout_s: 0 }, t0), { pct: 0, hot: false });
  assert.deepEqual(barState(item({ started_at: "nope" }), phase, t0), { pct: 0, hot: false });
});

test("running overflow goes to queue", () => {
  const run = (n, o = {}) => item({ number: n, status: "running", ...o });
  const state = {
    phases: [
      { id: "build", title: "B", seats: 2, timeout_s: 10, agent: true },
      { id: "review", title: "R", seats: 0, timeout_s: 10, agent: true },
    ],
    items: [run(1), run(2), run(3), run(4, { phase: "review" })],
  };
  const m = buildModel(state, t0);
  assert.equal(m[0].queue.length, 1);
  assert.equal(m[1].queue.length, 1);
  const n = m.reduce((a, c) => a + c.queue.length + c.seats.filter((s) => s.card).length, 0);
  assert.equal(n, 4);
});
