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

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });

function gatherReports() {
  const reports = [];
  const refs = ["origin/master"];
  try {
    for (const ref of run("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]).split("\n")) {
      if (/^origin\/(bb\/\d+-.*|factory\/\d+)$/.test(ref)) refs.push(ref);
    }
  } catch {}
  for (const ref of refs) {
    for (const kind of ["gate", "review"]) {
      let names = [];
      try {
        names = run("git", ["ls-tree", "--name-only", ref, `factory/${kind}s/`]).split("\n").filter(Boolean);
      } catch {}
      for (const name of names) {
        const m = /\/(\d+)-(\d+)\.md$/.exec(name);
        if (!m) continue;
        let text;
        try {
          text = run("git", ["show", `${ref}:${name}`]);
        } catch {
          continue;
        }
        const ok = kind === "gate" ? /^Result: \*\*PASS\*\*/m.test(text) : /^READY\b|^Verdict:\s*\**READY/m.test(text) || !/FINDINGS/.test(text);
        const first = text.split("\n").find((l) => /fail|finding|defect|\[ \]/i.test(l) && !l.startsWith("Result")) || "";
        reports.push({ issue: Number(m[1]), attempt: Number(m[2]), kind, ok, text: first.replace(/^[-*#\s]+/, "").trim() || `${kind} failed` });
      }
    }
  }
  return reports;
}

function gatherInputs() {
  const issues = JSON.parse(run("gh", ["issue", "list", "--state", "all", "--limit", "500", "--json", "number,title,state,url,labels"]));
  const threads = {};
  for (const issue of issues) {
    issue.labels = issue.labels.map((l) => l.name);
    let comments = [];
    try {
      comments = JSON.parse(run("gh", ["issue", "view", String(issue.number), "--json", "comments"])).comments;
    } catch {}
    issue.comments = comments.map((c) => ({ body: c.body, createdAt: c.createdAt }));
    const id = newestStarted(issue.comments)?.thread;
    if (id && !(id in threads)) {
      try {
        const t = JSON.parse(run("bb", ["thread", "show", "--json", id]));
        threads[id] = t.status || t.thread?.status || "unknown";
      } catch {
        threads[id] = "unknown";
      }
    }
  }
  let phases;
  try {
    const repos = JSON.parse(run("bb", ["factory", "repos", "list", "--json"]));
    const cfg = (Array.isArray(repos) ? repos[0] : repos)?.phases;
    if (cfg) phases = DEFAULT_PHASES.map((p) => ({ ...p, ...(cfg[p.id] || {}) }));
  } catch {}
  return { now: new Date().toISOString(), issues, threads, reports: gatherReports(), phases };
}

export function writeIfChanged(file, state) {
  const body = JSON.stringify(state, null, 2) + "\n";
  try {
    if (fs.readFileSync(file, "utf8") === body) return false;
  } catch {}
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const input = arg("--input");
  const inputs = input ? JSON.parse(fs.readFileSync(input, "utf8")) : gatherInputs();
  writeIfChanged(arg("--out") || "site/state.json", buildState(inputs));
}
