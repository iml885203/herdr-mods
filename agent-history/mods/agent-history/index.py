#!/usr/bin/env python3
"""Full-text index of agent transcripts (Claude Code, Codex, Pi) for the
agent-history mod. Same shape as Orca's session search: one FTS5 row per
message with user / assistant / tool columns, rebuilt incrementally from each
transcript's size and mtime. The trigram tokenizer makes CJK text searchable.

  index.py update [--budget SECONDS] [--limit N] [--cwd PATH]...
                                       index new/changed transcripts; when anything
                                       changed, also returns the N newest sessions
  index.py search QUERY [--limit N] [--cwd PATH]...
                                       newest matching sessions; snippet is
                                       {pre, hit, post}, "capped" when more exist
  --cwd (repeatable) keeps only sessions whose folder is PATH or under it
  index.py forget PATH                 drop one transcript from the index
"""
import collections
import fcntl
import json
import os
import re
import sqlite3
import sys
import time

HOME = os.path.expanduser("~")
CACHE = (os.path.join(HOME, "Library", "Caches") if sys.platform == "darwin"
         else os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"))
DB_DIR = os.path.join(CACHE, "herdr-agent-history")
DB_PATH = os.path.join(DB_DIR, "index.db")
TOOL_CAP = 800  # chars of tool input/output kept per message
TEXT_CAP = 20000
BATCH = 500  # messages per insert batch while streaming a transcript
MERGE_PAGES = 200  # fts5 'merge' work per quiet update
REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)

SCHEMA = """
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, agent TEXT NOT NULL,
  sid TEXT, cwd TEXT, title TEXT, preview TEXT,
  mtime REAL NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS msgs_file ON msgs(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  user_text, assistant_text, tool_text, meta, tokenize='trigram');
"""


def connect():
    os.makedirs(DB_DIR, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    cols = {r[1] for r in db.execute("PRAGMA table_info(files)")}
    if "custom_title" not in cols:
        # /rename titles came later: add the column and rebuild, older rows never read them.
        db.execute("ALTER TABLE files ADD COLUMN custom_title TEXT")
        db.execute("DELETE FROM fts"); db.execute("DELETE FROM msgs"); db.execute("DELETE FROM files")
        db.commit()
    # Additive, no rebuild: the meta row's id and label, so an unchanged label is not rewritten.
    # Rows from before these columns have NULLs and are fixed up the next time their file changes.
    for col, kind in (("meta_id", "INTEGER"), ("meta_label", "TEXT")):
        if col not in cols:
            db.execute(f"ALTER TABLE files ADD COLUMN {col} {kind}")
            db.commit()
    return db


def sources():
    """(agent, path) for every transcript we know how to read."""
    roots = [
        ("claude", os.path.join(HOME, ".claude", "projects")),
        ("codex", os.path.join(HOME, ".codex", "sessions")),
        ("pi", os.path.join(HOME, ".pi", "agent", "sessions")),
    ]
    for agent, root in roots:
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d != "subagents"]
            for f in files:
                if f.endswith(".jsonl"):
                    yield agent, os.path.join(dirpath, f)


def clip(s, n):
    s = str(s or "")
    return s if len(s) <= n else s[:n]


def one_line(s, n=160):
    return clip(re.sub(r"\s+", " ", str(s or "")), n).strip()


def squash(s):
    return re.sub(r"\s+", " ", s)


def texts_of(content, kinds):
    """Text pieces of a content list whose type is in kinds."""
    if isinstance(content, str):
        return [content]
    out = []
    for c in content or []:
        if isinstance(c, dict) and c.get("type") in kinds:
            v = c.get("text")
            if isinstance(v, str):
                out.append(v)
    return out


def tool_text_of(c):
    t = c.get("type")
    if t == "tool_use":
        return clip(json.dumps(c.get("input"), ensure_ascii=False), TOOL_CAP)
    if t == "tool_result":
        body = c.get("content")
        if isinstance(body, list):
            body = " ".join(texts_of(body, ("text",)))
        return clip(body, TOOL_CAP)
    return None


def is_injected(text):
    s = text.lstrip()
    return s.startswith(("<", "# AGENTS.md", "Caveat:")) or not s


# What a parser returns for a line worth indexing: role is "user", "assistant" or "tool".
Message = collections.namedtuple("Message", "role text tool")


class Meta:
    def __init__(self, row=None):
        self.sid, self.cwd, self.title, self.preview, self.custom = row or (None, None, None, None, None)


def parse_claude(o, meta):
    if o.get("sessionId") and not meta.sid:
        meta.sid = o["sessionId"]
    if o.get("cwd") and not meta.cwd:
        meta.cwd = o["cwd"]
    t = o.get("type")
    if t == "custom-title" and o.get("customTitle"):  # /rename; the latest one wins
        meta.custom = o["customTitle"]
        return None
    if t == "ai-title" and o.get("aiTitle"):
        meta.title = o["aiTitle"]
        return None
    if t not in ("user", "assistant") or o.get("isMeta"):
        return None
    m = o.get("message") or {}
    content = m.get("content")
    tool = []
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict):
                x = tool_text_of(c)
                if x:
                    tool.append(x)
    text = "\n".join(REMINDER.sub("", x) for x in texts_of(content, ("text",))).strip()
    if t == "user" and text and is_injected(text):
        text = ""
    if t == "user" and text and not meta.preview:
        meta.preview = one_line(text)
    return Message(t, text, "\n".join(tool))


def parse_codex(o, meta):
    p = o.get("payload") if isinstance(o.get("payload"), dict) else {}
    t = o.get("type")
    if t == "session_meta":
        meta.sid = meta.sid or p.get("id")
        meta.cwd = meta.cwd or p.get("cwd")
        return None
    if t != "response_item":
        return None
    pt = p.get("type")
    if pt == "message" and p.get("role") in ("user", "assistant"):
        text = "\n".join(texts_of(p.get("content"), ("input_text", "output_text", "text"))).strip()
        if p["role"] == "user":
            if is_injected(text):
                return None
            if not meta.preview:
                meta.preview = one_line(text)
        return Message(p["role"], text, "")
    if pt in ("function_call", "custom_tool_call"):
        return Message("tool", "", clip(p.get("arguments") or p.get("input"), TOOL_CAP))
    if pt in ("function_call_output", "custom_tool_call_output"):
        out = p.get("output")
        if not isinstance(out, str):
            out = json.dumps(out, ensure_ascii=False)
        return Message("tool", "", clip(out, TOOL_CAP))
    return None


def parse_pi(o, meta):
    if o.get("type") == "session":
        meta.sid = meta.sid or o.get("id")
        meta.cwd = meta.cwd or o.get("cwd")
        return None
    if o.get("type") != "message":
        return None
    m = o.get("message") or {}
    role = m.get("role")
    text = "\n".join(texts_of(m.get("content"), ("text",))).strip()
    if role == "user":
        if text and not meta.preview:
            meta.preview = one_line(text)
        return Message("user", text, "")
    if role == "assistant":
        return Message("assistant", text, "")
    return Message("tool", "", clip(text, TOOL_CAP))


PARSERS = {"claude": parse_claude, "codex": parse_codex, "pi": parse_pi}
# Cheap byte filters: skip lines that can't carry anything we index. They match the
# compact JSON these agents write (no space after ':'); test_index.py pins that per agent.
WANTED = {
    "claude": (b'"type":"user"', b'"type":"assistant"', b'"ai-title"', b'"custom-title"'),
    "codex": (b'"response_item"', b'"session_meta"'),
    "pi": (b'"type":"message"', b'"type":"session"'),
}


def read_new_lines(path, offset):
    """Stream the complete lines of path from offset: yields (line, end_offset), where
    end_offset is the byte after the line's newline. A half-written last line is left
    for the next update."""
    with open(path, "rb") as f:
        f.seek(offset)
        pos = offset
        for raw in f:
            if not raw.endswith(b"\n"):
                return
            pos += len(raw)
            yield raw, pos


def insert_msgs(db, file_id, msgs):
    """One msgs row + one fts row per message, in two executemany calls."""
    if not msgs:
        return
    # Single writer (update holds the lock), so ids can be allocated up front.
    first = (db.execute("SELECT COALESCE(MAX(id),0) FROM msgs").fetchone()[0]) + 1
    db.executemany("INSERT INTO msgs(id,file_id) VALUES(?,?)", [(first + i, file_id) for i in range(len(msgs))])
    db.executemany(
        "INSERT INTO fts(rowid,user_text,assistant_text,tool_text,meta) VALUES(?,?,?,?,'')",
        [(first + i,
          m.text if m.role == "user" else "",
          m.text if m.role == "assistant" else "",
          m.tool) for i, m in enumerate(msgs)])


def meta_label(meta):
    return " ".join(x for x in (meta.custom, meta.title, meta.cwd, meta.sid) if x) or None


def upsert_meta(db, file_id, meta, old_id, old_label, legacy=False):
    """One meta row per file (title + folder + id), rewritten only when the label changed.
    Returns (meta_id, label) to store on the file. legacy: the file was indexed before
    meta_id existed, so look its meta row up the old way (once)."""
    label = meta_label(meta)
    if old_id is None and legacy:
        row = db.execute("SELECT m.id FROM msgs m JOIN fts ON fts.rowid=m.id WHERE m.file_id=? AND fts.meta<>''", (file_id,)).fetchone()
        old_id = row[0] if row else None
    elif old_id is not None and label == old_label:
        return old_id, label
    if old_id is not None:
        db.execute("DELETE FROM fts WHERE rowid=?", (old_id,))
        db.execute("DELETE FROM msgs WHERE id=?", (old_id,))
    if not label:
        return None, None
    mid = db.execute("INSERT INTO msgs(file_id) VALUES(?)", (file_id,)).lastrowid
    db.execute("INSERT INTO fts(rowid,user_text,assistant_text,tool_text,meta) VALUES(?,'','','',?)", (mid, label))
    return mid, label


def index_file(db, agent, path, st, row, deadline=None):
    """Index path from its last offset (transcripts are append-only), streaming it in
    batches. Stops at the deadline with the offset it reached; returns True when the
    file is fully indexed."""
    sel = "SELECT sid,cwd,title,preview,custom_title,meta_id,meta_label FROM files WHERE id=?"
    if row and st.st_size >= row[2] and row[2] > 0:
        file_id, offset = row[0], row[3]
        state = db.execute(sel, (file_id,)).fetchone()
        meta, meta_id, old_label = Meta(state[:5]), state[5], state[6]
        existed = True
    else:
        existed = False
        if row:
            drop(db, row[0])
        file_id, offset, meta, meta_id, old_label = None, 0, Meta(), None, None
        file_id = db.execute(
            "INSERT INTO files(path,agent,mtime,size,offset) VALUES(?,?,?,?,0)", (path, agent, st.st_mtime, st.st_size)).lastrowid
    parse, wanted = PARSERS[agent], WANTED[agent]
    batch, lines, complete = [], 0, True
    for line, end in read_new_lines(path, offset):
        offset = end
        lines += 1
        if not any(w in line for w in wanted):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        r = parse(o, meta) if isinstance(o, dict) else None
        if r and (r.text or r.tool):
            batch.append(r._replace(text=clip(r.text, TEXT_CAP)))
            if len(batch) >= BATCH:
                insert_msgs(db, file_id, batch)
                batch = []
        if deadline and lines % 200 == 0 and time.time() > deadline:
            complete = False
            break
    insert_msgs(db, file_id, batch)
    meta_id, label = upsert_meta(db, file_id, meta, meta_id, old_label, legacy=existed)
    # A partial run stores the size reached (the offset) instead of the file's size, so the
    # file stays "changed" and the next update resumes from the offset. mtime is always real.
    if offset >= st.st_size:
        complete = True  # nothing left to read, even if the deadline fired on the last line
    mtime, size = st.st_mtime, (st.st_size if complete else offset)
    db.execute(
        "UPDATE files SET sid=?,cwd=?,title=?,preview=?,custom_title=?,meta_id=?,meta_label=?,mtime=?,size=?,offset=? WHERE id=?",
        (meta.sid, meta.cwd, meta.title, meta.preview, meta.custom, meta_id, label, mtime, size, offset, file_id))
    return complete


def drop(db, file_id):
    db.execute("DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE file_id=?)", (file_id,))
    db.execute("DELETE FROM msgs WHERE file_id=?", (file_id,))
    db.execute("DELETE FROM files WHERE id=?", (file_id,))


def update(budget, limit=300, cwds=()):
    with open(os.path.join(DB_DIR, "update.lock"), "w") as lock:  # the flock lives as long as the file is open
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return {"ok": True, "busy": True}
        return run_update(budget, limit, cwds)


def run_update(budget, limit, cwds=()):
    db = connect()
    known = {r[0]: r[1:] for r in db.execute("SELECT path,id,mtime,size,offset FROM files")}
    todo, seen = [], set()
    for agent, path in sources():
        seen.add(path)
        try:
            st = os.stat(path)
        except OSError:
            continue
        row = known.get(path)
        if row and row[1] == st.st_mtime and row[2] == st.st_size:
            continue
        todo.append((st.st_mtime, agent, path, st, row))
    gone = [row for path, row in known.items() if path not in seen]
    for row in gone:
        drop(db, row[0])
    db.commit()
    todo.sort(key=lambda x: x[0], reverse=True)  # newest first
    deadline = time.time() + budget
    done = 0
    for i, (_m, agent, path, st, row) in enumerate(todo):
        if time.time() > deadline:
            break
        try:
            finished = index_file(db, agent, path, st, row, deadline)
        except OSError:
            db.rollback()
            done += 1  # unreadable now (vanished?): not counted as pending
            continue
        db.commit()
        done += 1 if finished else 0
        if not finished:
            break
    pending = len(todo) - done
    out = {"ok": True, "indexed": done, "pending": pending}
    if todo or gone:
        out["recent"] = recent(db, limit, cwds)
        if pending == 0 and done:
            # The incremental inserts fragment the FTS segments; a bounded merge keeps the file from bloating.
            db.execute("INSERT INTO fts(fts, rank) VALUES('merge', ?)", (MERGE_PAGES,))
            db.commit()
    return out


def argv_for(agent, sid, path):
    """Not on the wire: main.js builds the same command from agent/id/path."""
    if agent == "claude":
        return ["claude", "--resume", sid]
    if agent == "codex":
        return ["codex", "resume", sid]
    return ["pi", "--session", path]


def snippet(texts, terms, width=70):
    """{pre, hit, post} around the first term found in any text. The match is
    case-insensitive via re (not lower()), so offsets stay valid for Unicode."""
    for text in texts:
        if not text:
            continue
        for term in terms:
            m = re.search(re.escape(term), text, re.I)
            if not m:
                continue
            i, j = m.span()
            a, b = max(0, i - width), min(len(text), j + width)
            pre = squash(("…" if a else "") + text[a:i]).lstrip()
            post = squash(text[j:b] + ("…" if b < len(text) else "")).rstrip()
            if len(pre) > 48:
                pre = "…" + pre[-47:]
            return {"pre": pre, "hit": text[i:j], "post": post}
    return {"pre": one_line(next((t for t in texts if t), ""), 2 * width), "hit": "", "post": ""}


def result(path, agent, sid, cwd, title, preview, mtime, snip=None):
    return {
        "agent": agent, "id": sid or os.path.splitext(os.path.basename(path))[0],
        "path": path, "cwd": cwd or "", "title": title or "", "preview": preview or "",
        "mtime": int(mtime * 1000), "snippet": snip,
    }


# A /rename title wins over the generated one, as in `claude --resume`.
FILE_COLS = "f.path,f.agent,f.sid,f.cwd,COALESCE(f.custom_title,f.title),f.preview,f.mtime"


def cwd_filter(cwds):
    """(sql, args) keeping files whose folder is one of cwds or lies under one; ("", []) for none."""
    ors, args = [], []
    for c in cwds:
        c = c.rstrip("/")
        like = c.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "/%"
        ors.append("f.cwd = ? OR f.cwd LIKE ? ESCAPE '\\'")
        args += [c, like]
    return ("(" + " OR ".join(ors) + ")", args) if ors else ("", [])


def recent(db, limit, cwds=()):
    cond, cargs = cwd_filter(cwds)
    rows = db.execute(
        f"SELECT {FILE_COLS} FROM files f WHERE sid IS NOT NULL AND (preview IS NOT NULL OR title IS NOT NULL OR custom_title IS NOT NULL) "
        + (f"AND {cond} " if cond else "") + "ORDER BY mtime DESC LIMIT ?", (*cargs, limit))
    return [result(*r) for r in rows]


def build_match(terms):
    longs = [t for t in terms if len(t) >= 3]
    where, args = [], []
    if longs:
        where.append("fts MATCH ?")
        args.append(" AND ".join('"%s"' % t.replace('"', '""') for t in longs))
    for t in (t for t in terms if len(t) < 3):  # trigram can't match under 3 chars: LIKE over the same table
        like = "%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append("(" + " OR ".join(f"fts.{c} LIKE ? ESCAPE '\\'" for c in ("user_text", "assistant_text", "tool_text", "meta")) + ")")
        args += [like] * 4
    return longs, where, args


def search(query, limit, cwds=()):
    db = connect()
    terms = [t.lower() for t in query.split() if t]
    if not terms:
        return {"ok": True, "results": recent(db, limit, cwds)}
    longs, where, args = build_match(terms)
    cond, cargs = cwd_filter(cwds)
    score = "bm25(fts, 10.0, 5.0, 1.0, 8.0)" if longs else "0"
    # One row per session: the best-scoring message (SQLite takes the bare columns,
    # here rid, from the row that has the min score), newest sessions first.
    # limit+1 tells whether more sessions match than we return.
    rows = db.execute(
        f"""WITH hits AS MATERIALIZED (
              SELECT fts.rowid AS rid, m.file_id AS fid, {score} AS score
              FROM fts JOIN msgs m ON m.id=fts.rowid WHERE {' AND '.join(where)})
            SELECT {FILE_COLS}, MIN(score), rid
            FROM hits JOIN files f ON f.id=hits.fid {'WHERE ' + cond if cond else ''} GROUP BY fid ORDER BY f.mtime DESC LIMIT ?""",
        (*args, *cargs, limit + 1)).fetchall()
    out = []
    for path, agent, sid, cwd, title, preview, mtime, _s, rowid in rows[:limit]:
        texts = db.execute("SELECT user_text,assistant_text,tool_text,meta FROM fts WHERE rowid=?", (rowid,)).fetchone()
        out.append(result(path, agent, sid, cwd, title, preview, mtime, snippet(texts, terms)))
    return {"ok": True, "results": out, "capped": len(rows) > limit}


def forget(path):
    db = connect()
    row = db.execute("SELECT id FROM files WHERE path=?", (path,)).fetchone()
    if row:
        drop(db, row[0])
        db.commit()
    return {"ok": True}


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "update"
    opt = lambda name, d: argv[argv.index(name) + 1] if name in argv else d
    cwds = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == "--cwd"]
    os.makedirs(DB_DIR, exist_ok=True)
    if cmd == "update":
        r = update(float(opt("--budget", "20")), int(opt("--limit", "300")), cwds)
    elif cmd == "search":
        r = search(argv[2] if len(argv) > 2 else "", int(opt("--limit", "60")), cwds)
    elif cmd == "forget":
        r = forget(argv[2])
    else:
        r = {"ok": False, "error": f"unknown command {cmd}"}
    print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
