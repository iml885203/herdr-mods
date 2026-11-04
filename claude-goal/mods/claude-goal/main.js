import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, focused, fonts, hc, home, props, readTextFile, run, settings, theme, writeTextFile } from "herdr";

const DATA = () => `${appHome()}/data/claude-goal`;
const KEEP = 20;

// Nerd Font glyphs, drawn apart from the label text (same helper as Orbit's widgets.js).
const ICONS = { goal: "\u{f140}", error: "\u{f06a}" };
const SPINNER = Array.from({ length: 8 }, (_, i) => String.fromCodePoint(0xf0a9e + i)); // nf-md-circle_slice_1..8
const NERD_FONT = "JetBrainsMono Nerd Font";
const mono = () => (fonts().includes(NERD_FONT) ? NERD_FONT : settings().font_family ?? "JetBrains Mono");
const glyph = (color, icon) => div().flex_none().font_family(mono()).text_color(color).child(icon);
const tint = (color, alpha) => `${String(color).slice(0, 7)}${alpha}`;

const isClaude = (foreground) => ((foreground?.argv?.[0] ?? "").split("/").pop() ?? "").startsWith("claude");

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
    this.frame = 0;
    // Timers only from init (QuickJS); the spinner ticks only while something is running.
    this.tasks = [
      cx.timer.after(50, () => this.handle.focus()),
      cx.timer.every(110, (cx) => { if (this.busy()) { this.frame = (this.frame + 1) % SPINNER.length; cx.notify(); } }),
    ];
    if (this.terminal) cx.spawn((cx) => this.open(cx));
  }

  // Shows this session's past goals; generates one only when there are none yet.
  async open(cx) {
    try {
      this.sessionId = await sessionIdOf(this.terminal);
      if (!this.sessionId) throw new Error("This terminal is not running Claude Code");
      this.goals = (await readHistory(this.sessionId)).goals;
      this.loading = false;
      if (this.goals.length === 0) return this.generate(cx);
    } catch (error) {
      this.error = String(error?.message ?? error);
    }
    this.loading = false;
    if (!this.closed) cx.notify();
  }

  async generate(cx) {
    this.generating = true;
    this.error = null;
    if (!this.closed) cx.notify();
    try {
      this.goals = await remember(this.sessionId, await generate(this.sessionId));
      this.at = 0;
    } catch (error) {
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
      .child(glyph(t.accent, SPINNER[this.frame]).text_size(15))
      .child(div().flex_1().text_color(t.foreground).child(this.loading ? "Loading…" : "Writing a goal…"))
      .when(this.generating, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("about 3 s")));
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
        if (k === "cmd-r" && this.sessionId && !this.generating) { cx.spawn((cx) => this.generate(cx)); return; }
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
