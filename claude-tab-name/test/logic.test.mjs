import { test } from "node:test";
import assert from "node:assert/strict";
import { readSession, cleanName, claudeOf, renames, promptBox, decide, probeResult, settled, PROBE_KEY, kebabName, parseCache, cacheGet, cachePut, SUGGEST_TTL_MS, FAIL_TTL_MS } from "../mods/claude-tab-name/logic.js";

const session = (o) => JSON.stringify({ pid: 101, name: "tech review", nameSource: "user", nameSince: 5, ...o });

test("a session file gives its pid, and its name only when someone gave it", () => {
  assert.deepEqual(readSession(session()), { pid: 101, name: "tech review", since: 5 });
  assert.deepEqual(readSession(session({ nameSource: "derived" })), { pid: 101, name: null, since: 5 });
  assert.deepEqual(readSession(session({ name: "  " })), { pid: 101, name: null, since: 5 });
  assert.equal(readSession(session({ pid: "101" })), null);
  assert.equal(readSession("{not json"), null);
});

test("names are one printable trimmed line, at most 100 characters", () => {
  assert.equal(cleanName("  fix\nlogin\t "), "fix login");
  assert.equal(cleanName("a\u001b[201~b\u0003c\u007fd\u2028e"), "a [201~b c d e");
  assert.equal(cleanName("x".repeat(150)).length, 100);
  assert.equal(cleanName(undefined), "");
  assert.equal(cleanName("a\u202eb\u200bc"), "abc"); // bidi override, zero-width space
  const emoji = cleanName("x".repeat(99) + "🙂🙂");
  assert.equal(Array.from(emoji).length, 100);
  assert.equal(emoji.endsWith("🙂"), true); // cut by code point, not in half
});

test("the tab's Claude: the given terminal, else the focused one, else the first", () => {
  const ps = [
    { tab: "a", app: "claude-code", terminal: "t1", focused: false },
    { tab: "a", app: "claude-code", terminal: "t2", focused: true },
    { tab: "a", app: null, terminal: "t3", focused: false },
    { tab: "b", app: "claude-code", terminal: null, mod: "x", focused: false },
  ];
  assert.equal(claudeOf(ps, "a", "t1").terminal, "t1");
  assert.equal(claudeOf(ps, "a", "t3").terminal, "t2"); // t3 isn't a Claude
  assert.equal(claudeOf(ps, "a").terminal, "t2");
  assert.equal(claudeOf(ps.map((p) => ({ ...p, focused: false })), "a").terminal, "t1");
  assert.equal(claudeOf(ps, "b"), null);
});

test("a tab follows its Claude's name once per change", () => {
  const tabs = new Map([["a", { name: "2" }], ["b", { name: "notes" }]]);
  const ps = [{ tab: "a", app: "claude-code", terminal: "t1" }, { tab: "b", app: "claude-code", terminal: "t2" }];
  const sessions = new Map([[101, { name: "tech review", since: 5 }], [102, { name: "notes", since: 1 }]]);
  const pidOf = (t) => ({ t1: 101, t2: 102 })[t];
  const synced = new Map();
  assert.deepEqual(renames(ps, tabs, sessions, pidOf, synced), [{ tab: "a", name: "tech review" }]);
  // Renamed by hand afterwards: left alone until Claude's name changes again.
  tabs.set("a", { name: "mine" });
  assert.deepEqual(renames(ps, tabs, sessions, pidOf, synced), []);
  sessions.set(101, { name: "tech review 2", since: 9 });
  assert.deepEqual(renames(ps, tabs, sessions, pidOf, synced), [{ tab: "a", name: "tech review 2" }]);
});

test("other apps, other machines' tabs, unnamed sessions and closed terminals are skipped", () => {
  const tabs = new Map([["a", { name: "2" }]]);
  const sessions = new Map([[1, { name: "codex one", since: 1 }], [2, { name: "remote", since: 1 }], [3, { name: null, since: 1 }]]);
  const pidOf = (t) => ({ t1: 1, t2: 2, t3: 3 })[t];
  const synced = new Map([["gone", "x"]]);
  const ps = [
    { tab: "a", app: "codex", terminal: "t1" },
    { tab: "z", app: "claude-code", terminal: "t2" }, // tab "z" is not in tabs (another machine)
    { tab: "a", app: "claude-code", terminal: "t3" },
  ];
  assert.deepEqual(renames(ps, tabs, sessions, pidOf, synced), []);
  assert.equal(synced.has("gone"), false);
});

test("two named Claudes in one tab: the first in pane order wins a pass", () => {
  const tabs = new Map([["a", { name: "2" }]]);
  const ps = [{ tab: "a", app: "claude-code", terminal: "t1" }, { tab: "a", app: "claude-code", terminal: "t2" }];
  const sessions = new Map([[1, { name: "one", since: 1 }], [2, { name: "two", since: 1 }]]);
  const synced = new Map();
  assert.deepEqual(renames(ps, tabs, sessions, (t) => (t === "t1" ? 1 : 2), synced), [{ tab: "a", name: "one" }]);
  assert.equal(synced.has("t2"), true); // seen, so it doesn't fight the first one on every pass
});

const RULE = "─".repeat(20);
const screenWith = (...box) => ["⏺ done", "", `${RULE} alpha ─`, ...box, RULE, "  ◆ Opus", "  ⏵⏵ auto mode on"].join("\n");

test("the prompt box is read from the screen", () => {
  assert.equal(promptBox(screenWith("❯ ")).text, "");
  assert.equal(promptBox(screenWith("❯ hello")).text, "hello");
  assert.equal(promptBox(screenWith("❯ first line", "  second line")).text, "first line\n  second line");
  assert.equal(promptBox("❯ an old prompt in the history\nno box here"), null);
  assert.equal(promptBox(`${RULE}\n❯ no closing rule`), null);
  assert.equal(promptBox(screenWith("! ls -la")), null); // bash mode
  assert.equal(promptBox(""), null);
});

test("the last box wins over prompts quoted in the history", () => {
  const s = [RULE, "❯ old", RULE, "⏺ reply", screenWith("❯ ")].join("\n");
  assert.equal(promptBox(s).text, "");
});

test("what to do before typing /rename", () => {
  assert.equal(decide("idle", screenWith("❯ ")), "type");
  assert.equal(decide("working", screenWith("❯ ")), "type");
  assert.equal(decide("done", screenWith("❯ hello")), "probe");
  assert.equal(decide(null, screenWith("❯ hello")), "probe");
  assert.match(decide("working", screenWith("❯ hello")), /unsent text/);
  assert.match(decide("blocked", screenWith("❯ ")), /asking you/);
  assert.match(decide("idle", null), /couldn't find/); // hc read failed
  assert.match(decide("idle", screenWith("! ls")), /couldn't find/); // bash mode
  assert.match(decide("idle", "Select model\n ❯ Opus\n   Sonnet"), /couldn't find/); // a picker
});

test("vim mode means don't type: Esc and text would be vim keys", () => {
  const vim = (box, mode) => ["⏺ done", `${RULE} a ─`, box, RULE, `  ${mode}`].join("\n");
  assert.match(decide("idle", vim("❯ ", "-- NORMAL --")), /vim mode/);
  assert.match(decide("idle", vim("❯ hi", "-- INSERT --")), /vim mode/);
});

test("the probe key tells a suggestion from a draft", () => {
  const scr = (box) => screenWith(box);
  // A suggestion is replaced by the key; a draft gets it added, wherever the cursor is.
  assert.equal(probeResult(scr("❯ /rename nine"), scr(`❯ ${PROBE_KEY}`)), "suggestion");
  assert.equal(probeResult(scr("❯ /mo"), scr("❯ /mox")), "draft");
  assert.equal(probeResult(scr("❯ hello"), scr("❯ hexllo")), "draft");
  assert.equal(probeResult(scr(`❯ ${PROBE_KEY}`), scr(`❯ ${PROBE_KEY}${PROBE_KEY}`)), "draft");
  assert.equal(probeResult(scr("❯ hello"), scr("❯ hello")), "same"); // not redrawn yet
  assert.equal(probeResult(scr("❯ /rename nine"), scr("❯ ")), "same"); // mid-redraw
  assert.equal(probeResult(scr("❯ hello"), "Select model\n ❯ Opus"), "unknown");
  assert.equal(probeResult(scr("❯ hello"), null), "unknown");
});

test("after the backspace: back as before, or empty, is settled", () => {
  const scr = (box) => screenWith(box);
  assert.equal(settled(scr("❯ /rename nine"), scr("❯ /rename nine")), true);
  assert.equal(settled(scr("❯ /rename nine"), scr("❯ ")), true);
  assert.equal(settled(scr("❯ /rename nine"), scr(`❯ ${PROBE_KEY}`)), false); // the key is still there
  assert.equal(settled(scr("❯ /rename nine"), null), false);
});

test("a suggested name is aaa-bbb: lowercase ASCII words, 4 at most", () => {
  assert.equal(kebabName("tab-rename-suggest"), "tab-rename-suggest");
  assert.equal(kebabName("  Fix Login_Retry!\n"), "fix-login-retry");
  assert.equal(kebabName("k8s log search filter bug fix"), "k8s-log-search-filter"); // cut to 4 words
  assert.equal(kebabName("修 bug"), "bug");
  assert.equal(kebabName("—"), null);
  assert.equal(kebabName(null), null);
  assert.equal(kebabName("a".repeat(30) + " " + "b".repeat(30)), "a".repeat(30)); // 40 characters at most
  assert.equal(kebabName("x".repeat(50)), null);
  assert.equal(kebabName("x".repeat(40)), "x".repeat(40));
  assert.equal(kebabName("aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd"), "aaaaaaaaaa-bbbbbbbbbb-cccccccccc"); // 4 words over 40: drop from the end
  assert.equal(kebabName("fixLoginRetry"), "fix-login-retry");
  assert.equal(kebabName("café menu"), "cafe-menu");
  assert.equal(kebabName("2026"), "2026");
  assert.equal(kebabName("Sorry, I cannot name this"), null);
  assert.equal(kebabName("cannot-find-module"), "cannot-find-module"); // a name, not a refusal
});

test("the suggestion cache: names for 5 minutes, failures for 1", () => {
  const t0 = 1_000_000;
  let all = cachePut({}, "s1", "fix-login", t0);
  all = cachePut(all, "s2", null, t0);
  assert.deepEqual(cacheGet(all, "s1", t0 + SUGGEST_TTL_MS - 1), { hit: true, name: "fix-login" });
  assert.deepEqual(cacheGet(all, "s1", t0 + SUGGEST_TTL_MS), { hit: false });
  assert.deepEqual(cacheGet(all, "s2", t0 + FAIL_TTL_MS - 1), { hit: true, name: null });
  assert.deepEqual(cacheGet(all, "s2", t0 + FAIL_TTL_MS), { hit: false });
  assert.deepEqual(cacheGet(all, "nope", t0), { hit: false });
  // Writing drops what has expired.
  assert.deepEqual(Object.keys(cachePut(all, "s3", "x-y", t0 + FAIL_TTL_MS)).sort(), ["s1", "s3"]);
});

test("a damaged cache reads as empty, and odd entries are ignored", () => {
  assert.deepEqual(parseCache("{half"), {});
  assert.deepEqual(parseCache("[1,2]"), {});
  assert.deepEqual(parseCache("null"), {});
  const all = parseCache(JSON.stringify({ a: { name: "Not Kebab", at: 5 }, b: { name: "ok-name" }, c: "x" }));
  assert.deepEqual(cacheGet(all, "a", 6), { hit: false });
  assert.deepEqual(cacheGet(all, "b", 6), { hit: false });
  assert.deepEqual(cacheGet(all, "c", 6), { hit: false });
});
