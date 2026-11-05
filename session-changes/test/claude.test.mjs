import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeForeground, newestFirst, parseSessionFile, sessionLabel } from "../mods/session-changes/claude.js";

test("a foreground whose program is claude counts, whatever its path", () => {
  assert.equal(isClaudeForeground({ argv: ["/Users/x/.local/bin/claude", "--resume"] }), true);
  assert.equal(isClaudeForeground({ argv: ["claude-code"] }), true);
  assert.equal(isClaudeForeground({ argv: ["zsh"] }), false);
  assert.equal(isClaudeForeground(null), false);
});

test("parseSessionFile needs a session id and tolerates garbage", () => {
  assert.deepEqual(parseSessionFile('{"sessionId":"abc","cwd":"/w","name":"shop-1","pid":7}'), { sessionId: "abc", cwd: "/w", name: "shop-1" });
  assert.equal(parseSessionFile('{"cwd":"/w"}'), null);
  assert.equal(parseSessionFile("nope"), null);
  assert.equal(parseSessionFile(null), null);
});

test("newestFirst orders by seq, highest first, without mutating", () => {
  const list = [{ seq: 1 }, { seq: 9 }, { seq: 4 }];
  assert.deepEqual(newestFirst(list).map((a) => a.seq), [9, 4, 1]);
  assert.equal(list[0].seq, 1);
});

test("sessionLabel prefers the name and falls back to the start of the id", () => {
  assert.equal(sessionLabel({ name: "shop-8a", sessionId: "86389355-72ff" }), "shop-8a");
  assert.equal(sessionLabel({ name: null, sessionId: "86389355-72ff" }), "86389355");
  assert.equal(sessionLabel(null), "no session");
});
