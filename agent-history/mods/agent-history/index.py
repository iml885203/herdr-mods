#!/usr/bin/env python3
"""Full-text index of agent transcripts (Claude Code, Codex, Pi) for the
agent-history mod. Same shape as Orca's session search: one FTS5 row per
message with user / assistant / tool columns, rebuilt incrementally from each
transcript's size and mtime. The trigram tokenizer makes CJK text searchable.

  index.py update [--budget SECONDS]   index new/changed transcripts
  index.py search QUERY [--limit N]    newest matching sessions with a snippet
  index.py forget PATH                 drop one transcript from the index
"""
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
HIT_START, HIT_END = "", ""
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
    return db


def sources():
    """(agent, path) for every transcript we know how to read."""
    roots = [
        ("claude", os.path.join(HOME, ".claude", "projects"), (".jsonl",)),
        ("codex", os.path.join(HOME, ".codex", "sessions"), (".jsonl",)),
        ("pi", os.path.join(HOME, ".pi", "agent", "sessions"), (".jsonl",)),
    ]
    for agent, root, exts in roots:
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d != "subagents"]
            for f in files:
                if f.endswith(exts):
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


class Meta:
    def __init__(self, row=None):
        self.sid, self.cwd, self.title, self.preview = row or (None, None, None, None)


def parse_claude(o, meta):
    if o.get("sessionId") and not meta.sid:
        meta.sid = o["sessionId"]
    if o.get("cwd") and not meta.cwd:
        meta.cwd = o["cwd"]
    t = o.get("type")
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
    return t, text, "\n".join(tool)


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
        return p["role"], text, ""
    if pt in ("function_call", "custom_tool_call"):
        return "tool", "", clip(p.get("arguments") or p.get("input"), TOOL_CAP)
    if pt in ("function_call_output", "custom_tool_call_output"):
        out = p.get("output")
        if not isinstance(out, str):
            out = json.dumps(out, ensure_ascii=False)
        return "tool", "", clip(out, TOOL_CAP)
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
        return "user", text, ""
    if role == "assistant":
        return "assistant", text, ""
    return "tool", "", clip(text, TOOL_CAP)


PARSERS = {"claude": parse_claude, "codex": parse_codex, "pi": parse_pi}
# Cheap byte filters: skip lines that can't carry anything we index.
WANTED = {
    "claude": (b'"type":"user"', b'"type":"assistant"', b'"ai-title"'),
    "codex": (b'"response_item"', b'"session_meta"'),
    "pi": (b'"type":"message"', b'"type":"session"'),
}


def index_file(db, agent, path, st, row):
    """Index path from its last offset (transcripts are append-only)."""
    if row and st.st_size >= row[2] and row[2] > 0:
        file_id, offset = row[0], row[3]
        meta = Meta(db.execute("SELECT sid,cwd,title,preview FROM files WHERE id=?", (file_id,)).fetchone())
    else:
        if row:
            drop(db, row[0])
        file_id, offset, meta = None, 0, Meta()
    parse, wanted = PARSERS[agent], WANTED[agent]
    rows = []
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1
    for line in data[:end].split(b"\n"):
        if not line or not any(w in line for w in wanted):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if not isinstance(o, dict):
            continue
        r = parse(o, meta)
        if r and (r[1] or r[2]):
            role, text, tool = r
            text = clip(text, TEXT_CAP)
            rows.append((text if role == "user" else "", text if role == "assistant" else "", tool))
    offset += end
    if file_id is None:
        cur = db.execute(
            "INSERT INTO files(path,agent,mtime,size,offset) VALUES(?,?,?,?,?)",
            (path, agent, st.st_mtime, st.st_size, offset))
        file_id = cur.lastrowid
    db.execute(
        "UPDATE files SET sid=?,cwd=?,title=?,preview=?,mtime=?,size=?,offset=? WHERE id=?",
        (meta.sid, meta.cwd, meta.title, meta.preview, st.st_mtime, st.st_size, offset, file_id))
    for u, a, t in rows:
        mid = db.execute("INSERT INTO msgs(file_id) VALUES(?)", (file_id,)).lastrowid
        db.execute("INSERT INTO fts(rowid,user_text,assistant_text,tool_text,meta) VALUES(?,?,?,?,'')", (mid, u, a, t))
    # One meta row per file: title + folder, rewritten as they change.
    old = db.execute("SELECT m.id FROM msgs m JOIN fts ON fts.rowid=m.id WHERE m.file_id=? AND fts.meta<>''", (file_id,)).fetchone()
    if old:
        db.execute("DELETE FROM fts WHERE rowid=?", (old[0],))
        db.execute("DELETE FROM msgs WHERE id=?", (old[0],))
    label = " ".join(x for x in (meta.title, meta.cwd, meta.sid) if x)
    if label:
        mid = db.execute("INSERT INTO msgs(file_id) VALUES(?)", (file_id,)).lastrowid
        db.execute("INSERT INTO fts(rowid,user_text,assistant_text,tool_text,meta) VALUES(?,'','','',?)", (mid, label))


def drop(db, file_id):
    db.execute("DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE file_id=?)", (file_id,))
    db.execute("DELETE FROM msgs WHERE file_id=?", (file_id,))
    db.execute("DELETE FROM files WHERE id=?", (file_id,))


def update(budget):
    lock = open(os.path.join(DB_DIR, "update.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return {"ok": True, "busy": True}
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
    for path, row in known.items():
        if path not in seen:
            drop(db, row[0])
    db.commit()
    todo.sort(key=lambda x: x[0], reverse=True)  # newest first
    deadline = time.time() + budget
    done = 0
    for _m, agent, path, st, row in todo:
        if time.time() > deadline:
            break
        try:
            index_file(db, agent, path, st, row)
        except OSError:
            continue
        db.commit()
        done += 1
    return {"ok": True, "indexed": done, "pending": len(todo) - done}


def argv_for(agent, sid, path):
    if agent == "claude":
        return ["claude", "--resume", sid]
    if agent == "codex":
        return ["codex", "resume", sid]
    return ["pi", "--session", path]


def snippet(texts, terms, width=70):
    for text in texts:
        if not text:
            continue
        low = text.lower()
        for term in terms:
            i = low.find(term)
            if i < 0:
                continue
            a, b = max(0, i - width), min(len(text), i + len(term) + width)
            pre = ("…" if a else "") + text[a:i]
            post = text[i + len(term):b] + ("…" if b < len(text) else "")
            return squash(pre).lstrip() + HIT_START + text[i:i + len(term)] + HIT_END + squash(post).rstrip()
    return one_line(next((t for t in texts if t), ""), 2 * width)


def result(agent, path, sid, cwd, title, preview, mtime, size, snip=""):
    sid = sid or os.path.splitext(os.path.basename(path))[0]
    return {
        "agent": agent, "id": sid, "path": path, "cwd": cwd or "",
        "folder": os.path.basename((cwd or "").rstrip("/")) or (cwd or ""),
        "title": title or "", "preview": preview or "",
        "mtime": int(mtime * 1000), "size": size,
        "argv": argv_for(agent, sid, path), "snippet": snip,
    }


COLS = "id,path,agent,sid,cwd,title,preview,mtime,size"


def recent(db, limit):
    rows = db.execute(f"SELECT {COLS} FROM files WHERE sid IS NOT NULL AND (preview IS NOT NULL OR title IS NOT NULL) ORDER BY mtime DESC LIMIT ?", (limit,))
    return {"ok": True, "results": [result(a, p, s, c, t, pv, m, z) for _i, p, a, s, c, t, pv, m, z in rows]}


def search(query, limit):
    db = connect()
    terms = [t.lower() for t in query.split() if t]
    if not terms:
        return recent(db, limit)
    longs = [t for t in terms if len(t) >= 3]
    shorts = [t for t in terms if len(t) < 3]
    where, args = [], []
    if longs:
        where.append("fts MATCH ?")
        args.append(" AND ".join('"%s"' % t.replace('"', '""') for t in longs))
    for t in shorts:  # trigram can't match under 3 chars: LIKE over the same table
        like = "%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append("(" + " OR ".join(f"{c} LIKE ? ESCAPE '\\'" for c in ("user_text", "assistant_text", "tool_text", "meta")) + ")")
        args += [like] * 4
    score = "bm25(fts, 10.0, 5.0, 1.0, 8.0)" if longs else "0"
    sql = f"""SELECT fts.rowid, m.file_id, {score} FROM fts JOIN msgs m ON m.id=fts.rowid
              WHERE {' AND '.join(where)} LIMIT 20000"""
    best = {}
    for rowid, file_id, s in db.execute(sql, args):
        if file_id not in best or s < best[file_id][1]:
            best[file_id] = (rowid, s)
    if not best:
        return {"ok": True, "results": []}
    marks = ",".join("?" * len(best))
    files = db.execute(
        f"SELECT {COLS} FROM files WHERE id IN ({marks}) ORDER BY mtime DESC LIMIT ?",
        (*best.keys(), limit)).fetchall()
    out = []
    for fid, path, agent, sid, cwd, title, preview, mtime, size in files:
        u, a, t, meta = db.execute("SELECT user_text,assistant_text,tool_text,meta FROM fts WHERE rowid=?", (best[fid][0],)).fetchone()
        out.append(result(agent, path, sid, cwd, title, preview, mtime, size, snippet([u, a, t, meta], longs + shorts)))
    return {"ok": True, "total": len(best), "results": out}


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
    os.makedirs(DB_DIR, exist_ok=True)
    if cmd == "update":
        r = update(float(opt("--budget", "20")))
    elif cmd == "search":
        r = search(argv[2] if len(argv) > 2 else "", int(opt("--limit", "60")))
    elif cmd == "forget":
        r = forget(argv[2])
    else:
        r = {"ok": False, "error": f"unknown command {cmd}"}
    print(json.dumps(r, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
