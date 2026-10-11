import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = "site";
const problems = [];
let pages = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".html")) check(path);
  }
}

function check(path) {
  pages++;
  const html = readFileSync(path, "utf8");
  if (!/<title>/i.test(html)) problems.push(`${path}: missing <title>`);
  if (!/<link rel="stylesheet" href="style.css">/.test(html)) {
    problems.push(`${path}: missing <link rel="stylesheet" href="style.css">`);
  }
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const href = m[1].split(/[#?]/)[0];
    if (!href || /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i.test(href)) continue;
    if (!existsSync(resolve(dirname(path), href))) {
      problems.push(`${path}: broken href ${m[1]}`);
    }
  }
}

walk(root);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ok: ${pages} pages`);
