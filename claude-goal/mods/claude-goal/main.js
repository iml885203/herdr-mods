import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, focused, fonts, hc, home, props, readTextFile, run, settings, theme, writeTextFile } from "herdr";

const DATA = () => `${appHome()}/data/claude-goal`;
const KEEP = 20;
// macOS has no `timeout`: goal.sh bounds claude with perl's alarm (SCRIPT_TIMEOUT_S there);
// this is the UI's own backstop so a hung hc/read/exec can never leave the popup stuck on "busy".
const BUSY_LIMIT_MS = 90000;

// Nerd Font glyphs, drawn apart from the label text (same helper as Orbit's widgets.js).
const ICONS = { goal: "\u{f140}", error: "\u{f06a}" };
const SPINNER = Array.from({ length: 8 }, (_, i) => String.fromCodePoint(0xf0a9e + i)); // nf-md-circle_slice_1..8
const NERD_FONT = "JetBrainsMono Nerd Font";
const mono = () => (fonts().includes(NERD_FONT) ? NERD_FONT : settings().font_family ?? "JetBrains Mono");
const glyph = (color, icon) => div().flex_none().font_family(mono()).text_color(color).child(icon);
const tint = (color, alpha) => `${String(color).slice(0, 7)}${alpha}`;

const isClaude = (foreground) => ((foreground?.argv?.[0] ?? "").split("/").pop() ?? "").startsWith("claude");

// Claude Code writes ~/.claude/sessions/<pid>.json ({ sessionId, ... }) for each running
// process. That file is an internal detail of Claude Code, not a documented interface: if a
// future version moves or renames it, the popup says "not running Claude Code".
async function sessionIdOf(terminal) {
  const got = await hc(["get", terminal, "--json"]);
  if (got.code !== 0) return null;
  const foreground = JSON.parse(got.stdout).foreground;
  if (!isClaude(foreground) || !foreground.pid) return null;
  const text = await readTextFile(`${home()}/.claude/sessions/${foreground.pid}.json`);
  return text ? JSON.parse(text).sessionId ?? null : null;
}

async function generate(sessionId) {
  const result = await exec("sh", [`${appHome()}/mods/claude-goal/goal.sh`, sessionId]);
  const line = result.stdout.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^\/goal\s*/, "");
  if (result.code === 142) throw new Error("Claude took too long to answer"); // SIGALRM from goal.sh
  if (result.code !== 0 || !line) throw new Error(result.stderr.trim() || `exit ${result.code}`);
  return `/goal ${line}`;
}

// Past goals per Claude session, newest first: data/claude-goal/<sessionId>.json
const historyFile = (sessionId) => `${DATA()}/${sessionId}.json`;

async function readHistory(sessionId) {
  const text = await readTextFile(historyFile(sessionId)).catch(() => null);
  try { return { text, goals: text ? JSON.parse(text) : [] }; } catch { return { text, goals: [] }; }
}

async function remember(sessionId, goal) {
  await exec("mkdir", ["-p", DATA()]);
  const { text, goals } = await readHistory(sessionId);
  const next = [{ goal, at: Date.now() }, ...goals.filter((g) => g.goal !== goal)].slice(0, KEEP);
  await writeTextFile(historyFile(sessionId), JSON.stringify(next, null, 1), text);
  return next;
}

const ago = (at) => {
  const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

export default class Goal extends View {
  init(_props, cx) {
    this.terminal = focused()?.terminal ?? null;
    this.sessionId = null;
    this.goals = [];
    this.at = 0;
    this.loading = true;
    this.generating = false;
    this.error = this.terminal ? null : "No terminal focused";
    this.closed = false;
    this.handle = cx.focus_handle();
    this.busySince = Date.now();
    this.run = 0; // bumped to abandon an in-flight generate whose result no longer matters
    // Timers only from init (QuickJS). The spinner is native (.frames), not a timer; this one
    // only checks the busy backstop once a second and redraws just when it trips.
    this.tasks = [
      cx.timer.after(50, () => this.handle.focus()),
      cx.timer.every(1000, (cx) => {
        if (!this.busy() || Date.now() - this.busySince < BUSY_LIMIT_MS) return;
        this.run++;
        this.loading = false;
        this.generating = false;
        this.error = "Timed out";
        cx.notify();
      }),
    ];
    if (this.terminal) cx.spawn((cx) => this.open(cx));
  }

  // Shows this session's past goals; generates one only when there are none yet.
  async open(cx) {
    const run = ++this.run;
    const stale = () => run !== this.run || this.closed; // timed out or closed meanwhile: the UI moved on
    try {
      const sessionId = await sessionIdOf(this.terminal);
      if (stale()) return;
      if (!sessionId) throw new Error("This terminal is not running Claude Code");
      this.sessionId = sessionId;
      const { goals } = await readHistory(sessionId);
      if (stale()) return;
      this.goals = goals;
      this.loading = false;
      if (this.goals.length === 0) return this.generate(cx);
    } catch (error) {
      if (stale()) return;
      this.error = String(error?.message ?? error);
    }
    this.loading = false;
    if (!this.closed) cx.notify();
  }

  async generate(cx) {
    const run = ++this.run;
    this.generating = true;
    this.busySince = Date.now();
    this.error = null;
    if (!this.closed) cx.notify();
    try {
      const goal = await generate(this.sessionId);
      if (run !== this.run) return; // timed out meanwhile: an abandoned goal is not written to history
      const goals = await remember(this.sessionId, goal);
      if (run !== this.run) return;
      this.goals = goals;
      this.at = 0;
      this.error = null; // a late "Timed out" does not outlive a run that worked
    } catch (error) {
      if (run !== this.run) return;
      this.error = String(error?.message ?? error);
    }
    this.generating = false;
    if (!this.closed) cx.notify();
  }

  async close() {
    this.closed = true;
    for (const task of this.tasks) task.cancel();
    this.handle.release();
  }

  busy() {
    return this.loading || this.generating;
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  banner(t) {
    if (this.error) {
      return h_flex().id("goal-error").px(10).py(8).gap(8).items_start().rounded(8)
        .border_1().border_color(tint(t.blocked, "66")).bg(tint(t.blocked, "14"))
        .child(glyph(t.blocked, ICONS.error))
        .child(div().flex_1().min_w(0).text_color(t.blocked).child(this.error));
    }
    if (!this.busy()) return null;
    return h_flex().id("goal-busy").px(10).py(8).gap(8).items_center().rounded(8)
      .border_1().border_color(tint(t.accent, "66")).bg(tint(t.accent, "14"))
      .child(div().flex_none().font_family(mono()).text_color(t.accent).text_size(15).frames(SPINNER, 110))
      .child(div().flex_1().text_color(t.foreground).child(this.loading ? "Loading…" : "Writing a goal…"));
  }

  // Everything happens in this one handler: the mod stops once its popup closes.
  bringIn(cx, goal) {
    cx.write_to_clipboard(goal);
    this.dismiss();
    run("pane.focus", { terminal: this.terminal });
    run("terminal.paste");
  }

  copy(cx, goal) {
    cx.write_to_clipboard(goal);
    this.dismiss();
  }

  row(t, g, i) {
    const sel = i === this.at;
    return h_flex().id(`goal-${i}`).px(10).py(6).gap(10).rounded(6).items_center().cursor_pointer()
      .when(sel, (el) => el.bg(t.selected))
      .when(!sel, (el) => el.hover((el) => el.bg(t.hover)))
      .on_click((_e, cx) => { if (this.at === i) return this.bringIn(cx, g.goal); this.at = i; cx.notify(); })
      .child(div().flex_1().min_w(0).text_color(sel ? t.foreground : t.muted).child(g.goal))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ago(g.at)));
  }

  render() {
    const t = theme();
    const sel = this.goals[this.at];
    const banner = this.banner(t);

    return v_flex()
      .id("goal")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") return this.dismiss();
        if (k === "cmd-r" && this.sessionId && !this.busy()) { cx.spawn((cx) => this.generate(cx)); return; }
        if (!sel) return;
        if (k === "enter") return this.bringIn(cx, sel.goal);
        if (k === "cmd-c") return this.copy(cx, sel.goal);
        if (k === "down") this.at = Math.min(this.at + 1, this.goals.length - 1);
        else if (k === "up") this.at = Math.max(this.at - 1, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(glyph(t.accent, ICONS.goal).text_size(15))
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Claude goal"))
        .child(div().flex_1())
        .when(this.goals.length > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${this.goals.length} goals`))))
      .when(Boolean(banner), (el) => el.child(banner))
      .child(v_flex().id("goal-list").flex_1().min_h(0).overflow_y_scroll().gap(2)
        .children(this.goals.map((g, i) => this.row(t, g, i))))
      .child(h_flex().flex_none().gap(14).text_size(10.5).text_color(t.dim)
        .child("↵ use")
        .child("⌘C copy")
        .child("⌘R new goal")
        .child("esc close"));
  }
}
