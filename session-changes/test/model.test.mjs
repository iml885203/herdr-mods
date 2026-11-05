import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFiles, buildRepo, buildSession, diffStamp, emptyMessage, isOwned, ownedFiles, orderRepos, pushState, repoLabels, sessionTotals } from "../mods/session-changes/model.js";

const status = (entries) => new Map(Object.entries(entries));
const stat = (a, d, binary = false) => ({ added: a, deleted: d, binary });

test("buildFiles joins name-status, numstat and status, and adds untracked files as new", () => {
  const files = buildFiles({
    nameStatus: new Map([["a.cs", "M"], ["gone.cs", "D"], ["committed.cs", "A"]]),
    numstat: new Map([["a.cs", stat(3, 1)], ["gone.cs", stat(0, 9)], ["committed.cs", stat(5, 0)]]),
    status: status({ "a.cs": " M", "gone.cs": " D", "fresh.txt": "??" }),
  });
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual([by["a.cs"].status, by["a.cs"].dirty, by["a.cs"].added, by["a.cs"].deleted], ["M", true, 3, 1]);
  assert.deepEqual([by["gone.cs"].status, by["gone.cs"].deleted], ["D", 9]);
  assert.deepEqual([by["committed.cs"].status, by["committed.cs"].dirty], ["A", false]);
  assert.deepEqual([by["fresh.txt"].status, by["fresh.txt"].fresh, by["fresh.txt"].dirty, by["fresh.txt"].added], ["A", true, true, null]);
});

test("a conflicted status wins over the diff letter", () => {
  const [file] = buildFiles({ nameStatus: new Map([["a", "M"]]), numstat: new Map(), status: status({ a: "UU" }) });
  assert.equal(file.status, "U");
});

const repoInput = (over = {}) => ({
  root: "/d/payments", branch: "main", ahead: 0, commits: [], edited: new Set(), files: [], ...over,
});
const file = (path, over = {}) => ({ path, status: "M", fresh: false, dirty: false, added: 1, deleted: 0, binary: false, ...over });

test("a file edited in the session, or changed by a session commit, is ours; the rest is other source", () => {
  const repo = buildRepo(repoInput({
    edited: new Set(["a.cs"]),
    commits: [{ subject: "x", files: ["b.cs"] }],
    files: [file("a.cs"), file("b.cs"), file("c.cs")],
  }));
  assert.deepEqual(repo.files.map((f) => [f.path, f.owner]), [["a.cs", "session"], ["b.cs", "session"], ["c.cs", "other"]]);
  assert.equal(repo.owned, 2);
});

test("totals count only our files", () => {
  const repo = buildRepo(repoInput({ edited: new Set(["a"]), files: [file("a", { added: 4, deleted: 2 }), file("z", { added: 100 })] }));
  assert.deepEqual([repo.added, repo.deleted], [4, 2]);
});

test("noise is counted but not listed; secrets are listed and flagged", () => {
  const repo = buildRepo(repoInput({
    edited: new Set(["package-lock.json", ".env", "a.cs"]),
    files: [file("package-lock.json"), file(".env"), file("a.cs")],
  }));
  assert.deepEqual(repo.files.map((f) => f.path), [".env", "a.cs"]);
  assert.equal(repo.noise, 1);
  assert.equal(repo.files[0].secret, true);
});

test("push state: uncommitted, no upstream, unpushed, pushed", () => {
  const owned = (dirty) => [{ owner: "session", dirty }];
  assert.equal(pushState({ files: owned(true), ahead: 0 }), "dirty");
  assert.equal(pushState({ files: owned(true), ahead: null }), "dirty");
  assert.equal(pushState({ files: owned(false), ahead: null }), "no-upstream");
  assert.equal(pushState({ files: owned(false), ahead: 2 }), "unpushed");
  assert.equal(pushState({ files: owned(false), ahead: 0 }), "pushed");
  assert.equal(pushState({ files: [{ owner: "other", dirty: true }], ahead: 0 }), "pushed");
});

test("a repo with no upstream is never pushed, even when the session's commits fall outside the commit window and none were counted", () => {
  const repo = buildRepo(repoInput({ ahead: null, commits: [], files: [{ ...file("a.cs"), dirty: false }], edited: new Set(["a.cs"]) }));
  assert.equal(repo.owned, 1);
  assert.equal(repo.state, "no-upstream");
  const counted = buildRepo(repoInput({ ahead: null, commits: [{ subject: "x", files: ["a.cs"] }], files: [{ ...file("a.cs"), dirty: false }] }));
  assert.equal(counted.state, "no-upstream");
});

test("subjects come from the session's commits only", () => {
  const repo = buildRepo(repoInput({ branch: "feature/SHOP-7-x", commits: [{ subject: "fix SHOP-9", files: ["a"] }], files: [file("a")] }));
  assert.deepEqual(repo.subjects, ["fix SHOP-9"]);
});

test("repos with nothing of ours are dropped by orderRepos' caller via owned count", () => {
  const empty = buildRepo(repoInput({ files: [file("c.cs")] }));
  assert.equal(empty.owned, 0);
});

test("repoLabels shortens to the folder name and widens only on a clash", () => {
  const labels = repoLabels(["/d/a/payments", "/d/b/payments", "/d/storefront"]);
  assert.equal(labels.get("/d/a/payments"), "a/payments");
  assert.equal(labels.get("/d/b/payments"), "b/payments");
  assert.equal(labels.get("/d/storefront"), "storefront");
});

test("orderRepos sorts by layer, then name", () => {
  const mk = (name, layer) => ({ root: name, label: name, layer });
  const sorted = orderRepos([mk("storefront", "ui"), mk("e2e-tests", "tests"), mk("shop-db", "db"), mk("a-ui", "ui")]);
  assert.deepEqual(sorted.map((r) => r.label), ["shop-db", "a-ui", "storefront", "e2e-tests"]);
});

test("sessionTotals adds up repos, files, lines and unpushed commits", () => {
  const totals = sessionTotals([
    { owned: 2, added: 5, deleted: 1, ahead: 3 },
    { owned: 1, added: 2, deleted: 0, ahead: null },
  ]);
  assert.deepEqual(totals, { repos: 2, files: 3, added: 7, deleted: 1, unpushed: 3 });
});

test("diffStamp follows the open file's own status, counts and stat, not the repo's version", () => {
  const open = { root: "/d/payments", path: "a.cs" };
  const file = { status: "M", added: 1, deleted: 0, dirty: true };
  const state = (mtime, size) => ({ version: 1, stats: new Map([["a.cs", { mtime, size }], ["other.cs", { mtime: "9", size: "9" }]]) });
  const stamp = (f, s) => diffStamp(open, s, f);
  assert.equal(stamp(file, state("1", "10")), stamp(file, { ...state("1", "10"), version: 7 }));
  assert.equal(stamp(file, state("1", "10")), stamp(file, { ...state("1", "10"), stats: new Map([["a.cs", { mtime: "1", size: "10" }]]) }));
  assert.notEqual(stamp(file, state("1", "10")), stamp(file, state("2", "10")));
  assert.notEqual(stamp(file, state("1", "10")), stamp(file, state("1", "11")));
  assert.notEqual(stamp(file, state("1", "10")), stamp({ ...file, added: 2 }, state("1", "10")));
  assert.notEqual(stamp(file, state("1", "10")), stamp({ ...file, status: "D" }, state("1", "10")));
  assert.notEqual(stamp(file, state("1", "10")), diffStamp({ ...open, path: "b.cs" }, state("1", "10"), file));
  assert.equal(diffStamp(null, state("1", "10"), file), "");
  assert.equal(diffStamp(open, undefined, file), "");
  assert.equal(diffStamp(open, state("1", "10"), null), "");
});

test("buildSession orders the repos that have something of ours, labels them, relates them and totals them", () => {
  const state = (root, name, owned, extra = {}) => ({ root, repo: buildRepo({ root, branch: "main", ahead: 0, commits: [], edited: new Set(owned), files: owned.map((p) => file(p)) }), submodules: [], ...extra });
  const session = buildSession([state("/d/web", "web", ["src/a.vue"]), state("/d/empty", "empty", []), state("/d/api", "api", ["Services/A.cs"])]);
  assert.equal(session.views.length, 2);
  assert.deepEqual(session.views.map((v) => v.label).sort(), ["api", "web"]);
  assert.deepEqual(Object.keys(session.relations).sort(), ["/d/api", "/d/web"]);
  assert.equal(session.totals.repos, 2);
  assert.deepEqual(buildSession([]), { views: [], relations: {}, totals: sessionTotals([]) });
});

test("buildRepo orders files by code point", () => {
  const repo = buildRepo({ root: "/d/x", branch: "main", ahead: 0, commits: [], edited: new Set([".env", "B.cs", "a.cs"]), files: ["a.cs", "B.cs", ".env"].map((p) => file(p)) });
  assert.deepEqual(repo.files.map((f) => f.path), [".env", "B.cs", "a.cs"]);
});

const idle = { starting: false, session: { sessionId: "s" }, error: null, loaded: true, pending: false };

test("emptyMessage says what is going on while there is nothing to list", () => {
  assert.equal(emptyMessage({ ...idle, starting: true }), "Looking for a Claude session…");
  assert.ok(emptyMessage({ ...idle, session: null }).startsWith("No Claude session"));
  assert.equal(emptyMessage({ ...idle, error: "Transcript not found" }), "Transcript not found");
  assert.equal(emptyMessage({ ...idle, loaded: false }), "Reading the session…");
  assert.equal(emptyMessage(idle), "No changes this session");
});

test("emptyMessage does not claim there are no changes while the transcript is still being read", () => {
  assert.equal(emptyMessage({ ...idle, pending: true }), "Reading the session…");
});

test("an edited or committed file under bin, obj or dist is listed, while other people's and generated files stay noise", () => {
  const repo = buildRepo(repoInput({
    edited: new Set(["bin/deploy.sh", "package-lock.json"]),
    commits: [{ subject: "x", files: ["dist/app.js"] }],
    files: [file("bin/deploy.sh"), file("dist/app.js"), file("obj/other.dll"), file("package-lock.json"), file("src/a.cs")],
  }));
  assert.deepEqual(repo.files.map((f) => [f.path, f.owner]), [["bin/deploy.sh", "session"], ["dist/app.js", "session"], ["src/a.cs", "other"]]);
  assert.equal(repo.noise, 2);
});

test("isOwned and ownedFiles pick the session's files", () => {
  const files = [{ owner: "session", path: "a" }, { owner: "other", path: "b" }];
  assert.equal(isOwned(files[0]), true);
  assert.equal(isOwned(files[1]), false);
  assert.deepEqual(ownedFiles(files), [files[0]]);
});

test("when there are too many files the session's own come first, and noise is still counted from all of them", () => {
  const others = Array.from({ length: 50 }, (_, i) => file(`node_modules/pkg/f${String(i).padStart(2, "0")}.js`, { fresh: true }));
  const repo = buildRepo({ ...repoInput({ edited: new Set(["src/a.cs", "src/b.cs", "src/c.cs"]), files: [...others, file("src/c.cs"), file("src/a.cs"), file("src/b.cs"), file("package-lock.json"), file("yarn.lock")] }), limit: 10 });
  assert.equal(repo.files.length, 10);
  assert.deepEqual(repo.files.filter(isOwned).map((f) => f.path), ["src/a.cs", "src/b.cs", "src/c.cs"]);
  assert.equal(repo.owned, 3);
  assert.equal(repo.noise, 2);
  assert.equal(repo.truncated, 43);
  assert.deepEqual(repo.files.map((f) => f.path), [...repo.files.map((f) => f.path)].sort());
});

test("a repo within the cap is not truncated", () => {
  const repo = buildRepo({ ...repoInput({ edited: new Set(["a"]), files: [file("a"), file("b")] }), limit: 10 });
  assert.equal(repo.truncated, 0);
});
