import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit } from "../mods/session-changes/git.js";
import { parseRootRecords, placeOf } from "../mods/session-changes/roots.js";
import { realIo } from "./fakeio.mjs";

const base = await mkdtemp(join(tmpdir(), "roots-"));
after(() => rm(base, { recursive: true, force: true }));
const real = await realpath(base);
const repo = join(base, "repo");
await mkdir(join(repo, ".git"), { recursive: true });
await mkdir(join(repo, "src/deep"), { recursive: true });
await mkdir(join(repo, "ext/inner/lib"), { recursive: true });
await writeFile(join(repo, "ext/inner/.git"), "gitdir: ../../.git/modules/inner\n");
await writeFile(join(repo, "a.cs"), "x");
await mkdir(join(base, "plain/sub"), { recursive: true });
await symlink(repo, join(base, "link"));
const git = createGit(realIo());
const lookup = async (...dirs) => git.rootsOf(dirs);

test("a folder inside a repo resolves to the toplevel with its prefix", async () => {
  const roots = await lookup(repo, join(repo, "src"), join(repo, "src/deep"));
  assert.deepEqual(roots.get(repo), { root: join(real, "repo"), prefix: "" });
  assert.deepEqual(roots.get(join(repo, "src/deep")), { root: join(real, "repo"), prefix: "src/deep/" });
});

test("a folder that does not exist yet climbs to the repo and keeps the missing part in the prefix", async () => {
  const roots = await lookup(join(repo, "new/deeper"));
  assert.deepEqual(roots.get(join(repo, "new/deeper")), { root: join(real, "repo"), prefix: "new/deeper/" });
});

test("a nested repo, whose .git is a file, is its own root", async () => {
  const roots = await lookup(join(repo, "ext/inner/lib"));
  assert.deepEqual(roots.get(join(repo, "ext/inner/lib")), { root: join(real, "repo/ext/inner"), prefix: "lib/" });
});

test("a symlinked path gives the real toplevel, with the prefix of the path as written", async () => {
  const roots = await lookup(join(base, "link/src"));
  assert.deepEqual(roots.get(join(base, "link/src")), { root: join(real, "repo"), prefix: "src/" });
});

test("a folder outside any repo, or a path with no repo above it, is null", async () => {
  const roots = await lookup(join(base, "plain/sub"), join(base, "nowhere/at/all"), "/nonexistent/x");
  assert.equal(roots.get(join(base, "plain/sub")), null);
  assert.equal(roots.get(join(base, "nowhere/at/all")), null);
  assert.equal(roots.get("/nonexistent/x"), null);
});

test("many folders are answered together, in batches, with every folder present in the result", async () => {
  const dirs = Array.from({ length: 700 }, (_, i) => join(repo, `gen/d${i}`));
  let execs = 0;
  const io = realIo();
  const counting = createGit({ ...io, exec: (...args) => { execs++; return io.exec(...args); } });
  const roots = await counting.rootsOf(dirs);
  assert.equal(roots.size, 700);
  assert.ok([...roots.values()].every((r) => r.root === join(real, "repo")));
  assert.ok(execs <= 6, `${execs} execs`);
});

test("a symlink that leads into a repo from outside it is found by walking the physical path", async () => {
  await mkdir(join(repo, "inner"), { recursive: true });
  await mkdir(join(base, "lnk"), { recursive: true });
  await symlink(join(repo, "inner"), join(base, "lnk/l"));
  const roots = await lookup(join(base, "lnk/l"), join(base, "lnk/l/not/there"));
  assert.deepEqual(roots.get(join(base, "lnk/l")), { root: join(real, "repo"), prefix: "inner/" });
  assert.deepEqual(roots.get(join(base, "lnk/l/not/there")), { root: join(real, "repo"), prefix: "inner/not/there/" });
});

test("folder names with a tab or a newline are answered exactly, and do not disturb their neighbours", async () => {
  const odd = join(repo, "we\tird\nname");
  await mkdir(odd, { recursive: true });
  const roots = await lookup(odd, join(repo, "src"), join(base, "plain"));
  assert.deepEqual(roots.get(odd), { root: join(real, "repo"), prefix: "we\tird\nname/" });
  assert.deepEqual(roots.get(join(repo, "src")), { root: join(real, "repo"), prefix: "src/" });
  assert.equal(roots.get(join(base, "plain")), null);
  assert.equal(roots.size, 3);
});

test("a lookup is one process per batch, with no second call for real paths", async () => {
  const io = realIo();
  let execs = 0;
  const counting = createGit({ ...io, exec: (...args) => { execs++; return io.exec(...args); } });
  await counting.rootsOf([join(repo, "src"), join(repo, "src/deep")]);
  assert.equal(execs, 1);
});

test("parseRootRecords reads NUL-delimited records of folder, existing ancestor, real ancestor and root", () => {
  const parsed = parseRootRecords("/a/b\0/a\0/real/a\0/real\0/c\0\0\0\0");
  assert.deepEqual([...parsed], [["/a/b", { existing: "/a", real: "/real/a", root: "/real" }], ["/c", null]]);
  assert.deepEqual([...parseRootRecords("")], []);
});

test("placeOf builds the prefix from the real ancestor below the root plus the part that does not exist yet", () => {
  assert.deepEqual(placeOf("/tmp/r/src/new/x", { existing: "/tmp/r/src", real: "/private/tmp/r/src", root: "/private/tmp/r" }), { root: "/private/tmp/r", prefix: "src/new/x/" });
  assert.deepEqual(placeOf("/tmp/r", { existing: "/tmp/r", real: "/private/tmp/r", root: "/private/tmp/r" }), { root: "/private/tmp/r", prefix: "" });
  assert.deepEqual(placeOf("/x/l/miss", { existing: "/x/l", real: "/r/inner", root: "/r" }), { root: "/r", prefix: "inner/miss/" });
});
