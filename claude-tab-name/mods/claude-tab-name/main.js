// Keeps a tab's name and its Claude Code session's name the same.
// Two copies of this mod: a 0 px layout block that follows `/rename` (sync), and the
// rename popup that F2 opens, which renames the tab and types `/rename` into its Claude.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, run, hc, exec, home, props, closeOverlay, notify, theme } from "herdr";
import * as fs from "fs/promises";
import { APP, readSession, cleanName, claudeOf, renames, decide, probeResult, settled, PROBE_KEY } from "./logic.js";

const MOD = "claude-tab-name";
const TICK_MS = 2000;
const PID_TTL_MS = 30000; // look again now and then: a crashed Claude can leave its file behind
const DRAFT = "Claude's prompt has unsent text";
const SESSIONS = () => `${home()}/.claude/sessions`;

const localTabs = () => {
  const tabs = new Map();
  for (const s of spaces()) if (!s.machine) for (const t of s.tabs) tabs.set(t.id, t);
  return tabs;
};

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
    this.tasks.push(cx.timer.every(TICK_MS, () => this.tick()));
    this.tick();
  }

  async close() {
    this.closed = true;
    for (const t of this.tasks) t.cancel();
    this.input?.release?.();
  }

  // ---- sync copy ----

  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const tabs = localTabs();
      const claudes = panes().filter((p) => p.app === APP && p.terminal && tabs.has(p.tab));
      for (const t of [...this.pids.keys()]) if (!claudes.some((p) => p.terminal === t)) this.pids.delete(t);
      if (claudes.length === 0) return;
      const { named, live } = await this.readSessions();
      const now = Date.now();
      for (const p of claudes) {
        const known = this.pids.get(p.terminal);
        if (known && known.pid !== null && live.has(known.pid) && now - known.at < PID_TTL_MS) continue;
        this.pids.set(p.terminal, { pid: await this.pidOf(p.terminal), at: now });
      }
      if (this.closed) return;
      for (const r of renames(panes(), localTabs(), named, (t) => this.pids.get(t)?.pid, this.synced)) run("tab.rename", { id: r.tab, name: r.name });
    } catch (e) {
      console.log(`${MOD}: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
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
    const r = await hc(["get", terminal]);
    if (r.code !== 0) return null;
    try { return JSON.parse(r.stdout).foreground?.pid ?? null; } catch { return null; }
  }

  // ---- rename popup (F2) ----

  initPopup(cx) {
    const f = focused();
    this.tab = f ? localTabs().get(f.tab) ?? null : null;
    this.claude = this.tab ? claudeOf(panes(), this.tab.id, f.terminal) : null;
    this.input = InputState.new({ placeholder: this.tab ? `Tab ${this.tab.index}` : "Name", value: this.tab?.named ? this.tab.name : "" });
    this.input.on("submit", (_e, cx) => this.apply(cx));
    this.input.focus();
    this.tasks.push(cx.timer.after(300, () => this.input.focus()));
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
    const note = !this.tab ? "No tab is focused."
      : this.applying ? "Renaming the Claude session…"
      : this.claude ? "Its Claude session gets the name too."
      : "No Claude in this tab: the tab only.";
    return v_flex()
      .size_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        if (e.keystroke !== "escape") return;
        cx.stop_propagation();
        if (!this.applying) this.dismiss(); // mid-rename it finishes on its own, in a second
      })
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Rename tab"))
      .child(h_flex().h(34).flex_none().px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(h_flex().gap(12).text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(note))
        .child(div().flex_none().child("↵ rename   esc cancel")));
  }
}
