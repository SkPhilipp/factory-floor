import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = "site";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  );
}

const pages = walk(root).filter((f) => f.endsWith(".html"));
const problems = [];

for (const page of pages) {
  const html = readFileSync(page, "utf8");
  if (!/<title>[^<]*\S[^<]*<\/title>/.test(html)) {
    problems.push(`${page}: missing <title>`);
  }
  if (!html.includes('<link rel="stylesheet" href="style.css">')) {
    problems.push(`${page}: missing <link rel="stylesheet" href="style.css">`);
  }
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    if (/^(https?:|mailto:|#)/.test(m[1])) continue;
    const target = m[1].split("#")[0].split("?")[0];
    if (!target) continue;
    if (!existsSync(resolve(dirname(page), target))) {
      problems.push(`${page}: broken link ${m[1]}`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok: ${pages.length} pages`);
