import { test } from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../mods/session-changes/git.js";
import { EMPTY_TREE } from "../mods/session-changes/gitparse.js";

function world({ repos = [], dirs = [], links = {}, symlinks = [], texts = {}, git = [] } = {}) {
  const calls = [];
  let running = 0, peak = 0, made = 0;
  const real = (path) => Object.entries(links).reduce((p, [from, to]) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p), path);
  const exists = (path) => dirs.includes(real(path)) || repos.some((r) => real(path) === r || real(path).startsWith(`${r}/`) && dirs.includes(real(path)));
  const exec = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, options });
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    if (cmd === "test") {
      const [flag, path] = args;
      return { code: flag === "-L" ? (symlinks.includes(path) ? 0 : 1) : exists(path) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "sh" && args[1].includes("diff \"$b\"")) {
      const [, , , limit, root, baseline, context, ...paths] = args;
      const wanted = git.find(([needle]) => `diff ${baseline} -U${context} -- ${paths.join(" ")}`.includes(needle));
      if (wanted && wanted[1] instanceof Error) return { code: 0, stdout: "", stderr: wanted[1].message };
      return { code: 0, stdout: (wanted ? wanted[1] : "").slice(0, Number(limit)), stderr: "" };
    }
    if (cmd === "sh" && args[1].includes("head -c")) {
      const [, , , nonce, limit, ...paths] = args;
      const record = (path) => (symlinks.includes(path) || texts[path] === undefined ? "-\n" : `+\n${texts[path].slice(0, Number(limit))}`);
      return { code: 0, stdout: paths.map((path) => `\x01${nonce}${record(path)}`).join(""), stderr: "" };
    }
    if (cmd === "mktemp") return { code: 0, stdout: `/scratch/${++made}\n`, stderr: "" };
    if (cmd === "rm") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "sh" || cmd === "stat") return { code: 0, stdout: `${cmd}-out`, stderr: "" };
    const sub = args.slice(args.indexOf("core.fsmonitor=false") + 3).filter((a) => !a.startsWith("-c") && !a.startsWith("core.") && !a.startsWith("diff.autoRefreshIndex"));
    const cwd = real(options.cwd);
    if (!exists(options.cwd)) throw new Error("no such folder");
    if (sub[0] === "rev-parse" && sub[1] === "--show-toplevel") {
      const root = repos.find((r) => cwd === r || cwd.startsWith(`${r}/`));
      return root ? { code: 0, stdout: `${root}\n${cwd.slice(root.length + 1)}${cwd === root ? "" : "/"}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "not a git repository" };
    }
    const wanted = git.find(([needle]) => sub.join(" ").includes(needle));
    if (wanted && wanted[1] instanceof Error) return { code: 128, stdout: "", stderr: wanted[1].message };
    return { code: 0, stderr: "", stdout: wanted ? wanted[1] : "" };
  };
  return { io: { exec, readTextFile: async (p) => texts[p] ?? null }, calls, peak: () => peak };
}

test("every git read carries the no-lock and literal-pathspec flags", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  const git = createGit(w.io);
  await git.snapshotOf("/r", "abc", 1000, 2000);
  await git.diffLines("/r", "abc", { path: "[id]/page.vue", fresh: false });
  const gits = w.calls.filter((c) => c.cmd === "git");
  assert.ok(gits.length >= 5);
  for (const call of gits) {
    assert.ok(call.args.includes("--literal-pathspecs") && call.args.includes("--no-optional-locks"));
    assert.ok(call.args.indexOf("--literal-pathspecs") < call.args.findIndex((a) => ["status", "diff", "log", "rev-list", "rev-parse"].includes(a)));
  }
  const script = w.calls.find((c) => c.cmd === "sh" && c.args[1].includes("diff"))?.args[1] ?? "";
  for (const flag of ["--no-optional-locks", "--literal-pathspecs", "core.fsmonitor=false", "diff.autoRefreshIndex=false"]) assert.ok(script.includes(flag), flag);
});

const stamp = (iso) => Math.floor(Date.parse(iso) / 1000);

test("the commit log is read since the window start and the baseline, and the window end is applied to what it returns", async () => {
  const w = world({
    repos: ["/r"], dirs: ["/r"],
    git: [["--format=%x01%ct", `\x01${stamp("2026-11-04T10:30:00Z")} inside\n\na.cs\n\x01${stamp("2026-11-04T12:00:00Z")} after\n\nb.cs\n`]],
  });
  const git = createGit(w.io);
  const snap = await git.snapshotOf("/r", "abc", Date.parse("2026-11-04T10:00:00Z"), Date.parse("2026-11-04T11:00:00Z"));
  const log = w.calls.find((c) => c.args.includes("log")).args;
  assert.ok(log.includes("--since=2026-11-04T10:00:00+0000") && log.includes("abc..HEAD") && !log.some((a) => a.startsWith("--until")));
  assert.deepEqual(snap.commits.map((c) => c.subject), ["inside"]);
  assert.equal((await git.snapshotOf("/r", "abc", Date.parse("2026-11-04T10:00:00Z"), Date.parse("2026-11-04T13:00:00Z"), snap)).commits.length, 2);
  await git.snapshotOf("/r", EMPTY_TREE, 1000, 2000);
  assert.ok(w.calls.filter((c) => c.args.includes("log")).at(-1).args.includes("HEAD"));
});

test("a snapshot reads the log again only when HEAD, the baseline or the window start changed, and the ahead count and branch every time", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--abbrev-ref", "h1\nu1\nmain\n"]] });
  const git = createGit(w.io);
  const logs = () => w.calls.filter((c) => c.args.includes("log")).length;
  const first = await git.snapshotOf("/r", "abc", 1, 2);
  const second = await git.snapshotOf("/r", "abc", 1, 5000, first);
  assert.equal(logs(), 1);
  assert.equal(w.calls.filter((c) => c.args.includes("--count")).length, 2);
  assert.equal(w.calls.filter((c) => c.args.includes("rev-parse")).length, 2);
  await git.snapshotOf("/r", "other-baseline", 1, 2, second);
  await git.snapshotOf("/r", "abc", 0, 2, second);
  assert.equal(logs(), 3);
  const moved = world({ repos: ["/r"], dirs: ["/r"], git: [["--abbrev-ref", "h2\nu1\nmain\n"]] });
  await createGit(moved.io).snapshotOf("/r", "abc", 1, 2, first);
  assert.equal(moved.calls.filter((c) => c.args.includes("log")).length, 1);
});

test("a snapshot takes the status letters and the line counts from one git diff", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--raw", ":100644 100644 a b M\0a.cs\0:000000 100644 a b A\0b.cs\0" + "2\t1\ta.cs\0" + "5\t0\tb.cs\0"]] });
  const snap = await createGit(w.io).snapshotOf("/r", "abc", 1, 2);
  assert.equal(w.calls.filter((c) => c.args.includes("diff")).length, 1);
  assert.deepEqual(snap.files.map((f) => [f.path, f.status, f.added, f.deleted]), [["a.cs", "M", 2, 1], ["b.cs", "A", 5, 0]]);
});

test("a repo with no upstream has no ahead count", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--count", new Error("no upstream configured")]] });
  assert.equal((await createGit(w.io).snapshotOf("/r", "abc", 1, 2)).ahead, null);
});

test("snapshotOf turns git output into files, commits, branch and ahead count", async () => {
  const w = world({
    repos: ["/r"], dirs: ["/r"],
    git: [
      ["--porcelain", " M a.cs\0?? n.txt\0"], ["--raw", ":100644 100644 a b M\0a.cs\0" + "2\t1\ta.cs\0"],
      ["log", `\x01${stamp("2026-11-04T10:30:00Z")} feat x\n\na.cs\n`], ["--count", "2\n"], ["--abbrev-ref", "deadbeef\nu1\nmain\n"],
    ],
  });
  const snap = await createGit(w.io).snapshotOf("/r", "abc", 1, Date.parse("2026-11-04T11:00:00Z"));
  assert.deepEqual(snap.files.map((f) => [f.path, f.status, f.fresh]), [["a.cs", "M", false], ["n.txt", "A", true]]);
  assert.equal(snap.branch, "main");
  assert.equal(snap.head, "deadbeef");
  assert.equal(snap.ahead, 2);
  assert.equal(snap.commits[0].subject, "feat x");
});

test("no more than four git or stat processes run at once", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  const git = createGit(w.io);
  await Promise.all([
    ...Array.from({ length: 12 }, () => git.snapshotOf("/r", "abc", 1, 2)),
    ...Array.from({ length: 6 }, () => git.probeOf("/r", ["a", "b"])),
  ]);
  assert.ok(w.peak() <= 4, `peak ${w.peak()}`);
});

test("a symlink or secret is never previewed or fed to the summary", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], symlinks: ["/r/link"], texts: { "/r/link": "AKIA...", "/r/ok.txt": "hi\n" } });
  const git = createGit(w.io);
  assert.equal(await git.readFresh("/r", "link", 100), null);
  assert.equal(await git.readFresh("/r", "ok.txt", 100), "hi\n");
  assert.deepEqual(await git.diffLines("/r", "abc", { path: ".env", secret: true }), ["Secret file: diff hidden"]);
  assert.ok((await git.diffLines("/r", "abc", { path: "link", fresh: true }))[0].startsWith("Cannot preview"));
});

test("fresh files are read in one process, a symlink or unreadable one answering null and a binary one too", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], symlinks: ["/r/link"], texts: { "/r/link": "AKIA", "/r/a.txt": "one\n", "/r/b.txt": "two\n", "/r/bin": "x\0y" } });
  const got = await createGit(w.io).readFreshMany("/r", ["a.txt", "link", "missing", "b.txt", "bin"], 100);
  assert.deepEqual(got, ["one\n", null, null, "two\n", null]);
  assert.equal(w.calls.filter((c) => c.cmd === "sh").length, 1);
  assert.equal(w.calls.filter((c) => c.cmd === "test" || c.cmd === "head").length, 0);
  assert.deepEqual(await createGit(world().io).readFreshMany("/r", [], 100), []);
});

test("a file whose text contains the record marker character is still read whole", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], texts: { "/r/a.txt": "x\x01y\n", "/r/b.txt": "z\n" } });
  assert.deepEqual(await createGit(w.io).readFreshMany("/r", ["a.txt", "b.txt"], 100), ["x\x01y\n", "z\n"]);
});

test("the identifiers of a repo come from one tracked diff and one read of its untracked files", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], texts: { "/r/n.txt": "walletCurrencyName = 1\n" }, git: [["-U0", "+++ b/a.cs\n+var tableOrderId = 2;\n"]] });
  const files = [{ path: "a.cs", fresh: false }, { path: "n.txt", fresh: true }, { path: ".env", fresh: true, secret: true }];
  const idents = await createGit(w.io).identsOf("/r", "abc", files);
  assert.ok(idents.includes("tableorderid") && idents.includes("walletcurrencyname"));
  assert.equal(w.calls.filter((c) => c.cmd === "sh" && !c.args[1].includes("diff")).length, 1);
  const diffs = w.calls.filter((c) => c.cmd === "sh" && c.args[1].includes("diff"));
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0].args.slice(3, 8), [String(200_000), "/r", "abc", "0", "a.cs"]);
});

test("a tracked diff too large to show is answered from the line counts, without asking git for it", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  const rows = await createGit(w.io).diffLines("/r", "abc", { path: "huge.sql", fresh: false, added: 30000, deleted: 5, binary: false });
  assert.ok(rows[0].startsWith("Diff too large") && rows[0].includes("+30000"));
  assert.equal(w.calls.filter((c) => c.cmd === "git").length, 0);
});

test("base versions go to this instance's own scratch folder, one numbered file per path, reused when the path is opened again", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  const git = createGit(w.io);
  await git.baseVersionFile("/r", "abc", "a.cs");
  await git.baseVersionFile("/r", "abc", "-weird.cs");
  await git.baseVersionFile("/r", "abc", "a.cs");
  assert.equal(w.calls.filter((c) => c.cmd === "mktemp").length, 1);
  const shells = w.calls.filter((c) => c.cmd === "sh");
  assert.ok(shells[0].args[1].startsWith("umask 077;") && shells[0].args[1].includes("basename --"));
  assert.deepEqual(shells.map((c) => [c.args[6], c.args[7]]), [["0", "/scratch/1"], ["1", "/scratch/1"], ["0", "/scratch/1"]]);
});

test("two instances never share a scratch folder, and disposing one leaves the other's files alone", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  const first = createGit(w.io), second = createGit(w.io);
  await first.baseVersionFile("/r", "abc", "a.cs");
  await second.baseVersionFile("/r", "abc", "a.cs");
  await first.dispose();
  const removed = w.calls.filter((c) => c.cmd === "rm").map((c) => c.args.at(-1));
  assert.deepEqual(removed, ["/scratch/1"]);
  await createGit(w.io).dispose();
  assert.equal(w.calls.filter((c) => c.cmd === "rm").length, 1);
});

test("diffText asks git not to quote non-ASCII paths", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  await createGit(w.io).diffText("/r", "abc", ["café.cs"]);
  assert.ok(w.calls.find((c) => c.cmd === "sh").args[1].includes("core.quotepath=false"));
});

test("baselineOf looks one second before the first touch, so a commit in that same second is not the baseline", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["rev-list -1", "abc123\n"]] });
  assert.equal(await createGit(w.io).baselineOf("/r", Date.parse("2026-11-04T10:00:05.900Z")), "abc123");
  assert.ok(w.calls.find((c) => c.args.includes("rev-list")).args.includes("--before=2026-11-04T10:00:04+0000"));
});

test("baselineOf is the empty tree when nothing is older, or when the repo has no commits yet", async () => {
  const none = world({ repos: ["/r"], dirs: ["/r"], git: [["rev-list -1", ""]] });
  assert.equal(await createGit(none.io).baselineOf("/r", 1000), EMPTY_TREE);
  const fresh = world({ repos: ["/r"], dirs: ["/r"], git: [["rev-list -1", new Error("bad revision")], ["--verify", new Error("needed a single revision")]] });
  assert.equal(await createGit(fresh.io).baselineOf("/r", 1000), EMPTY_TREE);
});

test("baselineOf throws when git fails in a repo that does have a HEAD, instead of caching the empty tree", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["rev-list -1", new Error("fatal: corrupt")], ["--verify", "abc\n"]] });
  await assert.rejects(createGit(w.io).baselineOf("/r", 1000), /corrupt/);
});

test("a file is read through head -c, so only the limit is ever loaded", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], texts: { "/r/big.txt": "x".repeat(1000) } });
  const text = await createGit(w.io).readFresh("/r", "big.txt", 100);
  assert.equal(text.length, 100);
  const call = w.calls.find((c) => c.cmd === "sh");
  assert.ok(call.args[1].includes('head -c "$l"'));
  assert.deepEqual(call.args.slice(4), ["100", "/r/big.txt"]);
  assert.equal(await createGit(w.io).readFresh("/r", "missing.txt", 100), null);
});

test("a snapshot reads HEAD and the branch with one git call", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--abbrev-ref", "abc\nu1\nfeature\n"]] });
  await createGit(w.io).snapshotOf("/r", "base", 1, 2);
  assert.equal(w.calls.filter((c) => c.args.includes("rev-parse")).length, 1);
});

test("probeOf reads HEAD and the stats of the index and the edited files as two parallel processes", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--git-path", ".git/index\n"], ["rev-parse HEAD", "abc\nup1\nmain\n"]] });
  const sig = await createGit(w.io).probeOf("/r", ["a.cs", "b.cs"]);
  const stat = w.calls.find((c) => c.cmd === "stat");
  assert.deepEqual(stat.args.slice(2), ["/r/.git/index", "/r/a.cs", "/r/b.cs"]);
  assert.ok(w.calls.some((c) => c.cmd === "git" && c.args.includes("HEAD") && !c.args.includes("--git-path")));
  assert.ok(sig.startsWith("abc up1 main|"));
});

test("the index path is asked once per repo, and an absolute one is used as given", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--git-path", "/elsewhere/modules/r/index\n"]] });
  const git = createGit(w.io);
  await git.probeOf("/r", ["a.cs"]);
  await git.probeOf("/r", ["a.cs"]);
  assert.equal(w.calls.filter((c) => c.args.includes("--git-path")).length, 1);
  assert.equal(w.calls.filter((c) => c.cmd === "stat")[1].args[2], "/elsewhere/modules/r/index");
});

test("a probe changes when only the index changed, so a git add or checkout is noticed", async () => {
  let indexStat = "m1";
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--git-path", ".git/index\n"], ["rev-parse HEAD", "abc\n"]] });
  const exec = async (cmd, args, options) => (cmd === "stat" ? { code: 0, stdout: `idx ${indexStat}`, stderr: "" } : w.io.exec(cmd, args, options));
  const git = createGit({ ...w.io, exec });
  const before = await git.probeOf("/r", ["a.cs"]);
  indexStat = "m2";
  assert.notEqual(await git.probeOf("/r", ["a.cs"]), before);
});

test("a failed mktemp is not remembered, so the next diff copy tries again and dispose still has nothing to remove", async () => {
  let attempts = 0;
  const io = { exec: async (cmd) => { if (cmd === "mktemp" && ++attempts === 1) throw new Error("no space"); return { code: 0, stdout: cmd === "mktemp" ? "/scratch/1\n" : "out", stderr: "" }; }, readTextFile: async () => null };
  const git = createGit(io);
  await assert.rejects(git.baseVersionFile("/r", "abc", "a.cs"), /no space/);
  assert.equal(await git.baseVersionFile("/r", "abc", "a.cs"), "out");
  assert.equal(attempts, 2);
});

test("the commit-ownership log reads files the same way the snapshot does, without rename detection", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"] });
  await createGit(w.io).snapshotOf("/r", "abc", 1, 2);
  const log = w.calls.find((c) => c.args.includes("log")).args;
  assert.ok(log.includes("--no-renames"));
  for (const call of w.calls.filter((c) => c.args.includes("diff") || c.args.includes("status"))) assert.ok(call.args.includes("--no-renames"));
});

test("a snapshot reports every changed file, and leaves the cap to the repo view", async () => {
  const names = Array.from({ length: 2000 }, (_, i) => `?? node_modules/pkg/f${i}.js\0`).join("");
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--porcelain", names]] });
  const snap = await createGit(w.io).snapshotOf("/r", "abc", 1, 2);
  assert.equal(snap.files.length, 2000);
});

const probeWith = async (refs, files = ["a.cs"]) => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--git-path", ".git/index\n"], ["rev-parse HEAD", refs]] });
  return createGit(w.io).probeOf("/r", files);
};

test("a probe changes when only the upstream's commit moved (a push from another terminal) or only the branch changed, with HEAD the same", async () => {
  const base = await probeWith("h1\nu1\nmain\n");
  assert.equal(await probeWith("h1\nu1\nmain\n"), base);
  assert.notEqual(await probeWith("h1\nu2\nmain\n"), base);
  assert.notEqual(await probeWith("h1\nu1\nother\n"), base);
});

test("HEAD, the upstream and the branch come from one rev-parse, and a repo with no upstream asks again for HEAD and the branch only", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--git-path", ".git/index\n"], ["--abbrev-ref", "h1\nu1\nmain\n"]] });
  await createGit(w.io).probeOf("/r", ["a.cs"]);
  const parses = w.calls.filter((c) => c.args.includes("rev-parse") && c.args.includes("--abbrev-ref"));
  assert.equal(parses.length, 1);
  assert.ok(parses[0].args.includes("@{u}"));

  const bare = world({ repos: ["/r"], dirs: ["/r"], git: [["--git-path", ".git/index\n"], ["HEAD @{u}", new Error("no upstream configured")], ["--abbrev-ref", "h1\nmain\n"]] });
  const sig = await createGit(bare.io).probeOf("/r", ["a.cs"]);
  assert.ok(sig.startsWith("h1  main|"), sig);
  const snap = await createGit(bare.io).snapshotOf("/r", "abc", 1, 2);
  assert.deepEqual([snap.head, snap.branch], ["h1", "main"]);
});

test("a branch name holding a pipe does not end the probe's first field early", async () => {
  const sig = await probeWith("h1\nu1\nfix|it\n");
  assert.equal(sig.indexOf("|"), sig.lastIndexOf("fix_it") + "fix_it".length);
});

test("a snapshot throws when git diff against the baseline fails, instead of reporting no changes", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["--raw", new Error("fatal: bad object abc")]] });
  await assert.rejects(createGit(w.io).snapshotOf("/r", "abc", 1, 2), /bad object abc/);
});

test("a tracked diff is cut by head -c in the shell, with the root, baseline and paths passed as arguments and never inside the script", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["-U3", `${"x".repeat(5000)}`]] });
  const git = createGit(w.io);
  const rows = await git.diffLines("/r", "abc", { path: "it's $(rm -rf).cs", fresh: false, added: 1, deleted: 1 });
  assert.ok(rows.length >= 1);
  const call = w.calls.find((c) => c.cmd === "sh");
  assert.ok(call.args[1].includes('head -c "$l"') && !call.args[1].includes("rm -rf") && !call.args[1].includes("/r"));
  assert.deepEqual(call.args.slice(3), [String(2_000_000), "/r", "abc", "3", "it's $(rm -rf).cs"]);
  assert.equal(w.calls.filter((c) => c.cmd === "git").length, 0);
  assert.equal((await git.diffText("/r", "abc", ["a.cs"], 0, 123)).length <= 123, true);
  assert.equal(w.calls.filter((c) => c.cmd === "sh").at(-1).args[3], "123");
});

test("a big file with a small edit is diffed, bounded by the byte cap, and shows the truncation notice only when the cap is hit", async () => {
  const hunk = (body) => `diff --git a/app.min.js b/app.min.js\n@@ -1 +1 @@\n+${body}\n`;
  const file = { path: "app.min.js", fresh: false, added: 1, deleted: 1, binary: false };
  const small = world({ repos: ["/r"], dirs: ["/r"], git: [["-U3", hunk("ok")]] });
  const rows = await createGit(small.io).diffLines("/r", "abc", file, "3500000");
  assert.ok(!rows[0].startsWith("Diff too large") && rows.at(-1) === "+ok" && !rows.some((r) => r.startsWith("Diff truncated")), rows.join("|"));
  const big = world({ repos: ["/r"], dirs: ["/r"], git: [["-U3", hunk("x".repeat(3_000_000))]] });
  const cut = await createGit(big.io).diffLines("/r", "abc", file, "3500000");
  assert.ok(cut.at(-1).startsWith("Diff truncated after 2.0 MB"), cut.at(-1));
  assert.equal(big.calls.filter((c) => c.cmd === "sh").length, 1);
});

test("diffText throws when git failed with nothing on stdout, so a summary is never built without its diff", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["-U2", new Error("fatal: bad revision")]] });
  await assert.rejects(createGit(w.io).diffText("/r", "abc", ["a.cs"]), /bad revision/);
  assert.equal(await createGit(world({ repos: ["/r"], dirs: ["/r"] }).io).diffText("/r", "abc", ["a.cs"]), "");
});

test("a failed git diff for one file is an error, not an empty diff", async () => {
  const w = world({ repos: ["/r"], dirs: ["/r"], git: [["-U3", new Error("fatal: bad revision")]] });
  await assert.rejects(createGit(w.io).diffLines("/r", "abc", { path: "a.cs", fresh: false, added: 1, deleted: 0 }), /bad revision/);
});
