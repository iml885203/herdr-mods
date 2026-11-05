import { dirOf, baseName, resolvePath } from "./paths.js";

const TRACKED = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const COMMAND_DIR_LIMIT = 12;
const OPERATORS = new Set([";", "|", "&", "\n"]);

function segmentsOf(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (const char of command) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (OPERATORS.has(char)) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

const tokensOf = (segment) => [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

function hintOf(token) {
  const path = token.replace(/^\(+/, "").replace(/\)+$/, "").replace(/^--?[\w-]+=/, "");
  return /^(\/|~\/|\$HOME\/|\$\{HOME\}\/)/.test(path) ? path : null;
}

const unique = (list) => [...new Set(list)];

export function commandDirs(command, cwd, home) {
  const dirs = [cwd];
  const hints = [];
  let dir = cwd;
  for (const segment of segmentsOf(command)) {
    const tokens = tokensOf(segment);
    if (tokens[0] === "cd" && tokens[1] && tokens[1] !== "-") {
      dir = resolvePath(dir, tokens[1], home) ?? dir;
      dirs.push(dir);
    } else if (tokens[0] === "git" && tokens.indexOf("-C") > 0) {
      const target = resolvePath(dir, tokens[tokens.indexOf("-C") + 1], home);
      if (target) dirs.push(target);
    }
    for (const token of tokens) {
      const hint = hintOf(token);
      const resolved = hint && resolvePath(cwd, hint, home);
      if (resolved) hints.push(resolved);
    }
  }
  const strong = unique(dirs);
  return { dirs: strong.slice(0, COMMAND_DIR_LIMIT), hints: unique(hints).filter((h) => !strong.includes(h)).slice(0, COMMAND_DIR_LIMIT) };
}

function eventsOfLine(line, home) {
  let entry;
  try { entry = JSON.parse(line); } catch { return []; }
  const content = entry?.message?.content;
  const ts = Date.parse(entry?.timestamp);
  if (!Array.isArray(content) || Number.isNaN(ts)) return [];
  const cwd = entry.cwd ?? "";
  const events = [];
  for (const item of content) {
    if (item?.type !== "tool_use") continue;
    const key = TRACKED[item.name];
    if (key) {
      const file = typeof item.input?.[key] === "string" ? resolvePath(cwd, item.input[key], home) : null;
      if (file) events.push({ ts, files: [file], dirs: [], hints: [] });
    } else if (item.name === "Bash" && typeof item.input?.command === "string") {
      events.push({ ts, files: [], ...commandDirs(item.input.command, cwd, home) });
    }
  }
  return events;
}

export function parseToolUses(text, home) {
  return text.split("\n").filter((line) => line.includes('"tool_use"')).flatMap((line) => eventsOfLine(line, home));
}

export const createTouches = () => ({ files: new Map(), dirs: new Map(), hints: new Map() });

function widen(map, key, ts) {
  const range = map.get(key);
  map.set(key, range ? { first: Math.min(range.first, ts), last: Math.max(range.last, ts) } : { first: ts, last: ts });
}

export function foldEvents(touches, events) {
  for (const { ts, files, dirs, hints } of events) {
    for (const file of files) widen(touches.files, file, ts);
    for (const dir of dirs) widen(touches.dirs, dir, ts);
    for (const hint of hints) widen(touches.hints, hint, ts);
  }
}

export function groupTouches(touches, rootOf) {
  const repos = new Map();
  const entry = (root) => {
    const found = repos.get(root) ?? { strong: null, weak: null, lastTs: 0, files: new Set() };
    repos.set(root, found);
    return found;
  };
  const note = (found, range, kind) => {
    found[kind] = found[kind] === null ? range.first : Math.min(found[kind], range.first);
    found.lastTs = Math.max(found.lastTs, range.last);
  };
  for (const [dir, range] of touches.dirs) {
    const where = rootOf(dir);
    if (where) note(entry(where.root), range, "strong");
  }
  for (const [file, range] of touches.files) {
    const where = rootOf(dirOf(file));
    if (!where) continue;
    const found = entry(where.root);
    note(found, range, "strong");
    found.files.add(`${where.prefix}${baseName(file)}`);
  }
  for (const [hint, range] of touches.hints) {
    const where = rootOf(dirOf(hint));
    if (where) note(entry(where.root), range, "weak");
  }
  return new Map([...repos].map(([root, found]) => [root, { firstTs: found.strong ?? found.weak, lastTs: found.lastTs, files: found.files }]));
}
