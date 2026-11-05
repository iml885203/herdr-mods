// Finds class methods defined twice in one class: the later one silently replaces the first.
// usage: node scripts/dup-methods.mjs <file.js>...   (exit 1 when any are found)
import { readFileSync } from "node:fs";
let bad = 0;
for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, "utf8").split("\n");
  let seen = null;
  lines.forEach((line, i) => {
    if (/^(export\s+)?(default\s+)?class\s/.test(line)) seen = new Map();
    else if (/^\S/.test(line) && !/^}/.test(line)) return;
    if (!seen) return;
    const m = /^  (?:async\s+|static\s+|get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(line);
    if (!m || ["if", "for", "while", "switch", "catch"].includes(m[1])) return;
    const kind = /^  (get|set)\s/.exec(line)?.[1] ?? "";
    const key = kind + m[1];
    if (seen.has(key)) { console.log(`${file}:${i + 1}: ${m[1]}() is also defined at line ${seen.get(key)}`); bad = 1; }
    else seen.set(key, i + 1);
  });
}
process.exit(bad);
