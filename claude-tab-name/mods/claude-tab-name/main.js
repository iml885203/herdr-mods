// Keeps a tab's name and its Claude Code session's name the same.
// Two copies of this mod: a 0 px layout block that follows `/rename` (sync), and the
// rename popup that F2 opens, which renames the tab and types `/rename` into its Claude.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, run, hc, exec, home, appHome, props, closeOverlay, notify, theme, watchFolder, fonts, settings } from "herdr";
import * as fs from "fs/promises";
import { APP, readSession, cleanName, claudeOf, renames, decide, probeResult, settled, PROBE_KEY, kebabName, parseCache, cacheGet, cachePut } from "./logic.js";

const MOD = "claude-tab-name";
const TICK_MS = 15000; // a fallback: the folder watch below brings changes at once
const PID_TTL_MS = 30000; // look again now and then: a crashed Claude can leave its file behind
const MISS_MS = 2000; // a pane with no matching session is asked again at most this often
const DRAFT = "Claude's prompt has unsent text";
const SESSIONS = () => `${home()}/.claude/sessions`;

// Nerd Font glyphs, drawn apart from the label text (as in Claude goal and Orbit).
const ICONS = { tab: "\u{f02b}" }; // nf-fa-tag
const SPINNER = Array.from({ length: 8 }, (_, i) => String.fromCodePoint(0xf0a9e + i)); // nf-md-circle_slice_1..8
const NERD_FONT = "JetBrainsMono Nerd Font";
const mono = () => (fonts().includes(NERD_FONT) ? NERD_FONT : settings().font_family ?? "JetBrains Mono");
const glyph = (color, icon) => div().flex_none().font_family(mono()).text_color(color).child(icon);

const localTabs = () => {
  const tabs = new Map();
  for (const s of spaces()) if (!s.machine) for (const t of s.tabs) tabs.set(t.id, t);
  return tabs;
};

// Claude's pid in a terminal: its foreground program.
async function pidOf(terminal) {
  const r = await hc(["get", terminal]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout).foreground?.pid ?? null; } catch { return null; }
}

// A name for what the Claude in `terminal` is working on (name.sh asks Claude for one). Kept
// per session in a file (5 minutes; a failure 1 minute), so opening the popup again doesn't
// ask again: each popup is a fresh copy of this mod, so memory doesn't last.
const CACHE_DIR = () => `${appHome()}/data/${MOD}`;
const CACHE = () => `${CACHE_DIR()}/suggested.json`;
async function readCache() {
  try { return parseCache(await fs.readFile(CACHE(), "utf8")); } catch { return {}; }
}
async function writeCache(sid, name) {
  try {
    const all = cachePut(await readCache(), sid, name, Date.now());
    await fs.mkdir(CACHE_DIR(), { recursive: true });
    await fs.writeFile(CACHE(), JSON.stringify(all));
  } catch (e) { console.log(`${MOD}: ${e?.message ?? e}`); }
}
async function suggestName(terminal) {
  const pid = await pidOf(terminal);
  if (pid === null) return null;
  let sid = null;
  try { sid = JSON.parse(await fs.readFile(`${SESSIONS()}/${pid}.json`, "utf8")).sessionId ?? null; } catch {}
  if (typeof sid !== "string" || !/^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/.test(sid)) return null; // it goes into a find -name pattern
  const cached = cacheGet(await readCache(), sid, Date.now());
  if (cached.hit) return cached.name;
  const r = await exec("sh", [`${appHome()}/mods/${MOD}/name.sh`, sid]);
  if (r.code !== 0) console.log(`${MOD}: name.sh exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  const name = r.code === 0 ? kebabName(r.stdout) : null;
  await writeCache(sid, name);
  return name;
}

const screen = async (terminal) => {
  const r = await hc(["read", terminal]);
  return r.code === 0 ? r.stdout : null;
};
const pause = (seconds) => exec("sleep", [String(seconds)]); // no timers outside init/handlers

// The probe in one run: type the key ($2) into terminal $1, give Claude 0.4 s to redraw, print
// the screen, take the key back. Exit 3: the key didn't go in (nothing to take back);
// exit 4: the backspace failed; exit 5: the read failed (the key was taken back). hc's own exit
// codes never leak out, so 3 and 4 mean only that.
const PROBE_SH = 'hc keys "$1" "$2" >/dev/null || exit 3; sleep 0.4; hc read "$1"; r=$?; hc keys "$1" backspace >/dev/null || exit 4; [ $r -eq 0 ] || exit 5; exit 0';

// Types `/rename <name>` into the Claude in `terminal`, unless that would mix with what you
// were typing there. `stillClaude()` is asked again right before typing. Returns null when
// sent, else why not.
async function renameClaude(terminal, status, name, stillClaude) {
  const before = await screen(terminal);
  const step = decide(status, before);
  if (step === "probe") {
    // A suggestion or your draft? Type one key, look, and take it back: one shell run, so the
    // backspace comes even if this popup closes meanwhile, and never comes without the key.
    const r = await exec("sh", ["-c", PROBE_SH, "probe", terminal, PROBE_KEY]);
    if (r.code === 3) return "couldn't type into Claude's prompt";
    if (r.code === 4) return `an "${PROBE_KEY}" was left in Claude's prompt (delete it)`;
    const seen = r.code === 0 ? probeResult(before, r.stdout) : "unknown";
    if (seen === "draft") return DRAFT;
    if (seen !== "suggestion") return "couldn't tell Claude's suggestion from a draft";
    // Type only once the box is back as it was (the suggestion again, or empty).
    let back = false;
    for (let i = 0; i < 6 && !back; i++) {
      await pause(0.15);
      back = settled(before, await screen(terminal));
    }
    if (!back) return "Claude's prompt didn't settle";
  } else if (step !== "type") {
    return step;
  }
  if (!stillClaude()) return "Claude is no longer running in that tab";
  // Typed as if by a person. From inside an hc terminal (Herdr started from a shell) `hc send`
  // would mark the text as a message from that terminal, and Claude would read
  // `<hc from=…>/rename …</hc>` as chat instead of running the command, so those variables go.
  const r = await exec("env", ["-u", "HC_TERMINAL_ID", "-u", "HC_TERMINAL_SOCKET", "-u", "HC_SCOPE", "hc", "send", terminal, `/rename ${name}`]);
  return r.code === 0 ? null : (r.stderr || r.stdout).trim().slice(0, 160) || `hc send exited ${r.code}`;
}

export default class ClaudeTabName extends View {
  init(_props, cx) {
    this.closed = false;
    this.tasks = [];
    if (props()?.overlay) return this.initPopup(cx);
    this.synced = new Map(); // terminal -> the session name (and when it was set) the tab last followed
    this.pids = new Map(); // terminal -> {pid, at}: Claude's pid (the terminal's foreground program)
    this.busy = false;
    this.again = false; // a change came in during a run: run once more after it
    this.tasks.push(cx.timer.every(TICK_MS, (cx) => { this.tick(); this.watch(cx); }));
    this.watching = false;
    this.tick();
    this.watch(cx);
  }

  // Claude Code rewrites a session's file when its name (or status) changes. A watch that
  // fails (no folder before the first Claude run) is started again by the fallback timer.
  watch(cx) {
    if (this.watching || this.closed) return;
    this.watching = true;
    cx.spawn(async () => {
      try {
        while (!this.closed) {
          await watchFolder(SESSIONS());
          if (!this.closed) this.tick();
        }
      } catch {} finally { this.watching = false; }
    });
  }

  async close() {
    this.closed = true;
    for (const t of this.tasks) t.cancel();
    this.input?.release?.();
  }

  // ---- sync copy ----

  async tick() {
    if (this.closed) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.again = false;
    try {
      const tabs = localTabs();
      const claudes = panes().filter((p) => p.app === APP && p.terminal && tabs.has(p.tab));
      for (const t of [...this.pids.keys()]) if (!claudes.some((p) => p.terminal === t)) this.pids.delete(t);
      if (claudes.length === 0) return;
      const { named, live } = await this.readSessions();
      const now = Date.now();
      for (const p of claudes) {
        const known = this.pids.get(p.terminal);
        const fresh = known && known.pid !== null && live.has(known.pid) && now - known.at < PID_TTL_MS;
        if (fresh || (known && now - known.at < MISS_MS)) continue; // a miss isn't asked again on every event
        this.pids.set(p.terminal, { pid: await this.pidOf(p.terminal), at: now });
      }
      if (this.closed) return;
      for (const r of renames(panes(), localTabs(), named, (t) => this.pids.get(t)?.pid, this.synced)) run("tab.rename", { id: r.tab, name: r.name });
    } catch (e) {
      console.log(`${MOD}: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
      if (this.again && !this.closed) this.tick();
    }
  }

  // named: pid -> {name, since} for sessions someone named; live: every session's pid.
  async readSessions() {
    const named = new Map();
    const live = new Set();
    let files = [];
    try { files = await fs.readdir(SESSIONS()); } catch { return { named, live }; }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const s = readSession(await fs.readFile(`${SESSIONS()}/${f}`, "utf8"));
        if (!s) continue;
        live.add(s.pid);
        if (s.name) named.set(s.pid, s);
      } catch {}
    }
    return { named, live };
  }

  async pidOf(terminal) {
    return pidOf(terminal);
  }

  // ---- rename popup (F2) ----

  // `props().tab`: the tab to rename (a tab bar opens this with the tab you double-clicked);
  // without it, the focused tab.
  initPopup(cx) {
    const f = focused();
    const tabs = localTabs();
    const want = props()?.tab;
    this.missing = want != null && !tabs.has(want); // asked for a tab that's gone (or on another machine)
    this.tab = (want != null ? tabs.get(want) : f && tabs.get(f.tab)) ?? null;
    this.claude = this.tab ? claudeOf(panes(), this.tab.id, f?.tab === this.tab.id ? f.terminal : null) : null;
    this.input = InputState.new({ placeholder: this.tab ? `Tab ${this.tab.index}` : "Name", value: this.tab?.named ? this.tab.name : "" });
    this.input.on("submit", (_e, cx) => this.apply(cx));
    this.input.focus();
    this.tasks.push(cx.timer.after(300, () => this.input.focus()));
    // A name for what its Claude is working on, offered as a chip: Tab or a click puts it in
    // the field (never by itself, so Enter on an empty field still puts the tab back to its
    // number). It starts a moment after the popup opens: a quick Esc costs nothing.
    this.suggestion = null;
    this.used = false; // the suggestion was put in the field
    this.suggesting = !!this.claude;
    if (this.claude) {
      const term = this.claude.terminal;
      this.tasks.push(cx.timer.after(400, (cx) => cx.spawn(async (cx) => {
        let name = null;
        try { name = await suggestName(term); } catch (e) { console.log(`${MOD}: ${e?.message ?? e}`); }
        if (this.closed) return;
        this.suggesting = false;
        this.suggestion = name;
        cx.notify();
      })));
    }
  }

  useSuggestion() {
    if (!this.suggestion || this.applying) return false;
    this.input.set_value(this.suggestion);
    this.input.focus();
    this.used = true;
    return true;
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  // The popup stays open (and alive) until Claude has the name: a closed popup's tasks stop.
  async apply(cx) {
    if (this.applying) return;
    const tab = this.tab;
    if (!tab) return this.dismiss();
    const name = cleanName(this.input.value());
    run("tab.rename", { id: tab.id, name }); // empty: the tab goes back to its number
    const term = this.claude?.terminal;
    const claudePane = () => panes().find((p) => p.terminal === term && p.tab === tab.id && p.app === APP);
    const c = term && claudePane();
    if (!name || !c) return this.dismiss(); // Claude can't go back to "no name": an empty name stays on the tab
    this.applying = true;
    cx?.notify();
    let why;
    try { why = await renameClaude(term, c.status, name, () => !!claudePane()); } catch (e) { why = e?.message ?? String(e); }
    if (this.closed) return;
    this.dismiss();
    if (why) notify({ title: "Tab renamed, Claude not", body: `${why}. Run /rename ${name} in Claude to match.`, level: "warning" });
  }

  render() {
    const t = theme();
    if (!props()?.overlay) return div();
    const note = this.missing ? "That tab is gone." : !this.tab ? "No tab is focused."
      : this.applying ? "Renaming the Claude session…"
      : this.claude ? "Its Claude session gets the name too."
      : "No Claude in this tab: the tab only.";
    return v_flex()
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (e.keystroke === "tab" || e.keystroke === "shift-tab") { this.useSuggestion(); cx.stop_propagation(); cx.notify(); return; } // Tab never leaves the field
        if (e.keystroke !== "escape") return;
        cx.stop_propagation();
        if (!this.applying) this.dismiss(); // mid-rename it finishes on its own, in a second
      })
      .child(h_flex().items_center().gap(8)
        .child(glyph(t.accent, ICONS.tab).text_size(15))
        .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child("Rename tab"))
        .child(div().flex_1())
        .child(div().min_w(0).truncate().text_size(10.5).text_color(this.missing ? t.blocked : t.dim).child(note)))
      .child(h_flex().h(34).flex_none().px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(h_flex().h(22).gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_none().child("Suggested"))
        .when(this.suggesting, (el) => el.child(h_flex().id("suggest-busy").gap(6).items_center()
          .child(div().flex_none().font_family(mono()).text_color(t.accent).frames(SPINNER, 110))
          .child(div().child("Thinking of a name…"))))
        .when(!this.suggesting && !this.suggestion, (el) => el.child(div().child(this.claude ? "none" : "only for a Claude tab")))
        .when(!!this.suggestion && this.suggestion === this.tab?.name, (el) => el.child(div().child(`${this.suggestion} (the tab's name already)`)))
        .when(!!this.suggestion && this.suggestion !== this.tab?.name, (el) => el.child(h_flex().id("suggestion").h(22).px(8).gap(6).items_center().rounded(6).cursor_pointer()
          .bg(t.selected).text_color(t.foreground).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.useSuggestion(); cx.notify(); })
          .child(div().child(this.suggestion ?? ""))
          .when(this.used, (el) => el.child(div().text_color(t.dim).child("in the field"))))))
      .child(div().flex_1())
      .child(h_flex().h(16).flex_none().gap(14).items_center().text_size(10.5).text_color(t.dim)
        .child("↵ rename")
        .when(!!this.suggestion && this.suggestion !== this.tab?.name && !this.used && !this.applying, (el) => el.child("⇥ use suggestion"))
        .when(!this.applying, (el) => el.child("esc close")));
  }
}
