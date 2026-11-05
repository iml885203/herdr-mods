// Pure rules, kept apart from main.js so they run under node --test.

export const APP = "claude-code";
const MAX_NAME = 100;

// One Claude Code session file (~/.claude/sessions/<pid>.json) -> {pid, name, since}, or null
// when it isn't one. `name` is null unless someone gave it (`/rename`, nameSource "user"):
// Claude's own titles never rename a tab.
export function readSession(text) {
  let s;
  try { s = JSON.parse(text); } catch { return null; }
  if (!s || typeof s.pid !== "number") return null;
  const name = s.nameSource === "user" ? cleanName(s.name) : "";
  return { pid: s.pid, name: name || null, since: s.nameSince ?? 0 };
}

// A tab or session name: one line of printable text, trimmed, at most 100 characters.
// It gets typed into a terminal, so control characters (Esc, Ctrl-C, …) never get through.
export function cleanName(name) {
  const line = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "") // zero-width and bidi controls
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(line).slice(0, MAX_NAME).join("").trim(); // by code point: an emoji isn't cut in half
}

// The Claude a tab is named after: the given terminal if it is one of the tab's Claudes,
// else the focused one, else the first.
export function claudeOf(panes, tab, terminal = null) {
  const ours = panes.filter((p) => p.tab === tab && p.app === APP && p.terminal);
  return ours.find((p) => p.terminal === terminal) ?? ours.find((p) => p.focused) ?? ours[0] ?? null;
}

// The renames to make: a tab follows its Claude's name each time that name changes.
// sessions: Map pid -> {name, since}; pidOf: terminal -> pid; synced: Map terminal -> key,
// updated in place. Returns [{tab, name}].
export function renames(panes, tabs, sessions, pidOf, synced) {
  const out = [];
  const live = new Set();
  for (const p of panes) {
    if (p.app !== APP || !p.terminal || !tabs.has(p.tab)) continue;
    live.add(p.terminal);
    const s = sessions.get(pidOf(p.terminal));
    if (!s?.name) continue;
    const key = `${s.since}\u0000${s.name}`;
    if (synced.get(p.terminal) === key) continue;
    synced.set(p.terminal, key);
    if (tabs.get(p.tab).name !== s.name && !out.some((r) => r.tab === p.tab)) out.push({ tab: p.tab, name: s.name });
  }
  for (const t of [...synced.keys()]) if (!live.has(t)) synced.delete(t);
  return out;
}

// Claude Code's prompt box on a screen (`hc read`): the lines from the last "❯" right under a
// rule down to the next rule. {text, top, bottom} (line indexes of the rules), or null when
// there is no box: a dialog or picker is open, bash mode ("!"), or the layout changed.
// Claude's grey suggestion is drawn in the box too and reads the same as typed text.
export function promptBox(screen) {
  const lines = String(screen ?? "").split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    if (!lines[i].startsWith("❯") || !lines[i - 1].startsWith("─")) continue;
    const box = [lines[i].slice(1)];
    let j = i + 1;
    for (; j < lines.length && !lines[j].startsWith("─"); j++) box.push(lines[j]);
    if (j >= lines.length) return null; // no closing rule: not the prompt box
    return { text: box.join("\n").trim(), top: i - 1, bottom: j, below: lines.slice(j + 1).join("\n") };
  }
  return null;
}

// Vim mode: an Esc or typed text would be taken as vim keys.
const VIM = /-- (NORMAL|INSERT|VISUAL) --/;

// What to do before typing `/rename` into a Claude with this status and screen:
// "type", "probe" (an idle box with text in it: type PROBE_KEY, read with `probeResult`,
// press backspace), or the reason not to type.
export function decide(status, screen) {
  if (status === "blocked") return "Claude is asking you something";
  const box = promptBox(screen);
  if (!box) return "couldn't find Claude's prompt (a dialog may be open)";
  if (VIM.test(box.below)) return "Claude's prompt is in vim mode";
  if (!box.text) return "type";
  // Mid-turn there is no suggestion, so text there is yours.
  if (status === "working") return "Claude's prompt has unsent text";
  return "probe";
}

// Typed text and Claude's grey suggestion read the same on screen. A typed key tells them
// apart: it replaces a suggestion, so the box holds just that key, and it lands inside a
// draft. A backspace then puts either back as it was.
export const PROBE_KEY = "x";

// The box after PROBE_KEY: "suggestion", "draft", "same" (not redrawn: the key didn't show,
// an empty box counts too), or "unknown" (no box any more: something else happened).
export function probeResult(before, after) {
  const a = promptBox(before);
  const b = promptBox(after);
  if (!a || !b) return "unknown";
  if (b.text === a.text || b.text === "") return "same";
  return b.text === PROBE_KEY ? "suggestion" : "draft";
}

// After the probe's backspace: the box is back as it was, or empty (the suggestion not
// redrawn yet). Either is safe to type into.
export function settled(before, now) {
  const a = promptBox(before);
  const b = promptBox(now);
  return !!a && !!b && (b.text === a.text || b.text === "");
}
