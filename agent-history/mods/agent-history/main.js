// Agent session history (Orca-style): every Claude Code / Codex / Pi session,
// full-text search over what was said, Enter resumes it in a tab.
// Based on itisvincent/herdr-session-history (MIT); the full-text index lives in index.py.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { spaces, panes, run, theme, shared, setShared, exec, home, appHome, props, closeOverlay, window } from "herdr";

const isMac = () => window()?.platform === "macos";

const INDEX = () => `${appHome()}/mods/agent-history/index.py`;
const SCOPES = [
  { id: "all", label: "All" },
  { id: "folder", label: "This space" },
];
const ROW_H = 50;
// Brand colors: Claude terracotta, Codex blue.
const AGENT_COLORS = { claude: "#D97757", codex: "#6E8BFF" };
const HIT_START = "";
const HIT_END = "";

const scopeOf = () => SCOPES.find((s) => s.id === shared("agent-history.scope")) ?? SCOPES[0];
const norm = (p) => String(p || "").replace(/\/+$/, "");
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function age(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d` : `${Math.floor(d / 30)}mo`;
}

async function index(args) {
  const r = await exec("python3", ["-I", INDEX(), ...args]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `index.py exited ${r.code}`).trim().slice(-240));
  return JSON.parse(r.stdout.trim() || "{}");
}

export default class SessionHistory extends View {
  init(_props, cx) {
    this.input = InputState.new({ placeholder: "Search sessions: titles, prompts, replies, tool output…" });
    this.input.on("change", (_e, cx) => this.queryChanged(cx));
    this.input.on("submit", () => this.resume(this.visible()[this.at]));
    this.input.focus();
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.query = "";
    this.recent = [];
    this.results = null; // null = no query, show recent
    this.at = 0;
    this.error = null;
    this.indexing = null;
    this.searching = false;
    this.token = 0;
    this.confirmDelete = null;
    this.closed = false;
    this.busy = false;
    this.debounce = null;
    // Timers only from init/handlers (QuickJS), kept so close() can stop them.
    this.tasks = [
      cx.timer.after(600, () => this.input.focus()),
      cx.timer.every(15000, (cx) => this.kick(cx)),
    ];
    this.loadRecent(cx);
    this.kick(cx);
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  async close() {
    this.closed = true;
    for (const task of this.tasks) task.cancel();
    this.debounce?.cancel();
    for (const x of [this.scroll, this.input, this.handle]) x?.release?.();
  }

  // Index new/changed transcripts; the first run catches up in 8 s slices.
  kick(cx) {
    if (this.busy || this.closed) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      do await this.update(cx); while (this.indexing && !this.closed);
      this.busy = false;
    });
  }

  async update(cx) {
    try {
      const r = await index(["update", "--budget", "8"]);
      this.indexing = r.pending > 0 ? r.pending : null;
      if (r.indexed > 0) {
        await this.fetchRecent(cx);
        if (this.query) await this.search(cx, this.token);
      }
    } catch (e) {
      this.error = String(e.message || e);
      cx.notify();
    }
  }

  loadRecent(cx) {
    cx.spawn((cx) => this.fetchRecent(cx));
  }

  async fetchRecent(cx) {
    try {
      const r = await index(["search", "", "--limit", "300"]);
      this.recent = r.results || [];
      this.error = null;
    } catch (e) {
      this.error = String(e.message || e);
    }
    cx.notify();
  }

  queryChanged(cx) {
    this.query = this.input.value().trim();
    this.at = 0;
    this.confirmDelete = null;
    const token = ++this.token;
    if (!this.query) {
      this.results = null;
      cx.notify();
      return;
    }
    this.debounce?.cancel();
    this.debounce = cx.timer.after(180, (cx) => {
      if (token === this.token) cx.spawn((cx) => this.search(cx, token));
    });
  }

  async search(cx, token) {
    this.searching = true;
    cx.notify();
    try {
      const r = await index(["search", this.query, "--limit", "200"]);
      if (token !== this.token) return;
      this.results = r.results || [];
      this.error = null;
    } catch (e) {
      if (token !== this.token) return;
      this.error = String(e.message || e);
    }
    this.searching = false;
    cx.notify();
  }

  // Folders the active space works in: its live terminals' cwds.
  activeFolders() {
    const active = spaces().find((s) => s.active);
    const out = new Set();
    if (!active) return out;
    const tabIds = new Set((active.tabs || []).map((t) => t.id));
    for (const p of panes()) if (p.terminal && tabIds.has(p.tab) && p.cwd) out.add(norm(p.cwd));
    if (active.folder) out.add(norm(active.folder));
    return out;
  }

  visible() {
    const list = this.results ?? this.recent;
    if (scopeOf().id !== "folder") return list;
    const folders = this.activeFolders();
    return list.filter((s) => {
      const c = norm(s.cwd);
      for (const f of folders) if (c === f || c.startsWith(f + "/")) return true;
      return false;
    });
  }

  resume(s) {
    if (!s?.argv?.length) return;
    const folder = s.cwd || home();
    const name = s.title || s.folder || s.agent;
    // Several spaces can share a folder: the one you are in wins, else the first that matches.
    const matches = spaces().filter((sp) => !sp.machine && norm(sp.folder) === norm(folder));
    const existing = matches.find((sp) => sp.active) ?? matches[0];
    if (existing) {
      run("tab.new", { name, space: existing.id, folder, argv: s.argv });
      if (!existing.active) run("space.select", { id: existing.id });
    } else {
      run("space.new", { name, folder, argv: s.argv });
    }
    this.dismiss();
  }

  copyCmd(s) {
    const cmd = `cd ${shellQuote(s.cwd || home())} && ${s.argv.map(shellQuote).join(" ")}`;
    // macOS pbcopy; Linux wl-copy (Wayland) or xclip (X11).
    const copy = isMac() ? "pbcopy" : "command -v wl-copy >/dev/null && wl-copy || xclip -selection clipboard";
    exec("sh", ["-c", `printf %s "$1" | ${copy}`, "_", cmd]).catch(() => {});
  }

  reveal(s) {
    // macOS selects the file in Finder; elsewhere open its folder.
    if (isMac()) exec("open", ["-R", s.path]).catch(() => {});
    else exec("xdg-open", [s.path.replace(/\/[^/]*$/, "")]).catch(() => {});
  }

  delete(s, cx) {
    if (this.confirmDelete !== s.path) {
      this.confirmDelete = s.path;
      cx.notify();
      return;
    }
    this.confirmDelete = null;
    cx.spawn(async (cx) => {
      const r = await exec("rm", ["-f", "--", s.path]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) { this.error = `Could not delete: ${(r.stderr || "").trim().slice(0, 160)}`; cx.notify(); return; }
      await index(["forget", s.path]).catch(() => {});
      this.recent = this.recent.filter((x) => x.path !== s.path);
      if (this.results) this.results = this.results.filter((x) => x.path !== s.path);
      cx.notify();
    });
  }

  move(by, n) {
    if (!n) return;
    this.at = Math.max(0, Math.min(n - 1, this.at + by));
    this.confirmDelete = null;
    this.scroll.scroll_to_item(this.at);
  }

  badge(t, agent) {
    const color = AGENT_COLORS[agent] ?? t.working;
    return div().w(48).flex_none().h(16).rounded(4).flex().items_center().justify_center()
      .bg(color + "22").text_color(color).text_size(9.5).font_bold().child(agent.toUpperCase());
  }

  // Snippet with the hit highlighted; keeps the hit on screen by trimming the lead-in.
  snippet(t, text) {
    const i = text.indexOf(HIT_START);
    const j = text.indexOf(HIT_END);
    if (i < 0 || j < i) return div().flex_1().min_w(0).truncate().text_color(t.muted).child(text);
    let pre = text.slice(0, i);
    if (pre.length > 48) pre = "…" + pre.slice(-47);
    return h_flex().flex_1().min_w(0).overflow_hidden().text_color(t.muted)
      .child(div().flex_none().child(pre))
      .child(div().flex_none().px(1).rounded(3).bg(t.accent + "33").text_color(t.foreground).font_semibold().child(text.slice(i + 1, j)))
      .child(div().flex_1().min_w(0).truncate().child(text.slice(j + 1)));
  }

  row(t, s, i) {
    const sel = i === this.at;
    const title = s.title || s.preview || s.id;
    const second = this.results && s.snippet ? s.snippet : s.title ? s.preview : "";
    return v_flex().h(ROW_H).px(10).py(7).gap(4).rounded(8).cursor_pointer()
      .when(sel, (el) => el.bg(t.selected))
      .when(!sel, (el) => el.hover((el) => el.bg(t.hover)))
      .child(h_flex().items_center().gap(8)
        .child(this.badge(t, s.agent))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(title))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(s.folder || ""))
        .child(div().flex_none().w(30).text_size(10.5).text_color(t.dim).child(age(s.mtime))))
      .child(h_flex().pl(56).text_size(11).min_w(0).child(this.snippet(t, second || "")));
  }

  button(t, id, label, onClick, opts = {}) {
    return div().id(id).px(10).h(26).rounded(6).flex().items_center().cursor_pointer().text_size(11)
      .when(Boolean(opts.primary), (el) => el.bg(t.accent).text_color(t.accent_foreground || t.background).font_semibold())
      .when(Boolean(opts.danger), (el) => el.bg(t.blocked).text_color(t.background).font_semibold())
      .when(!opts.primary && !opts.danger, (el) => el.border_1().border_color(t.border).text_color(t.dim).hover((el) => el.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  render(cx) {
    const t = theme();
    const list = this.visible();
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    const sel = list[this.at];
    const scope = scopeOf();
    const status = this.error
      ?? (this.indexing ? `Indexing… ${this.indexing} left` : this.searching ? "Searching…" : `${list.length}${this.results ? " matches" : " sessions"}`);

    return v_flex()
      .id("agent-history")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.dismiss();
        if (k === "down") this.move(1, list.length);
        else if (k === "up") this.move(-1, list.length);
        else if (k === "pagedown") this.move(8, list.length);
        else if (k === "pageup") this.move(-8, list.length);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(6)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Agent History"))
        .child(div().flex_1())
        .children(SCOPES.map((s) => div().id(`scope-${s.id}`).px(8).h(22).rounded(6).flex().items_center().cursor_pointer().text_size(11)
          .when(scope.id === s.id, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(scope.id !== s.id, (el) => el.text_color(t.dim).hover((el) => el.bg(t.hover)))
          .on_click((_e, cx) => { setShared("agent-history.scope", s.id); this.at = 0; cx.notify(); })
          .child(s.label))))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        .child(div().flex_none().text_size(10.5).text_color(this.error ? t.blocked : t.dim).child(status)))
      .child(v_flex().h(ROW_H * 11).flex_none().relative()
        .when(list.length === 0, (el) => el.child(div().p(10).text_size(12).text_color(t.dim)
          .child(this.query ? "No session mentions that." : scope.id === "folder" ? "No sessions in this space's folders." : "No sessions yet.")))
        .when(list.length > 0, (el) => el
          .child(v_virtual_list("sh-rows", list.length, ROW_H, (i) => list[i].path, (range) =>
            list.slice(range.start, range.end).map((s, k) => this.row(t, s, range.start + k)))
            .track_scroll(this.scroll)
            .size_full()
            .on_item_click((key, cx) => {
              const i = list.findIndex((s) => s.path === key);
              if (i === this.at) return this.resume(list[i]);
              this.at = i;
              this.confirmDelete = null;
              cx.notify();
            }))
          .child(Scrollbar.vertical("sh-rows").absolute().inset_0())))
      .when(Boolean(sel), (el) => el.child(h_flex().flex_none().gap(6).items_center().pt(2)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(sel.cwd || "(no folder recorded)"))
        .child(this.button(t, "sh-resume", "Resume ⏎", () => this.resume(sel), { primary: true }))
        .child(this.button(t, "sh-copy", "Copy cmd", () => this.copyCmd(sel)))
        .child(this.button(t, "sh-reveal", isMac() ? "Finder" : "Folder", () => this.reveal(sel)))
        .when(this.confirmDelete === sel.path, (el) => el
          .child(this.button(t, "sh-del-yes", "Delete?", (cx) => this.delete(sel, cx), { danger: true }))
          .child(this.button(t, "sh-del-no", "Keep", (cx) => { this.confirmDelete = null; cx.notify(); })))
        .when(this.confirmDelete !== sel.path, (el) => el
          .child(this.button(t, "sh-del", "Delete", (cx) => this.delete(sel, cx))))));
  }
}
