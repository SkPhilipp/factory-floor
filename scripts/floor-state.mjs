import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PHASES = [
  { id: "backlog", title: "Backlog", seats: 0, timeout_s: 0, agent: false },
  { id: "intake", title: "Intake", seats: 1, timeout_s: 600, agent: true },
  { id: "build", title: "Build", seats: 2, timeout_s: 1800, agent: true },
  { id: "review", title: "Review", seats: 1, timeout_s: 900, agent: true },
  { id: "release", title: "Release", seats: 1, timeout_s: 0, agent: false },
];

const STARTED = /^(Intake|Build|Review|Release) started, attempt (\d+)(?::\s*thread `([^`]+)`\s*(\S+))?/;

function newestStarted(comments) {
  let best = null;
  for (const c of comments || []) {
    const m = STARTED.exec(String(c.body || "").trim());
    if (m && (!best || Date.parse(c.createdAt) >= Date.parse(best.createdAt))) {
      best = { phase: m[1].toLowerCase(), thread: m[3] || null, url: m[4] || null, createdAt: c.createdAt };
    }
  }
  return best;
}

function newestReport(reports) {
  let best = null;
  for (const r of reports) {
    const rank = r.attempt * 2 + (r.kind === "review" ? 1 : 0);
    if (!best || rank > best.rank) best = { rank, r };
  }
  return best && best.r;
}

export function buildState(inputs) {
  const { issues = [], threads = {}, reports = [] } = inputs;
  const phases = inputs.phases || DEFAULT_PHASES;
  const items = [];
  for (const issue of issues) {
    const labels = issue.labels || [];
    const factory = labels.filter((l) => l === "factory" || l.startsWith("factory:"));
    if (!factory.length) continue;
    const stage = factory.map((l) => l.slice("factory:".length)).find((s) => s !== "factory" && s);
    const started = newestStarted(issue.comments);
    const strikes = Math.max(0, ...labels.map((l) => /^strike:(\d+)$/.exec(l)).filter(Boolean).map((m) => Number(m[1])));
    let phase = "backlog";
    let status = "waiting";
    if (stage === "done") {
      phase = "release";
      status = "merged";
    } else if (stage === "failed") {
      phase = started ? started.phase : "backlog";
      status = "failed";
    } else if (["intake", "build", "review", "release"].includes(stage)) {
      phase = stage;
    }
    const running = status === "waiting" && started && started.thread && threads[started.thread] === "running";
    if (running) status = "running";
    const report = newestReport(reports.filter((r) => r.issue === issue.number));
    items.push({
      number: issue.number,
      title: issue.title,
      phase,
      status,
      strikes,
      thread_url: running ? started.url : null,
      issue_url: issue.url,
      started_at: running ? started.createdAt : null,
      defect: status !== "merged" && report && !report.ok ? report.text : null,
    });
  }
  items.sort((a, b) => a.number - b.number);
  return { phases, items };
}

const defaultRun = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });

function call(run, what, cmd, args) {
  try {
    return run(cmd, args);
  } catch (e) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed for ${what}: ${String(e.message).split("\n")[0]}`);
  }
}

function callJson(run, what, cmd, args) {
  const out = call(run, what, cmd, args);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} returned invalid JSON for ${what}`);
  }
}

function section(text, heading) {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (i < 0) return null;
  const end = lines.findIndex((l, j) => j > i && /^#{1,2} /.test(l));
  return lines.slice(i + 1, end < 0 ? undefined : end);
}

export function parseReport(kind, text) {
  if (kind === "gate") {
    if (/^Result: \*\*PASS\*\*/m.test(text)) return { ok: true, text: "" };
    const m = /^## (.+?): fail\s*$/m.exec(text);
    return { ok: false, text: m && /^Result: \*\*FAIL\*\*/m.test(text) ? `Gate failed: ${m[1]}` : "gate failed" };
  }
  const verdictLines = section(text, "Verdict");
  const verdict = verdictLines && verdictLines.find((l) => l.trim());
  if (verdict && verdict.trim() === "READY") return { ok: true, text: "" };
  if (!verdict || verdict.trim() !== "FINDINGS") return { ok: false, text: "review unreadable" };
  const item = (section(text, "Defects") || []).find((l) => l.trim());
  const first = item ? item.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "") : "";
  return { ok: false, text: first || "review findings" };
}

function gatherReports(run) {
  const reports = [];
  const refs = ["origin/master"];
  for (const ref of call(run, "refs", "git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).split("\n")) {
    if (/^origin\/(bb\/\d+-.*|factory\/\d+)$/.test(ref)) refs.push(ref);
  }
  for (const ref of refs) {
    for (const kind of ["gate", "review"]) {
      const names = call(run, ref, "git", ["ls-tree", "--name-only", ref, `factory/${kind}s/`]).split("\n").filter(Boolean);
      for (const name of names) {
        const m = /\/(\d+)-(\d+)\.md$/.exec(name);
        if (!m) continue;
        const { ok, text } = parseReport(kind, call(run, `${ref}:${name}`, "git", ["show", `${ref}:${name}`]));
        reports.push({ issue: Number(m[1]), attempt: Number(m[2]), kind, ok, text: text || `${kind} failed` });
      }
    }
  }
  return reports;
}

export async function gatherInputs(run = defaultRun) {
  const issues = callJson(run, "issue list", "gh", ["issue", "list", "--state", "all", "--limit", "500", "--json", "number,title,state,url,labels"]);
  const threads = {};
  for (const issue of issues) {
    issue.labels = issue.labels.map((l) => l.name ?? l);
    const view = callJson(run, `issue #${issue.number}`, "gh", ["issue", "view", String(issue.number), "--json", "comments"]);
    issue.comments = (view.comments || []).map((c) => ({ body: c.body, createdAt: c.createdAt }));
    const id = newestStarted(issue.comments)?.thread;
    if (id && !(id in threads)) {
      const t = callJson(run, `thread ${id}`, "bb", ["thread", "show", "--json", id]);
      const status = t.status || t.thread?.status;
      if (!status) throw new Error(`bb thread show returned no status for thread ${id}`);
      threads[id] = status;
    }
  }
  let phases;
  const repos = callJson(run, "factory repos", "bb", ["factory", "repos", "list", "--json"]);
  const cfg = (Array.isArray(repos) ? repos[0] : repos)?.phases;
  if (cfg) phases = DEFAULT_PHASES.map((p) => ({ ...p, ...(cfg[p.id] || {}) }));
  return { now: new Date().toISOString(), issues, threads, reports: gatherReports(run), phases };
}

export function writeIfChanged(file, state) {
  const body = JSON.stringify(state, null, 2) + "\n";
  try {
    if (fs.readFileSync(file, "utf8") === body) return false;
  } catch (e) {
    if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const input = arg("--input");
    const inputs = input ? JSON.parse(fs.readFileSync(input, "utf8")) : await gatherInputs();
    writeIfChanged(arg("--out") || "site/state.json", buildState(inputs));
  } catch (e) {
    console.error(`floor-state: ${String(e.message).split("\n")[0]}`);
    process.exit(1);
  }
}
