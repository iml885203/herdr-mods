import { test } from "node:test";
import assert from "node:assert/strict";
import { baseName, compare, dirOf, resolvePath } from "../mods/session-changes/paths.js";

test("dirOf and baseName split on the last slash and never return an empty dir", () => {
  assert.equal(dirOf("/a/b/c.cs"), "/a/b");
  assert.equal(dirOf("/a"), "/");
  assert.equal(baseName("/a/b/c.cs"), "c.cs");
  assert.equal(baseName("plain"), "plain");
});

test("compare orders by code point, not locale", () => {
  assert.deepEqual([".env", "a.cs", "B.cs"].sort(compare), [".env", "B.cs", "a.cs"]);
});

test("resolvePath joins against the base and folds dots", () => {
  assert.equal(resolvePath("/w/proj", "../x/./y"), "/w/x/y");
  assert.equal(resolvePath("/w/proj", "/abs/z/"), "/abs/z");
});

test("resolvePath expands ~ and $HOME only when the home is known", () => {
  assert.equal(resolvePath("/w", "~/x", "/Users/me"), "/Users/me/x");
  assert.equal(resolvePath("/w", "$HOME/x", "/Users/me"), "/Users/me/x");
  assert.equal(resolvePath("/w", "${HOME}", "/Users/me"), "/Users/me");
  assert.equal(resolvePath("/w", "~", "/Users/me"), "/Users/me");
  assert.equal(resolvePath("/w", "~/x"), null);
  assert.equal(resolvePath("/w", ""), null);
});
