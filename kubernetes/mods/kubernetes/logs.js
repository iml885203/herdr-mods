// The log model: everything about a log that needs no herdr, no gpui-kit and no
// network, so it can be tested with plain Node (see test/). main.js owns the
// timers, the requests and the drawing; this file owns what the lines are,
// which ones are shown, where they sit and which ones are picked.

export const SINCE = ["tail", "5m", "15m", "30m", "1h", "3h", "6h"];
export const SECS = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "3h": 10800, "6h": 21600 };
export const TAIL = 500, PER_POD = 3000, MAX_LINES = 30000;
export const LEVELS = { all: "All levels", warn: "≥ Warn", err: "Errors" };
export const RANK = { debug: 0, info: 1, warn: 2, err: 3 };
export const POD_COLORS = ["#4fb3ff", "#ffaf5f", "#d787d7", "#87d787", "#af87ff", "#ff875f", "#00d7ff", "#ffd700", "#ff5f87", "#87d7af"];
export const CHAR_W = 7.25, LINE_H = 20;
const TOKEN_LEVEL = { INF: "info", INFO: "info", WRN: "warn", WARN: "warn", WARNING: "warn", ERR: "err", ERROR: "err", FTL: "err", FATAL: "err", DBG: "debug", DEBUG: "debug", TRC: "debug", TRACE: "debug" };

const pad = (n, w = 2) => String(n).padStart(w, "0");
export const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
// The API trims trailing zeros of the fraction ("05.12Z"); pad it so timestamps sort as text.
export const normTs = (ts) => ts.replace(/\.(\d{1,9})Z$/, (_m, f) => `.${f.padEnd(9, "0")}Z`).replace(/:(\d\d)Z$/, ":$1.000000000Z");
// Dedupe key for a line (polls overlap by up to a second).
export const seenKey = (l) => `${l.key}|${l.ts}|${l.text.length}|${l.text.slice(0, 40)}`;
export const nextLevel = (level) => (level === "all" ? "warn" : level === "warn" ? "err" : "all");

export function levelOf(text) {
  if (/\b(FTL|FATAL|CRIT|CRITICAL|ERR|ERROR|EXCEPTION|panic)\b|Exception\b|"level":\s*"(error|fatal)"|\bfail:/i.test(text)) return "err";
  if (/\b(WRN|WARN|WARNING)\b|"level":\s*"warn|\bwarn:/i.test(text)) return "warn";
  if (/\b(DBG|DEBUG|TRC|TRACE|VRB|VERBOSE)\b|\bdbug:/.test(text)) return "debug";
  return "info";
}

export function fmtTime(ts) {
  const d = new Date(ts.slice(0, 23) + "Z");
  return isNaN(d) ? ts : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ------------------------------------------------------------------ colours
// kubecolor-ish: JSON keys, strings, numbers, levels, urls.
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(INF|INFO|WRN|WARN|WARNING|ERR|ERROR|FTL|FATAL|DBG|DEBUG|TRC|TRACE)\b|(https?:\/\/[^\s"',)]+)|(?<![\w.-])(-?\d+(?:\.\d+)?)(?![\w.-])|\b(true|false|null)\b/g;
export function tokens(text, t) {
  const out = [];
  let at = 0, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > at) out.push([text.slice(at, m.index), null]);
    if (m[1]) {
      out.push([m[1], m[2] ? t.ansi6 : t.ansi3]);
      if (m[2]) out.push([m[2], null]);
    } else if (m[3]) {
      const l = TOKEN_LEVEL[m[3]];
      out.push([m[3], l === "err" ? t.ansi1 : l === "warn" ? t.ansi3 : l === "debug" ? t.dim : t.ansi2]);
    } else if (m[4]) out.push([m[4], t.ansi4]);
    else if (m[5]) out.push([m[5], t.ansi5]);
    else out.push([m[6], t.ansi5]);
    at = m.index + m[0].length;
    if (m[0].length === 0) TOKEN.lastIndex++;
  }
  if (at < text.length) out.push([text.slice(at), null]);
  return out;
}

// Splits coloured tokens further at search matches: [text, colour, matched].
export function highlight(segs, q) {
  if (!q) return segs.map(([s, c]) => [s, c, false]);
  const out = [];
  for (const [s, c] of segs) {
    const low = s.toLowerCase();
    let at = 0, i;
    while ((i = low.indexOf(q, at)) >= 0) {
      if (i > at) out.push([s.slice(at, i), c, false]);
      out.push([s.slice(i, i + q.length), c, true]);
      at = i + q.length;
    }
    if (at < s.length) out.push([s.slice(at), c, false]);
  }
  return out;
}

// Neighbours with the same colour and match flag become one run (`":` + ` ` ...).
export function mergeRuns(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last[1] === p[1] && last[2] === p[2]) last[0] += p[0];
    else out.push([p[0], p[1], p[2]]);
  }
  return out;
}

const longWords = new Map();
const longWord = (n) => { let r = longWords.get(n); if (!r) { r = new RegExp(`.{1,${n}}`, "g"); longWords.set(n, r); if (longWords.size > 50) longWords.delete(longWords.keys().next().value); } return r; };

// The pieces one line is drawn from: [text, colour, matched], built once and kept
// on the line until the width, wrap, search text or theme changes (a render
// happens on every scroll step; splitting and colouring every visible line each
// time was most of its cost). o: { t, themeKey, q, cols, wrap, colors } where
// colors maps a level to the colour of uncoloured text.
export function lineParts(l, o) {
  const k = `${o.themeKey}|${o.cols}|${o.wrap}|${o.q}`;
  if (l.pk === k) return l.pp;
  if (l.tokKey !== o.themeKey) { l.tok = tokens(l.text, o.t); l.tokKey = o.themeKey; }
  const base = o.colors[l.level];
  const out = [];
  for (const [s, c, hl] of mergeRuns(highlight(l.tok, o.q))) {
    // Wrap at spaces, and cut words longer than a line so they wrap too
    // (an unbroken JSON blob would otherwise be clipped and leave a gap).
    const words = o.wrap ? s.split(/(?<= )/).flatMap((w) => (w.length > o.cols - 2 ? w.match(longWord(Math.max(1, o.cols - 2))) : [w])) : [s];
    for (const w of words) if (w) out.push([w.replaceAll(" ", " "), c ?? base, hl]);
  }
  l.pk = k; l.pp = out;
  return out;
}

// ------------------------------------------------------------------ the log
// A new log. The toolbar's choices (range, time, wrap, level) carry over from
// the saved preferences, and from the log it replaces.
export function newLog(target, prev, pref = {}) {
  target = { since: pref.since, ts: pref.ts, wrap: pref.wrap, level: pref.level, ...target };
  return {
    ...target, gen: (prev?.gen ?? 0) + 1,
    since: target.since ?? prev?.since ?? "tail", follow: true, previous: target.previous ?? false,
    lines: [], seen: new Set(), floor: "", errs: new Map(), flying: 0, cursor: {}, streams: null, streamsAt: 0, at: 0, pods: {}, hidden: new Set(),
    q: target.q ?? "", filterOnly: target.filterOnly ?? false, level: target.level ?? "all",
    ts: target.ts ?? prev?.ts ?? true, wrap: target.wrap ?? prev?.wrap ?? true,
    match: -1, version: 0, error: null, busy: false, loaded: false, picked: new Set(), anchor: null,
  };
}

// Shows lines that were kept from an earlier run (the cache written on close).
export function restoreLines(L, cache) {
  L.lines = cache.lines.map((l) => ({ ...l, ts: normTs(l.ts) }));
  L.seen = new Set(L.lines.map(seenKey));
  // Counts come from the lines that are shown, the colours from the cache.
  L.pods = {};
  for (const l of L.lines) (L.pods[l.pod] ??= { color: cache.pods?.[l.pod]?.color ?? POD_COLORS[Object.keys(L.pods).length % POD_COLORS.length], n: 0 }).n++;
  L.cursor = cache.cursor ?? {}; L.loaded = true; L.version++;
}

// Starts the same log over (another range, previous container, ...).
export function resetLog(L) {
  L.gen++; L.lines = []; L.seen = new Set(); L.cursor = {}; L.streams = null; L.version++; L.loaded = false; L.match = -1; L.busy = false;
  L.picked = new Set(); L.anchor = null;
  // Chips and their counts, and what was evicted, belong to the lines that are gone.
  L.pods = {}; L.hidden = new Set(); L.floor = ""; L.errs = new Map();
}

// ------------------------------------------------------------------ streams
// One stream per container. A pod list that is read again keeps what each
// stream already knows (its backoff).
export function streamsOf(pods, old = []) {
  const known = new Map(old.map((s) => [s.key, s]));
  return pods.flatMap((p) => (p.spec?.containers ?? []).map((c) => {
    const key = `${p.metadata.name}/${c.name}`;
    return known.get(key) ?? { pod: p.metadata.name, ctr: c.name, key, empty: 0, next: 0 };
  }));
}

// A stream that has had nothing new is asked less often: after 1, 2, 3+ empty
// polls the next one waits ~2, 4, 8 s (300 ms less than that, because the poll
// timer ticks every second and would otherwise just miss it). New lines: next tick.
export const backoff = (empty) => (empty <= 0 ? 0 : Math.min(8000, 1000 * 2 ** empty) - 300);
export const due = (s, now) => !(s.next > now);

// The query of one stream's log request. The first read of a range is capped
// at about MAX_LINES / streams, since more would only be thrown away.
export function logQuery(L, s, nStreams) {
  const q = [`container=${encodeURIComponent(s.ctr)}`, "timestamps=true"];
  if (L.previous) q.push("previous=true");
  const cap = Math.max(200, Math.floor(MAX_LINES / Math.max(1, nStreams)));
  if (L.cursor[s.key]) q.push(`sinceTime=${encodeURIComponent(L.cursor[s.key])}`);
  else if (L.since === "tail") q.push(`tailLines=${Math.min(TAIL, cap)}`);
  else q.push(`sinceSeconds=${SECS[L.since]}`, `tailLines=${Math.min(PER_POD, cap)}`);
  return q.join("&");
}

// ------------------------------------------------------------------ ingest
// Merges sorted `fresh` into sorted `lines` in place: appended when it all comes
// after, else only the tail from the first overlapping line is merged (a sort
// of up to 30000 lines on most polls of a many-pod log was the old cost).
// Equal timestamps keep the existing line first.
export function mergeFresh(lines, fresh) {
  if (!fresh.length) return;
  const last = lines[lines.length - 1];
  if (!last || fresh[0].ts >= last.ts) { for (const l of fresh) lines.push(l); return; }
  let lo = 0, hi = lines.length; // first line later than fresh[0]
  while (lo < hi) { const mid = (lo + hi) >> 1; if (lines[mid].ts > fresh[0].ts) hi = mid; else lo = mid + 1; }
  const tail = lines.splice(lo);
  let i = 0, j = 0;
  while (i < tail.length && j < fresh.length) lines.push(tail[i].ts <= fresh[j].ts ? tail[i++] : fresh[j++]);
  while (i < tail.length) lines.push(tail[i++]);
  while (j < fresh.length) lines.push(fresh[j++]);
}

// texts: [[stream, body]] for the streams just read. Adds the lines not seen
// before, keeps the newest MAX_LINES, and updates each stream's backoff.
// Time and level are worked out only for the lines that are kept.
export function ingest(L, texts, now = Date.now()) {
  const fresh = [];
  for (const [s, body] of texts) {
    let got = 0;
    s.read = true;
    for (const raw of body.split("\n")) {
      if (!raw) continue;
      const sp = raw.indexOf(" ");
      const ts = normTs(sp < 0 ? raw : raw.slice(0, sp)), text = sp < 0 ? "" : raw.slice(sp + 1);
      // At or before the newest line already evicted: it would only be evicted again,
      // and (the seen key being gone) would otherwise come back on every poll, since
      // sinceTime is inclusive.
      // The cursor moves first: a quiet stream wholly below the floor must still get one,
      // or it would be re-read with sinceSeconds+tailLines every backoff period.
      if (!L.cursor[s.key] || ts > L.cursor[s.key]) L.cursor[s.key] = ts;
      if (ts <= L.floor) continue;
      const line = { pod: s.pod, ctr: s.ctr, key: s.key, ts, text: text.includes("\x1b") ? text.replace(/\x1b\[[0-9;]*m/g, "") : text };
      const k = seenKey(line);
      if (L.seen.has(k)) continue;
      L.seen.add(k);
      fresh.push(line);
      got++;
      L.pods[s.pod] ??= { color: POD_COLORS[Object.keys(L.pods).length % POD_COLORS.length], n: 0 };
      L.pods[s.pod].n++;
    }
    s.empty = got ? 0 : (s.empty ?? 0) + 1;
    s.next = got ? 0 : now + backoff(s.empty);
  }
  if (!fresh.length) return false;
  fresh.sort(byTs);
  mergeFresh(L.lines, fresh);
  let gone = null;
  if (L.lines.length > MAX_LINES) {
    const out = L.lines.splice(0, L.lines.length - MAX_LINES);
    gone = new Set(out);
    L.floor = out[out.length - 1].ts;
    for (const l of out) {
      L.seen.delete(seenKey(l));
      const p = L.pods[l.pod];
      if (p) p.n--;
    }
  }
  for (const l of fresh) {
    if (gone?.has(l)) continue;
    l.time = fmtTime(l.ts);
    l.level = levelOf(l.text);
  }
  L.version++;
  return true;
}

// What the log shows as its error: the first failed stream's, with a count of the rest.
export function errorOf(L) {
  const errs = [...L.errs.values()];
  if (errs.length) return errs[0] + (errs.length > 1 ? `  (+${errs.length - 1} more)` : "");
  return L.streams && !L.streams.length ? "no pods match this selector" : null;
}

// ------------------------------------------------------------------ shown lines
// The lines that pass the pod, level and search filters, and the indexes (in
// them) of the search matches. Kept until the lines or a filter change.
export function visibleLines(L) {
  const q = L.q.toLowerCase();
  const key = `${L.gen}|${L.version}|${[...L.hidden].join(",")}|${q}|${L.filterOnly}|${L.level}`;
  if (L.vis?.key === key) return L.vis;
  const min = L.level === "err" ? 3 : L.level === "warn" ? 2 : 0;
  // Lower-cased text is made only while searching, and kept on the line after.
  const has = (l) => (l.low ??= l.text.toLowerCase()).includes(q);
  const lines = L.lines.filter((l) => !L.hidden.has(l.pod) && RANK[l.level] >= min && (!L.filterOnly || !q || has(l)));
  const matches = [];
  if (q && !L.filterOnly) for (let i = 0; i < lines.length; i++) if (has(lines[i])) matches.push(i);
  return (L.vis = { key, lines, matches, q });
}

// The next/previous search match: sets L.match, returns its line index (or -1).
export function stepMatch(L, matches, dir) {
  if (!matches.length) return -1;
  L.match = L.match < 0 ? (dir > 0 ? 0 : matches.length - 1) : (L.match + dir + matches.length) % matches.length;
  return matches[L.match];
}

// ------------------------------------------------------------------ layout
// Where each row starts, for scrolling and for finding the line under the
// pointer. Worked out once per change of lines, width or wrap, not on every
// scroll or drag (each of those renders).
export function layout(L, lines, key, cols, wrap, viewH) {
  const k = `${key}|${cols}|${wrap}`;
  let c = L.lay;
  if (c?.key !== k) {
    const n = lines.length, heights = new Array(n), tops = new Array(n + 1);
    tops[0] = 0;
    for (let i = 0; i < n; i++) {
      heights[i] = wrap ? Math.max(1, Math.ceil((lines[i].text.length * 1.06) / cols)) * LINE_H + 2 : LINE_H + 2;
      tops[i + 1] = tops[i] + heights[i];
    }
    c = L.lay = { key: k, heights, tops, total: tops[n], n };
  }
  return { ...c, maxTop: Math.max(0, c.total - viewH) };
}

// The row at pixel y of the laid-out lines (-1 when there are none).
export function indexAt(lay, y) {
  const { tops, n } = lay ?? { tops: [0], n: 0 };
  if (!n) return -1;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}

// ------------------------------------------------------------------ pick
// Click a line to pick it, shift-click for a range, cmd/ctrl-click to add one.
export function pick(L, i, mods, lines) {
  const l = lines[i];
  if (!l) return;
  if (mods?.shift && L.anchor && lines.includes(L.anchor)) {
    const a = lines.indexOf(L.anchor), [lo, hi] = a < i ? [a, i] : [i, a];
    L.picked = new Set(lines.slice(lo, hi + 1));
  } else if (mods?.platform || mods?.control) {
    if (L.picked.has(l)) L.picked.delete(l); else L.picked.add(l);
    L.anchor = l;
  } else {
    L.picked = L.picked.size === 1 && L.picked.has(l) ? new Set() : new Set([l]);
    L.anchor = l;
  }
}

// A press without modifiers starts a drag over lines; a click on the only picked line unpicks it (on release).
export function pressPick(L, i, lines) {
  const drag = { anchor: i, moved: false, sole: L.picked.size === 1 && L.picked.has(lines[i]) };
  L.anchor = lines[i];
  L.picked = new Set([lines[i]]);
  return drag;
}
export function dragPick(L, drag, i, lines) {
  if (i !== drag.anchor) drag.moved = true;
  const [lo, hi] = i < drag.anchor ? [i, drag.anchor] : [drag.anchor, i];
  L.picked = new Set(lines.slice(lo, hi + 1));
}
export function releasePick(L, drag) {
  if (drag && !drag.moved && drag.sole) L.picked = new Set();
}

// The picked lines, else everything shown.
export function chosen(L, lines) {
  const picked = lines.filter((l) => L.picked.has(l));
  return picked.length ? picked : lines;
}
export const asText = (lines) => lines.map((l) => `${l.ts} ${l.pod}/${l.ctr} ${l.text}`).join("\n");
