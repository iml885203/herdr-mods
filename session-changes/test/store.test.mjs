import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../mods/session-changes/store.js";
import { STABLE_MS } from "../mods/session-changes/scheduler.js";
import { bashLine, editLine, fakeIo, padLine, until } from "./fakeio.mjs";

const session = (id = "sid") => ({ sessionId: id, name: "n" });
const started = (options, storeOptions) => {
  const fake = fakeIo(options);
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const store = new Store(fake.io, undefined, { storage, autoSummary: false, ...storeOptions });
  store.start(session());
  return { fake, store, storage };
};

test("the first tick reads the transcript, finds the repo and builds its view", async () => {
  const { store } = started();
  const result = await store.tick();
  assert.equal(result.changed, true);
  assert.equal(store.loaded, true);
  assert.deepEqual(store.views.map((v) => [v.root, v.owned]), [["/r", 1]]);
});

test("a quiet second tick runs no git, and a new line that changes nothing about the repo takes no new snapshot", async () => {
  const { fake, store } = started();
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 1);
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 1);
  fake.append(editLine("/r/a.cs", "2026-11-04T10:00:00.000Z"));
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 1);
});

test("a later event in the repo moves its window, so the repo is snapshotted again even when git did not change", async () => {
  const { fake, store } = started();
  await store.tick();
  fake.append(editLine("/r/a.cs", "2026-11-04T10:01:00.000Z"));
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 2);
});

test("a changed file signature or HEAD takes a new snapshot and bumps the repo version", async () => {
  const { fake, store } = started();
  await store.tick();
  const first = store.stateOf("/r").version;
  fake.append(editLine("/r/a.cs", "2026-11-04T10:01:00.000Z"));
  fake.world.stat = "s2";
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 2);
  assert.equal(store.stateOf("/r").version, first + 1);
  fake.append(editLine("/r/a.cs", "2026-11-04T10:02:00.000Z"));
  fake.world.head = "h2";
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 3);
});

test("the commit log is read once while HEAD stays, and the window end filters its commits at every snapshot", async () => {
  const stamp = (iso) => Math.floor(Date.parse(iso) / 1000);
  const { fake, store } = started();
  fake.world.log = `\x01${stamp("2026-11-04T10:00:30.000Z")} early\n\na.cs\n\x01${stamp("2026-11-04T10:05:30.000Z")} later\n\na.cs\n`;
  await store.tick();
  assert.deepEqual(store.stateOf("/r").snap.commits.map((c) => c.subject), ["early"]);
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick();
  assert.deepEqual(store.stateOf("/r").snap.commits.map((c) => c.subject), ["early", "later"]);
  assert.equal(fake.count("git", "--format=%x01%ct"), 1);
  fake.append(editLine("/r/a.cs", "2026-11-04T10:06:00.000Z"));
  fake.world.head = "h2";
  await store.tick();
  assert.equal(fake.count("git", "--format=%x01%ct"), 2);
});

test("the ahead count is asked at every snapshot, since a push does not move HEAD", async () => {
  const { fake, store } = started();
  await store.tick();
  fake.append(editLine("/r/a.cs", "2026-11-04T10:01:00.000Z"));
  await store.tick();
  assert.equal(fake.count("git", "--count"), 2);
});

test("a push from another terminal (only the upstream's commit moves) or a branch switch at the same commit refreshes the repo on the next probe, with no new event", async () => {
  const { fake, store } = started();
  fake.world.ahead = 2;
  await store.tick();
  assert.equal(store.views[0].ahead, 2);
  const version = store.stateOf("/r").version;
  store.run.lastProbe = 0;
  await store.tick();
  assert.equal(store.stateOf("/r").version, version, "nothing moved, nothing re-read");
  fake.world.ahead = 0;
  fake.world.upstream = "u2";
  store.run.lastProbe = 0;
  await store.tick();
  assert.equal(store.views[0].ahead, 0);
  assert.equal(store.stateOf("/r").version, version + 1);
});

test("a failing git diff against the baseline is a warning, not 'No changes this session', and the next tick recovers", async () => {
  const { fake, store } = started();
  await store.tick();
  fake.world.diffFails = true;
  await store.tick(true);
  assert.ok(store.warnings()[0].includes("bad object"));
  assert.equal(store.stateOf("/r").sig, null);
  fake.world.diffFails = false;
  store.run.lastProbe = 0;
  await store.tick();
  assert.deepEqual(store.warnings(), []);
  assert.equal(store.views.length, 1);
});

test("the baseline comes from the first touch once, one second earlier, and the window ends at the repo's last event", async () => {
  const { fake, store } = started();
  await store.tick();
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  fake.world.stat = "s2";
  await store.tick();
  assert.equal(fake.count("git", "rev-list -1"), 1);
  const before = fake.world.calls.find((c) => c.args.join(" ").includes("rev-list -1")).args.find((a) => a.startsWith("--before="));
  assert.equal(before, "--before=2026-11-04T09:59:59+0000");
  assert.equal(fake.count("git", "--format=%x01%ct"), 1);
  assert.equal(store.stateOf("/r").since, Date.parse("2026-11-04T10:00:00.000Z"));
});

test("a failing baseline shows up as a warning and is retried by the next forced tick", async () => {
  const { fake, store } = started();
  fake.world.baselineFails = 1;
  await store.tick();
  assert.equal(store.views.length, 0);
  assert.ok(store.warnings()[0].startsWith("r: ") && store.warnings()[0].includes("broken"));
  await store.tick(true);
  assert.deepEqual(store.warnings(), []);
  assert.equal(store.views.length, 1);
});

test("a snapshot error is cleared by the next ordinary tick once git works again", async () => {
  const { fake, store } = started();
  await store.tick();
  fake.world.statusFails = true;
  await store.tick(true);
  assert.ok(store.warnings()[0].includes("index locked"));
  fake.world.statusFails = false;
  const result = await store.tick();
  assert.deepEqual(store.warnings(), []);
  assert.equal(result.changed, true);
  assert.equal(store.views.length, 1);
});

test("a tick while another runs is dropped, but a forced one is queued and runs right after", async () => {
  const { fake, store } = started();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.world.hold = async (cmd) => { if (cmd === "wc") { fake.world.hold = null; await gate; } };
  const first = store.tick();
  await until(() => fake.count("wc") === 1);
  assert.equal(await store.tick(), null);
  assert.equal(await store.tick(true), null);
  release();
  await first;
  assert.equal(fake.count("wc"), 2);
});

test("a plain tick that arrives while one runs does not queue another", async () => {
  const { fake, store } = started();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.world.hold = async (cmd) => { if (cmd === "wc") { fake.world.hold = null; await gate; } };
  const first = store.tick();
  await until(() => fake.count("wc") === 1);
  assert.equal(await store.tick(), null);
  release();
  await first;
  assert.equal(fake.count("wc"), 1);
});

test("switching session mid-tick leaves the new session's state untouched by the old tick", async () => {
  const { fake, store } = started();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.world.hold = async (cmd, args) => { if (cmd === "sh" && args[1].includes(".git")) { fake.world.hold = null; await gate; } };
  const stale = store.tick();
  await until(() => fake.count("sh", ".git") >= 1);
  store.start(session("other"));
  release();
  assert.equal(await stale, null);
  assert.equal(store.run.repos.size, 0);
  assert.equal(store.run.roots.size, 0);
  assert.equal(store.views.length, 0);
  assert.equal(store.session.sessionId, "other");
  assert.equal(store.run.busy, false);
  assert.equal((await store.tick(true)).changed, true);
  assert.equal(store.views.length, 1);
});

test("summarize stores a summary for the repo and shows it in the rows", async () => {
  const { store } = started();
  await store.tick();
  await regen(store);
  assert.equal(store.summaryRows()["/r"].headline, "Add rate");
  assert.equal(store.summaryRows()["/r"].stale, false);
});

test("a summary of an older state is shown as stale when the repo changed while it was being written", async () => {
  const { fake, store } = started();
  await store.tick();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.world.hold = async (cmd, args) => { if (cmd === "sh" && args[1].includes("claude \"$@\"")) { fake.world.hold = null; await gate; } };
  store.regenerate("/r");
  await until(() => fake.count("sh", "claude \"$@\"") === 1);
  fake.world.stat = "changed-while-summarizing";
  fake.world.numstat = "7\t0";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick();
  release();
  await until(() => !store.isSummarizing("/r"));
  assert.equal(store.summaryRows()["/r"].stale, true);
});

test("a summary stays fresh when only the transcript moved on, such as another Bash call in the repo", async () => {
  const { fake, store } = started();
  await store.tick();
  await regen(store);
  fake.append(bashLine("cd /r && ls", "2026-11-04T10:09:00.000Z"));
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 2);
  assert.equal(store.summaryRows()["/r"].stale, false);
});

test("a failed summary comes back as a message and leaves no summary", async () => {
  const { fake, store } = started();
  await store.tick();
  fake.world.claude = { code: 1, stdout: "", stderr: "limit" };
  await regen(store);
  assert.equal(store.summaryRows()["/r"].failed, true);
  assert.ok(store.summaryRows()["/r"].headline.includes("limit"));
  assert.equal(store.run.summaries.summarizing.has("/r"), false);
});

test("a summary that finishes after a session switch is dropped without a message", async () => {
  const { fake, store } = started();
  await store.tick();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.world.hold = async (cmd, args) => { if (cmd === "sh" && args[1].includes("claude \"$@\"")) { fake.world.hold = null; await gate; } };
  store.regenerate("/r");
  await until(() => fake.count("sh", "claude \"$@\"") === 1);
  store.start(session("other"));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.run.summaries.summarizing.size, 0);
});

const T = (s) => `2026-11-04T10:00:${String(s).padStart(2, "0")}.000Z`;

test("subagent transcripts found under any project folder are read too", async () => {
  const { fake, store } = started();
  const other = "/home/.claude/projects/other-project/sid/subagents/agent-1.jsonl";
  fake.world.subagents = [other];
  fake.world.files[other] = Buffer.from(editLine("/r/from-subagent.cs", T(5)));
  await store.tick();
  assert.ok(store.run.touches.files.has("/r/from-subagent.cs"));
  assert.equal(fake.count("find"), 0);
});

test("the roots of all new folders are asked in one shell call, and a folder outside any repo is not asked again until a forced tick", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/r/x/y.cs", T(1)) + editLine("/r/z/w.cs", T(2)) + bashLine("cd /elsewhere && ls", T(3));
  const { fake, store } = started({ transcript: text });
  await store.tick();
  assert.equal(fake.count("sh", ".git"), 1);
  assert.ok(store.run.misses.has("/elsewhere"));
  fake.append(editLine("/r/b.cs", T(10)));
  await store.tick();
  assert.equal(fake.count("sh", ".git"), 1);
  await store.tick(true);
  assert.equal(fake.count("sh", ".git"), 2);
});

const padded = (n) => Array.from({ length: n }, () => padLine(1000)).join("");

test("results show while a big transcript is still being read", async () => {
  const text = editLine("/r/a.cs", T(0)) + padded(300) + editLine("/r/f1.cs", T(10)) + padded(300) + editLine("/r/f2.cs", T(20));
  const { store } = started({ transcript: text }, { chunk: 70000, bytesPerTick: 100_000 });
  const first = await store.tick();
  assert.equal(first.pending, true);
  assert.equal(store.views.length, 1);
  let result = first;
  for (let i = 0; i < 10 && result.pending; i++) result = await store.tick();
  assert.equal(result.pending, false);
});

test("after a partial read only the repos whose inputs changed are snapshotted again", async () => {
  const text = editLine("/s/a.cs", T(0), "/s") + padded(300) + editLine("/r/a.cs", T(10)) + padded(300) + editLine("/r/f1.cs", T(20)) + padded(300) + editLine("/r/f2.cs", T(30));
  const { fake, store } = started({ transcript: text, repos: ["/r", "/s"] }, { chunk: 70000, bytesPerTick: 100_000 });
  let result = await store.tick();
  for (let i = 0; i < 12 && result.pending; i++) result = await store.tick();
  assert.equal(result.pending, false);
  const snapshots = (cwd) => fake.world.calls.filter((c) => c.cmd === "git" && c.args.some((a) => a.startsWith("--porcelain")) && c.options.cwd === cwd).length;
  assert.equal(snapshots("/s"), 1);
  assert.ok(snapshots("/r") > 1);
  assert.equal(fake.world.calls.filter((c) => c.args.includes("log") && c.options.cwd === "/r").length, 1);
});

test("an oversize transcript line is reported as a warning once it is skipped", async () => {
  const { store } = started({ transcript: padLine(200_000) + editLine("/r/a.cs", T(0)) }, { chunk: 70000 });
  let result = await store.tick();
  for (let i = 0; i < 10 && result.pending; i++) result = await store.tick();
  assert.ok(store.warnings().some((w) => w.startsWith("transcript: skipped 1 oversize line")), store.warnings().join("|"));
  assert.equal(store.views.length, 1);
});

test("events read before a failing chunk are kept and the repo still shows, with the error", async () => {
  const { fake, store } = started({ transcript: editLine("/r/a.cs", T(0)) + padLine(200_000) + editLine("/r/b.cs", T(1)) }, { chunk: 70000 });
  fake.world.readFails = 1;
  await store.tick();
  assert.ok(store.run.touches.files.has("/r/a.cs"));
  assert.ok(store.error.includes("read failed"));
  assert.equal(store.views.length, 1);
});

test("identifiers for cross-repo links are only read when two repos are shown", async () => {
  const one = started();
  await one.store.tick();
  assert.equal(one.fake.count("sh", 'diff "$b"'), 0);
  const two = started({ transcript: editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s"), repos: ["/r", "/s"] });
  await two.store.tick();
  assert.equal(two.fake.count("sh", 'diff "$b"'), 2);
  assert.equal(two.store.views.length, 2);
  assert.equal(two.store.relations["/r"].length + two.store.relations["/s"].length, 1);
});

test("a folder that was no repo becomes one when a later event names it, without a forced refresh", async () => {
  const { fake, store } = started({ transcript: editLine("/r/a.cs", T(0)) + bashLine("cd /proj && ls", T(1)), repos: ["/r"] });
  await store.tick();
  assert.ok(store.run.misses.has("/proj"));
  assert.equal(store.views.length, 1);
  fake.world.repos.push("/proj");
  fake.append(editLine("/proj/a.cs", T(20), "/proj"));
  await store.tick();
  assert.ok(!store.run.misses.has("/proj"));
  assert.deepEqual(store.views.map((v) => v.root).sort(), ["/proj", "/r"]);
});

test("misses that no new event names are not asked about again", async () => {
  const { fake, store } = started({ transcript: editLine("/r/a.cs", T(0)) + bashLine("cd /proj && ls", T(1)) });
  await store.tick();
  const asked = fake.count("sh", ".git");
  fake.append(editLine("/r/b.cs", T(30)));
  await store.tick();
  assert.equal(fake.count("sh", ".git"), asked);
});

test("the oversize-line warning counts a line once, even when the transcript is read again after a reset", async () => {
  const first = padLine(200_000) + editLine("/r/a.cs", T(0));
  const { fake, store } = started({ transcript: first }, { chunk: 70000 });
  let result = await store.tick();
  for (let i = 0; i < 10 && result.pending; i++) result = await store.tick();
  assert.ok(store.warnings().some((w) => w.startsWith("transcript: skipped 1 oversize line")));
  fake.world.files[fake.main] = Buffer.from(padLine(150_000) + editLine("/r/a.cs", T(0)));
  result = await store.tick();
  for (let i = 0; i < 10 && result.pending; i++) result = await store.tick();
  const notes = store.warnings().filter((w) => w.startsWith("transcript"));
  assert.equal(notes.length, 1);
  assert.ok(notes[0].startsWith("transcript: skipped 1 oversize line"), notes[0]);
});

const regen = async (store, root = "/r") => {
  store.regenerate(root);
  await until(() => !store.isSummarizing(root));
  await new Promise((resolve) => setImmediate(resolve));
};

const REPO_REPLY = (name) => ({ code: 0, stdout: JSON.stringify({ headline: `Add ${name} endpoint`, points: [`new route api/${name}`, "SP usp_Get"] }), stderr: "" });
const OVERVIEW_REPLY = { code: 0, stdout: JSON.stringify({ overview: "DB adds a column, the API exposes it." }), stderr: "" };
const replies = (text) => (text.includes("Repos (in layer order)") ? OVERVIEW_REPLY : REPO_REPLY(/Repo: (\S+)/.exec(text)?.[1] ?? "x"));
const claudeCalls = (fake) => fake.world.calls.filter((c) => c.cmd === "sh" && c.args[1].includes('claude "$@"'));
const settle = async (fake, count, store) => {
  await until(() => claudeCalls(fake).length >= count && fake.world.claudeRunning === 0 && store.run.summaries.summarizing.size === 0 && !store.run.summaries.overviewFor().running);
  await new Promise((resolve) => setImmediate(resolve));
};
const auto = (options, storeOptions) => started(options, { autoSummary: true, ...storeOptions });

test("on the first tick after the first snapshot, a repo with no cached summary is summarized at once", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  assert.equal(claudeCalls(fake).length, 1);
  assert.equal(store.summaryRows()["/r"].headline, "Add r endpoint");
});

test("opening the window again with the same repo state makes no call, and a changed repo is refreshed at once", async () => {
  const { fake, store, storage } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  const reopened = new Store(fake.io, undefined, { storage, autoSummary: true });
  reopened.start(session());
  await reopened.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 1);
  assert.equal(reopened.summaryRows()["/r"].headline, "Add r endpoint");
  fake.world.stat = "changed-while-closed";
  fake.world.numstat = "9\t0";
  const again = new Store(fake.io, undefined, { storage, autoSummary: true });
  again.start(session());
  await again.tick();
  await settle(fake, 2, store);
  assert.equal(claudeCalls(fake).length, 2);
});

// A clock the store reads for the settle rule, with the session's last edit at the same instant, so the session counts as busy until it moves on.
const clocked = (options) => {
  const clock = { at: Date.parse("2026-11-04T10:05:00.000Z") };
  const made = auto(options, { now: () => clock.at });
  return { ...made, clock };
};

test("on open a repo with no summary waits for STABLE_MS when the session is still busy, then is summarized", async () => {
  const { fake, store, clock } = clocked({ transcript: editLine("/r/a.cs", "2026-11-04T10:05:00.000Z") });
  fake.world.claude = replies;
  await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 0);
  clock.at += STABLE_MS - 1;
  await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 0);
  clock.at += 1;
  await store.tick();
  await settle(fake, 1, store);
  assert.equal(claudeCalls(fake).length, 1);
});

test("a language switch's extra schedule does not settle a busy repo early", async () => {
  const { fake, store, clock } = clocked({ transcript: editLine("/r/a.cs", "2026-11-04T10:05:00.000Z") });
  fake.world.claude = replies;
  await store.tick();
  for (let i = 0; i < 3; i++) { store.run.summaries.schedule(); clock.at += 1000; }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 0);
});

test("while the window stays open, a change waits until the repo has been unchanged for STABLE_MS before it is summarized", async () => {
  const { fake, store, clock } = clocked({ transcript: editLine("/r/a.cs", "2026-11-04T10:05:00.000Z") });
  fake.world.claude = replies;
  await store.tick();
  clock.at += STABLE_MS;
  await store.tick();
  await settle(fake, 1, store);
  fake.world.stat = "s2";
  fake.world.numstat = "9\t0";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:06:00.000Z"));
  clock.at += 1000;
  await store.tick();
  for (const step of [1000, 10000, STABLE_MS - 12000]) {
    clock.at += step;
    await store.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(claudeCalls(fake).length, 1, `after +${step}`);
  }
  clock.at += 2000;
  await store.tick();
  await settle(fake, 2, store);
  assert.equal(claudeCalls(fake).length, 2);
});

test("a commit or an amend that changes neither the owned diff nor the subjects does not make a new summary", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  fake.world.head = "h2";
  fake.world.stat = "s2";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 1);
  assert.equal(store.summaryRows()["/r"].stale, false);
});

test("a tiny change keeps the old headline, marked stale, and sends nothing", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  fake.world.stat = "s2";
  fake.world.numstat = "2\t0";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick();
  await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 1);
  assert.equal(store.summaryRows()["/r"].stale, true);
  assert.equal(store.summaryRows()["/r"].headline, "Add r endpoint");
});

test("a touch or a rewrite that keeps the status and line counts changes no key, so it costs no summary and the summary stays fresh", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  fake.world.stat = "s2";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick();
  await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 1);
  assert.equal(store.summaryRows()["/r"].stale, false);
});

test("a failed summary is shown, not retried in a loop, and tried once more when the repo changes", async () => {
  const { fake, store } = auto();
  fake.world.claude = { code: 1, stdout: "", stderr: "limit reached" };
  await store.tick();
  await settle(fake, 1, store);
  assert.ok(store.summaryRows()["/r"].headline.includes("limit reached") && store.summaryRows()["/r"].failed);
  for (let i = 0; i < 3; i++) await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 1);
  fake.world.stat = "s2";
  fake.world.numstat = "9\t0";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick();
  await store.tick();
  await settle(fake, 2, store);
  assert.equal(claudeCalls(fake).length, 2);
});

test("at most two summaries run at the same time", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s") + editLine("/t/a.cs", T(2), "/t");
  const { fake, store } = auto({ transcript: text, repos: ["/r", "/s", "/t"] });
  fake.world.claude = replies;
  let release;
  fake.world.claudeGate = new Promise((resolve) => { release = resolve; });
  await store.tick();
  await until(() => fake.world.claudeRunning === 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.world.claudePeak, 2);
  fake.world.claudeGate = null;
  release();
  await settle(fake, 3, store);
  assert.equal(fake.world.claudePeak, 2);
  assert.equal(Object.keys(store.summaryRows()).length, 3);
});

test("after dispose nothing new starts and a result that arrives late is dropped", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s") + editLine("/t/a.cs", T(2), "/t");
  const { fake, store } = auto({ transcript: text, repos: ["/r", "/s", "/t"] });
  fake.world.claude = replies;
  let release;
  fake.world.claudeGate = new Promise((resolve) => { release = resolve; });
  await store.tick();
  await until(() => fake.world.claudeRunning === 2);
  await store.dispose();
  fake.world.claudeGate = null;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 2);
  assert.equal(await store.tick(), null);
});

test("a session switch cancels the old session's queue", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s") + editLine("/t/a.cs", T(2), "/t");
  const { fake, store } = auto({ transcript: text, repos: ["/r", "/s", "/t"] });
  fake.world.claude = replies;
  let release;
  fake.world.claudeGate = new Promise((resolve) => { release = resolve; });
  await store.tick();
  await until(() => fake.world.claudeRunning === 2);
  store.start(session("other"));
  fake.world.claudeGate = null;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 2);
});

test("the manual regenerate bypasses the cache", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  store.regenerate("/r");
  await settle(fake, 2, store);
  assert.equal(claudeCalls(fake).length, 2);
});

test("with two repos an overview is written once the per-repo summaries are in, and it is cached by their keys", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s");
  const { fake, store, storage } = auto({ transcript: text, repos: ["/r", "/s"] });
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 3, store);
  assert.equal(claudeCalls(fake).length, 3);
  assert.equal(store.overviewState().text, "DB adds a column, the API exposes it.");
  assert.equal(store.overviewState().stale, false);
  await store.tick();
  await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 3);
  const reopened = new Store(fake.io, undefined, { storage, autoSummary: true });
  reopened.start(session());
  await reopened.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 3);
  assert.equal(reopened.overviewState().text, "DB adds a column, the API exposes it.");
});

test("with one repo there is no overview", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  await store.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claudeCalls(fake).length, 1);
  assert.equal(store.overviewState().text, null);
});

test("the overview prompt is redacted and isolated like the others, and carries the repo headlines", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s");
  const { fake, store } = auto({ transcript: text, repos: ["/r", "/s"] });
  fake.world.claude = (prompt) => (prompt.includes("Repos (in layer order)")
    ? OVERVIEW_REPLY
    : { code: 0, stdout: JSON.stringify({ headline: "Set DB_PASSWORD=hunter2 for it", points: ["ok"] }), stderr: "" });
  await store.tick();
  await settle(fake, 3, store);
  const overview = [...fake.world.prompts.values()].find((p) => p.includes("Repos (in layer order)"));
  assert.ok(overview.includes("DB_PASSWORD=‹v›") && !overview.includes("hunter2"));
  const call = claudeCalls(fake).find((c) => fake.world.prompts.get(c.args[3]).includes("Repos (in layer order)"));
  assert.ok(call.args.includes("--strict-mcp-config") && call.args.includes("--no-session-persistence"));
});

test("the model is one option, haiku by default", async () => {
  const one = auto();
  one.fake.world.claude = replies;
  await one.store.tick();
  await settle(one.fake, 1, one.store);
  assert.equal(claudeCalls(one.fake)[0].args[claudeCalls(one.fake)[0].args.indexOf("--model") + 1], "haiku");
  const two = auto({}, { model: "sonnet" });
  two.fake.world.claude = replies;
  await two.store.tick();
  await settle(two.fake, 1, two.store);
  assert.equal(claudeCalls(two.fake)[0].args[claudeCalls(two.fake)[0].args.indexOf("--model") + 1], "sonnet");
});

test("the store announces summary changes through a revision the panel can wait on", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  const before = store.rev;
  const waiting = store.changed(before);
  await store.tick();
  assert.equal(await waiting, true);
  await settle(fake, 1, store);
  assert.ok(store.rev > before);
  assert.equal(await store.changed(before), true);
  await store.dispose();
  assert.equal(await store.changed(store.rev), false);
});

const systemOf = (call) => call.args.join(" ");

test("summaries are written in the chosen language, English by default", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  assert.equal(store.language, "en");
  await store.tick();
  await settle(fake, 1, store);
  assert.ok(systemOf(claudeCalls(fake)[0]).includes("Write in English"));
});

test("switching language regenerates, shows nothing in the old language, and switching back hits the cache", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  store.setLanguage("zh-TW");
  assert.equal(store.language, "zh-TW");
  assert.equal(store.summaryRows()["/r"]?.headline, "summarizing…");
  await settle(fake, 2, store);
  assert.ok(systemOf(claudeCalls(fake)[1]).includes("Traditional Chinese"));
  store.setLanguage("en");
  await new Promise((resolve) => setImmediate(resolve));
  await store.tick();
  await settle(fake, 2, store);
  assert.equal(claudeCalls(fake).length, 2);
  assert.equal(store.summaryRows()["/r"].headline, "Add r endpoint");
  assert.equal(store.summaryRows()["/r"].stale, false);
});

test("the chosen language is saved to the settings file", async () => {
  const { fake, store } = auto();
  fake.world.claude = replies;
  await store.tick();
  await settle(fake, 1, store);
  store.setLanguage("ja");
  await settle(fake, 2, store);
  const written = [...fake.world.prompts.entries()].filter(([p]) => p.endsWith("session-changes.json")).map(([, text]) => text).join("");
  assert.ok(written.includes('"summaryLanguage": "ja"'), written);
});

test("a failure is recorded against the content that was tried, not the content the repo has by the time claude answers", async () => {
  const { fake, store } = started();
  await store.tick();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  fake.world.claude = { code: 1, stdout: "", stderr: "limit" };
  fake.world.hold = async (cmd, args) => { if (cmd === "sh" && args[1].includes("claude \"$@\"")) { fake.world.hold = null; await gate; } };
  store.regenerate("/r");
  await until(() => fake.count("sh", "claude \"$@\"") === 1);
  fake.world.stat = "changed-while-summarizing";
  fake.world.numstat = "7\t0";
  fake.append(editLine("/r/a.cs", "2026-11-04T10:05:00.000Z"));
  await store.tick();
  release();
  await until(() => !store.isSummarizing("/r"));
  assert.equal(store.summaryRows()["/r"]?.failed, undefined);
});

test("a language that could not be saved is reported in the warnings, and the choice still applies", async () => {
  const { fake, store } = auto();
  fake.io.writeTextFile = async () => { throw new Error("disk full"); };
  await store.tick();
  store.setLanguage("ja");
  await until(() => store.warnings().some((w) => w.includes("language")));
  assert.ok(store.warnings().some((w) => w.includes("language") && w.includes("disk full")));
  assert.equal(store.language, "ja");
});

test("a failed save of an earlier language that rejects after a later one was saved leaves no warning", async () => {
  const { fake, store } = auto();
  let fail;
  const gate = new Promise((resolve) => { fail = resolve; });
  const saved = {};
  fake.io.writeTextFile = async (path, text) => {
    if (text.includes('"en"')) { await gate; throw new Error("disk full"); }
    saved.ja = true;
  };
  await store.tick();
  store.setLanguage("en");
  store.setLanguage("ja");
  fail();
  await until(() => saved.ja);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.language, "ja");
  assert.ok(!store.warnings().some((w) => w.includes("language")), store.warnings().join("|"));
});

test("a tick says whether the transcript grew, which is what the panel slows its polling on", async () => {
  const { fake, store } = started();
  assert.equal((await store.tick()).grew, true);
  assert.equal((await store.tick()).grew, false);
  fake.append(bashLine("cd /r && ls", "2026-11-04T10:01:00.000Z"));
  assert.equal((await store.tick()).grew, true);
  assert.equal((await store.tick()).grew, false);
});

test("the subagent list is globbed again after the transcript grew or on a forced tick, and otherwise reused", async () => {
  const { fake, store } = started();
  const globs = () => fake.count("sh", "subagents");
  await store.tick();
  assert.equal(globs(), 1);
  await store.tick();
  assert.equal(globs(), 2);
  await store.tick();
  assert.equal(globs(), 2);
  await store.tick(true);
  assert.equal(globs(), 3);
});

test("the cross-repo identifiers are read again only when the owned files or HEAD change, not on every snapshot", async () => {
  const text = editLine("/r/a.cs", T(0)) + editLine("/s/a.cs", T(1), "/s");
  const { fake, store } = started({ transcript: text, repos: ["/r", "/s"] });
  await store.tick();
  assert.equal(fake.count("sh", 'diff "$b"'), 2);
  fake.append(editLine("/r/a.cs", T(30)));
  fake.world.stat = "s2";
  await store.tick();
  assert.equal(fake.count("git", "--porcelain"), 4);
  assert.equal(fake.count("sh", 'diff "$b"'), 2);
  fake.append(editLine("/r/a.cs", T(40)));
  fake.world.head = "h2";
  fake.world.stat = "s3";
  await store.tick();
  assert.equal(fake.count("sh", 'diff "$b"'), 4);
});

test("the summary key is worked out once per snapshot and language, and follows the snapshot", async () => {
  const { fake, store } = started();
  await store.tick();
  const summaries = store.run.summaries;
  const state = store.stateOf("/r");
  const first = summaries.keyOf(state, "en");
  assert.equal(summaries.keyOf(state, "en"), first);
  assert.notEqual(summaries.keyOf(state, "ja"), first);
  assert.equal(summaries.keys.get("/r").byLanguage.size, 2);
  fake.world.numstat = "9\t0";
  fake.append(editLine("/r/a.cs", T(30)));
  await store.tick();
  assert.notEqual(summaries.keyOf(store.stateOf("/r"), "en"), first);
  assert.equal(summaries.keys.get("/r").byLanguage.size, 1);
});

test("the prompt folder and writer are made once", () => {
  const { store } = started();
  assert.equal(store.prompts, store.prompts);
  assert.equal(store.prompts.dir, "/home/.config/herdr-app/session-changes-tmp");
});

test("the probe's stats are kept per file for the open diff and the key of an untracked file", async () => {
  const { fake, store } = started();
  fake.world.stat = "/r/a.cs 150:30\n";
  await store.tick();
  assert.deepEqual(store.stateOf("/r").stats.get("a.cs"), { mtime: "150", size: "30" });
});
