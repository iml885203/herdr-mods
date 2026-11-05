"""Tests for mods/agent-history/index.py. Run from agent-history/:

    python3 -I -m unittest discover -s test
"""
import importlib.util
import sys
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest

sys.dont_write_bytecode = True  # keep __pycache__ out of the mod folder
HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("index", os.path.join(HERE, "..", "mods", "agent-history", "index.py"))
index = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(index)


def jl(*objs):
    """Compact JSON lines, the way the agents write them."""
    return "".join(json.dumps(o, ensure_ascii=False, separators=(",", ":")) + "\n" for o in objs)


def claude_lines(sid="s1"):
    return [
        {"type": "user", "sessionId": sid, "cwd": "/w/proj", "message": {"role": "user", "content": "please fix the flaky retry logic"}},
        {"type": "assistant", "sessionId": sid, "message": {"role": "assistant", "content": [
            {"type": "text", "text": "Looking at 部署 scripts now"},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "grep -rn zebra src"}}]}},
        {"type": "user", "sessionId": sid, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "src/a.py:3: quokka"}]}},
        {"type": "user", "sessionId": sid, "isMeta": True, "message": {"role": "user", "content": "metaonly"}},
        {"type": "user", "sessionId": sid, "message": {"role": "user", "content": "<system-reminder>hidden</system-reminder>"}},
        {"type": "ai-title", "sessionId": sid, "aiTitle": "Generated title"},
    ]


CODEX = [
    {"type": "session_meta", "payload": {"id": "cx1", "cwd": "/w/codex"}},
    {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "codex asks about walrus"}]}},
    {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>x</environment_context>"}]}},
    {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "codex answers about otters"}]}},
    {"type": "response_item", "payload": {"type": "function_call", "arguments": "{\"cmd\":\"ls narwhal\"}"}},
    {"type": "response_item", "payload": {"type": "function_call_output", "output": "marmot.txt"}},
    {"type": "event_msg", "payload": {"type": "token_count"}},
]

PI = [
    {"type": "session", "id": "pi1", "cwd": "/w/pi"},
    {"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "pi asks about lemur"}]}},
    {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "pi answers about gecko"}]}},
    {"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "ibex output"}]}},
    {"type": "thinking_level_change", "level": "high"},
]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.saved = (index.HOME, index.DB_DIR, index.DB_PATH)
        index.HOME = self.tmp
        index.DB_DIR = os.path.join(self.tmp, "cache")
        index.DB_PATH = os.path.join(index.DB_DIR, "index.db")
        os.makedirs(index.DB_DIR)
        self.addCleanup(lambda: setattr_all(index, ("HOME", "DB_DIR", "DB_PATH"), self.saved))

    def write(self, agent, name, lines, mode="w"):
        root = {"claude": (".claude", "projects", "p"), "codex": (".codex", "sessions", "2026"),
                "pi": (".pi", "agent", "sessions", "d")}[agent]
        d = os.path.join(self.tmp, *root)
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name + ".jsonl")
        with open(path, mode) as f:
            f.write(lines if isinstance(lines, str) else jl(*lines))
        return path

    def hits(self, q, limit=60):
        return index.search(q, limit)["results"]


def setattr_all(mod, names, values):
    for n, v in zip(names, values):
        setattr(mod, n, v)


class Fixtures(Base):
    """One fixture per agent: parsers and the byte prefilter agree on the real (compact) format."""

    def test_prefilter_keeps_every_indexed_line(self):
        for agent, objs in (("claude", claude_lines()), ("codex", CODEX), ("pi", PI)):
            parse, wanted = index.PARSERS[agent], index.WANTED[agent]
            meta = index.Meta()
            kept = 0
            for o in objs:
                line = jl(o).encode()
                r = parse(o, index.Meta())
                if r or o.get("type") in ("ai-title", "custom-title", "session", "session_meta"):
                    self.assertTrue(any(w in line for w in wanted), f"{agent}: prefilter drops {o['type']}")
                    kept += 1
            self.assertGreater(kept, 2, agent)

    def test_claude(self):
        self.write("claude", "s1", claude_lines())
        index.update(5)
        self.assertEqual([r["agent"] for r in self.hits("zebra")], ["claude"])  # tool_use input
        self.assertEqual(len(self.hits("quokka")), 1)  # tool_result
        self.assertEqual(len(self.hits("部署")), 1)  # CJK via trigram
        self.assertEqual(self.hits("metaonly"), [])
        self.assertEqual(self.hits("hidden"), [])
        r = self.hits("Generated")[0]  # title lives in the meta row
        self.assertEqual((r["id"], r["cwd"], r["title"]), ("s1", "/w/proj", "Generated title"))
        self.assertTrue(r["preview"].startswith("please fix"))
        self.assertEqual(index.argv_for(r["agent"], r["id"], r["path"]), ["claude", "--resume", "s1"])

    def test_claude_title_precedence(self):
        lines = claude_lines() + [{"type": "custom-title", "customTitle": "my rename", "sessionId": "s1"},
                                  {"type": "ai-title", "aiTitle": "Later generated", "sessionId": "s1"}]
        path = self.write("claude", "s1", lines)
        index.update(5)
        self.assertEqual(self.hits("retry")[0]["title"], "my rename")  # custom beats ai even when ai is later
        self.assertEqual(len(self.hits("my rename")), 1)  # custom title is searchable
        self.write("claude", "s1", [{"type": "custom-title", "customTitle": "second rename", "sessionId": "s1"}], mode="a")
        os.utime(path, (time.time() + 5, time.time() + 5))
        index.update(5)
        self.assertEqual(self.hits("retry")[0]["title"], "second rename")  # latest custom wins
        self.assertEqual(self.hits("my rename"), [])  # the old label is gone from the index

    def test_codex(self):
        self.write("codex", "rollout-x", CODEX)
        index.update(5)
        for word in ("walrus", "otters", "narwhal", "marmot"):
            self.assertEqual(len(self.hits(word)), 1, word)
        self.assertEqual(self.hits("environment_context"), [])
        r = self.hits("walrus")[0]
        self.assertEqual((r["id"], r["cwd"]), ("cx1", "/w/codex"))
        self.assertEqual(index.argv_for(r["agent"], r["id"], r["path"]), ["codex", "resume", "cx1"])

    def test_pi(self):
        path = self.write("pi", "pi-x", PI)
        index.update(5)
        for word in ("lemur", "gecko", "ibex"):
            self.assertEqual(len(self.hits(word)), 1, word)
        r = self.hits("lemur")[0]
        self.assertEqual((r["id"], r["cwd"]), ("pi1", "/w/pi"))
        self.assertEqual(index.argv_for(r["agent"], r["id"], r["path"]), ["pi", "--session", path])

    def test_subagents_skipped(self):
        d = os.path.join(self.tmp, ".claude", "projects", "p", "subagents")
        os.makedirs(d)
        with open(os.path.join(d, "x.jsonl"), "w") as f:
            f.write(jl(*claude_lines("sub")))
        self.assertEqual(index.update(5)["indexed"], 0)


class Incremental(Base):
    def test_append_half_line_and_shrink(self):
        path = self.write("claude", "s1", claude_lines())
        index.update(5)
        db = index.connect()
        meta_id = db.execute("SELECT meta_id FROM files").fetchone()[0]
        # A complete new line plus a half-written one.
        extra = jl({"type": "assistant", "sessionId": "s1", "message": {"content": [{"type": "text", "text": "appended okapi"}]}})
        with open(path, "a") as f:
            f.write(extra + '{"type":"assistant","message":{"content":[{"type":"text","text":"half')
        os.utime(path, (time.time() + 5, time.time() + 5))
        index.update(5)
        self.assertEqual(len(self.hits("okapi")), 1)
        self.assertEqual(self.hits("half"), [])
        self.assertEqual(db.execute("SELECT meta_id FROM files").fetchone()[0], meta_id, "unchanged label must keep its meta row")
        with open(path, "a") as f:  # finish the line
            f.write(' done"}]}}\n')
        os.utime(path, (time.time() + 10, time.time() + 10))
        index.update(5)
        self.assertEqual(len(self.hits("half done")), 1)
        self.assertEqual(len(self.hits("okapi")), 1, "no duplicate rows from re-reading")
        # Shrunk: re-read from the start.
        self.write("claude", "s1", claude_lines()[:1])
        os.utime(path, (time.time() + 20, time.time() + 20))
        index.update(5)
        self.assertEqual(self.hits("okapi"), [])
        self.assertEqual(len(self.hits("flaky")), 1)

    def test_meta_row_rewritten_when_title_changes(self):
        path = self.write("claude", "s1", claude_lines())
        index.update(5)
        db = index.connect()
        before = db.execute("SELECT meta_label FROM files").fetchone()[0]
        self.write("claude", "s1", [{"type": "ai-title", "aiTitle": "Brand new title", "sessionId": "s1"}], mode="a")
        os.utime(path, (time.time() + 5, time.time() + 5))
        index.update(5)
        after = db.execute("SELECT meta_label FROM files").fetchone()[0]
        self.assertNotEqual(before, after)
        self.assertIn("Brand new title", after)
        self.assertEqual(len(self.hits("Brand new title")), 1)
        self.assertEqual(self.hits("Generated title"), [])
        n = db.execute("SELECT count(*) FROM fts WHERE meta<>''").fetchone()[0]
        self.assertEqual(n, 1)

    def test_deadline_resumes_without_duplicates(self):
        lines = [{"type": "user", "sessionId": "big", "cwd": "/w", "message": {"content": f"line {i} uniqueword{i}"}} for i in range(1000)]
        path = self.write("claude", "big", lines)
        db = index.connect()
        st = os.stat(path)
        self.assertFalse(index.index_file(db, "claude", path, st, None, deadline=time.time() - 1))
        db.commit()
        row = db.execute("SELECT id,mtime,size,offset FROM files").fetchone()
        part = db.execute("SELECT count(*) FROM msgs").fetchone()[0]
        self.assertTrue(0 < part < 1000, part)
        self.assertEqual(row[1], st.st_mtime, "mtime is always the real one")
        self.assertEqual(row[2], row[3], "a partial file stores size=offset")
        self.assertLess(row[2], st.st_size, "so it stays 'changed'")
        self.assertTrue(index.index_file(db, "claude", path, st, row[:1] + row[1:], deadline=None))
        db.commit()
        self.assertEqual(db.execute("SELECT count(*) FROM fts WHERE user_text<>''").fetchone()[0], 1000)
        self.assertEqual(len(self.hits("uniqueword999")), 1)

    def test_partial_file_is_resumed_by_update_and_sorts_by_real_mtime(self):
        lines = [{"type": "user", "sessionId": "big", "cwd": "/w", "message": {"content": f"line {i} uniqueword{i}"}} for i in range(1000)]
        path = self.write("claude", "big", lines)
        os.utime(path, (5000, 5000))
        db = index.connect()
        self.assertFalse(index.index_file(db, "claude", path, os.stat(path), None, deadline=time.time() - 1))
        db.commit()
        self.assertEqual(index.recent(db, 10)[0]["mtime"], 5000000)
        r = index.update(10)
        self.assertEqual(r["pending"], 0)
        self.assertEqual(db.execute("SELECT count(*) FROM fts WHERE user_text<>''").fetchone()[0], 1000)
        self.assertNotIn("recent", index.update(10))

    def test_update_returns_recent_only_when_changed(self):
        self.write("claude", "s1", claude_lines())
        r = index.update(5)
        self.assertEqual([x["id"] for x in r["recent"]], ["s1"])
        self.assertNotIn("argv", r["recent"][0])
        self.assertNotIn("recent", index.update(5))
        os.remove(os.path.join(self.tmp, ".claude", "projects", "p", "s1.jsonl"))
        r = index.update(5)  # a vanished transcript is a change too
        self.assertEqual(r["recent"], [])

    def test_merge_runs_without_error_when_caught_up(self):
        for i in range(3):
            self.write("claude", f"s{i}", claude_lines(f"s{i}"))
        r = index.update(5)
        self.assertEqual((r["indexed"], r["pending"]), (3, 0))


class Search(Base):
    def test_snippet_structure_and_unicode_offsets(self):
        text = "İİİİİİ " * 20 + "the Retry happens here " + "ß" * 30
        s = index.snippet([text], ["retry"])
        self.assertEqual(s["hit"], "Retry")  # lower() would shift offsets: İ lowers to 2 chars
        self.assertIn("happens", s["post"])
        self.assertLessEqual(len(s["pre"]), 48)
        s = index.snippet(["先部署再說"], ["部署"])
        self.assertEqual((s["pre"], s["hit"], s["post"]), ("先", "部署", "再說"))
        s = index.snippet(["nothing relevant"], ["zzz"])
        self.assertEqual((s["hit"], s["post"]), ("", ""))
        self.assertEqual(s["pre"], "nothing relevant")

    def test_cap_and_one_row_per_session(self):
        for i in range(5):
            lines = [{"type": "user", "sessionId": f"s{i}", "cwd": "/w", "message": {"content": f"common word {j}"}} for j in range(50)]
            p = self.write("claude", f"s{i}", lines)
            os.utime(p, (1000 + i, 1000 + i))
        index.update(10)
        r = index.search("common", 3)
        self.assertTrue(r["capped"])
        self.assertEqual([x["id"] for x in r["results"]], ["s4", "s3", "s2"])  # newest first, one each
        r = index.search("common", 10)
        self.assertFalse(r["capped"])
        self.assertEqual(len(r["results"]), 5)

    def test_short_and_mixed_terms_and_empty(self):
        self.write("claude", "s1", claude_lines())
        index.update(5)
        self.assertEqual(len(self.hits("qu")), 1)  # LIKE path
        self.assertEqual(len(self.hits("qu quokka")), 1)
        self.assertEqual(self.hits("qu zebra"), [])  # not in the same message row
        self.assertEqual(len(self.hits("")), 1)  # recent list
        self.assertEqual(self.hits('"; DROP'), [])

    def test_best_row_snippet_comes_from_matching_row(self):
        self.write("claude", "s1", claude_lines())
        index.update(5)
        s = self.hits("quokka")[0]["snippet"]
        self.assertEqual(s["hit"], "quokka")


class Scope(Base):
    def setUp(self):
        super().setUp()
        for name, cwd in (("a", "/w/proj"), ("b", "/w/proj/sub"), ("c", "/w/project"), ("d", "/w/50%_x"), ("e", "/w/50ab_x/y"), ("f", "/other")):
            lines = [{"type": "user", "sessionId": name, "cwd": cwd, "message": {"content": "shared needle"}}]
            p = self.write("claude", name, lines)
            os.utime(p, (1000 + ord(name), 1000 + ord(name)))
        index.update(10)

    def ids(self, rows):
        return sorted(x["id"] for x in rows)

    def test_recent_and_search_filter_by_folder_prefix(self):
        db = index.connect()
        self.assertEqual(self.ids(index.recent(db, 50, ["/w/proj"])), ["a", "b"])  # not /w/project
        self.assertEqual(self.ids(index.recent(db, 50, ["/w/proj/"])), ["a", "b"])
        self.assertEqual(self.ids(index.recent(db, 50, ["/w/proj", "/other"])), ["a", "b", "f"])
        self.assertEqual(self.ids(index.search("needle", 50, ["/w/proj"])["results"]), ["a", "b"])
        self.assertEqual(self.ids(index.search("", 50, ["/other"])["results"]), ["f"])

    def test_wildcards_are_escaped(self):
        self.assertEqual(self.ids(index.search("needle", 50, ["/w/50%_x"])["results"]), ["d"])

    def test_filter_applies_before_the_limit_and_capped_is_per_scope(self):
        r = index.search("needle", 1, ["/w/proj"])
        self.assertTrue(r["capped"])
        self.assertEqual([x["id"] for x in r["results"]], ["b"])
        r = index.search("needle", 1, ["/other"])
        self.assertFalse(r["capped"])
        self.assertEqual([x["id"] for x in r["results"]], ["f"])

    def test_update_recent_is_scoped(self):
        os.utime(self.write("claude", "g", [{"type": "user", "sessionId": "g", "cwd": "/other", "message": {"content": "x"}}]), (9000, 9000))
        r = index.update(10, 300, ["/other"])
        self.assertEqual(self.ids(r["recent"]), ["f", "g"])


class Migration(Base):
    def test_old_db_kept_and_extended(self):
        db = sqlite3.connect(index.DB_PATH)
        db.executescript(index.SCHEMA)
        db.execute("ALTER TABLE files ADD COLUMN custom_title TEXT")  # the previous schema
        db.execute("INSERT INTO files(id,path,agent,sid,cwd,title,preview,mtime,size,offset) VALUES(1,'/x.jsonl','claude','s','/w','t','p',1,10,10)")
        db.execute("INSERT INTO msgs(id,file_id) VALUES(1,1)")
        db.execute("INSERT INTO fts(rowid,user_text,assistant_text,tool_text,meta) VALUES(1,'','','','t /w s')")
        db.commit()
        db.close()
        db = index.connect()
        self.assertEqual(db.execute("SELECT count(*) FROM files").fetchone()[0], 1)
        self.assertEqual(db.execute("SELECT count(*) FROM fts").fetchone()[0], 1)
        cols = {r[1] for r in db.execute("PRAGMA table_info(files)")}
        self.assertTrue({"meta_id", "meta_label"} <= cols)
        # A changed legacy file replaces its old meta row instead of leaving a stale one.
        path = self.write("claude", "s", claude_lines("s"))
        db.execute("UPDATE files SET path=?,mtime=0,size=1,offset=0 WHERE id=1", (path,))
        db.commit()
        index.update(5)
        self.assertEqual(db.execute("SELECT count(*) FROM fts WHERE meta<>''").fetchone()[0], 1)

    def test_pre_custom_title_db_is_rebuilt_once(self):
        db = sqlite3.connect(index.DB_PATH)
        db.executescript(index.SCHEMA)
        db.execute("INSERT INTO files(id,path,agent,mtime,size,offset) VALUES(1,'/x','claude',1,1,1)")
        db.commit()
        db.close()
        db = index.connect()
        self.assertEqual(db.execute("SELECT count(*) FROM files").fetchone()[0], 0)
        db.execute("INSERT INTO files(path,agent,mtime,size,offset) VALUES('/y','claude',1,1,1)")
        db.commit()
        db.close()
        self.assertEqual(index.connect().execute("SELECT count(*) FROM files").fetchone()[0], 1)  # not wiped again


if __name__ == "__main__":
    unittest.main()
