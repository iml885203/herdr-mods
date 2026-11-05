// Agent session history (Orca-style): every Claude Code / Codex / Pi session,
// full-text search over what was said, Enter resumes it in a tab.
// Based on itisvincent/herdr-session-history (MIT); the full-text index lives in index.py.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import { spaces, panes, run, theme, shared, setShared, exec, home, appHome, props, closeOverlay, window, fonts, settings } from "herdr";

// Nerd Font glyphs, drawn apart from the label text (as in Claude goal and Claude tab name).
const ICONS = { history: "\u{f1da}" }; // nf-fa-history
const NERD_FONT = "JetBrainsMono Nerd Font";
const mono = () => (fonts().includes(NERD_FONT) ? NERD_FONT : settings().font_family ?? "JetBrains Mono");
const glyph = (color, icon) => div().flex_none().font_family(mono()).text_color(color).child(icon);

const isMac = () => window()?.platform === "macos";

const INDEX = () => `${appHome()}/mods/agent-history/index.py`;
const SCOPES = [
  { id: "all", label: "All" },
  { id: "folder", label: "This space" },
];
const ROW_H = 50;
const SEARCH_LIMIT = 200;
// Brand colors: Claude terracotta, Codex blue.
const AGENT_COLORS = { claude: "#D97757", codex: "#6E8BFF" };

const scopeOf = () => SCOPES.find((s) => s.id === shared("agent-history.scope")) ?? SCOPES[0];
const norm = (p) => String(p || "").replace(/\/+$/, "");
// One folder predicate for the scope filter, and for picking a space on Resume.
const under = (cwd, folder) => cwd === folder || cwd.startsWith(folder + "/");
const folderOf = (cwd) => norm(cwd).split("/").pop() || cwd || "";
// The command that resumes a session; index.py sends agent/id/path only.
const argvFor = (s) =>
  s.agent === "claude" ? ["claude", "--resume", s.id]
  : s.agent === "codex" ? ["codex", "resume", s.id]
  : ["pi", "--session", s.path];
// Rows from index.py plus what the UI derives from them.
const prepare = (rows) => (rows || []).map((s) => ({ ...s, folder: folderOf(s.cwd), argv: argvFor(s) }));
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The folders a space works in: its own folder plus its live terminals' cwds.
function spaceFolders(sp, livePanes) {
  const tabs = new Set((sp.tabs || []).map((t) => t.id));
  const live = livePanes.filter((p) => p.terminal && tabs.has(p.tab) && p.cwd).map((p) => norm(p.cwd));
  // A space recorded at the home folder would claim every session under it; its terminals say more.
  const recorded = norm(sp.folder);
  const out = recorded && !(recorded === norm(home()) && live.length) ? [recorded, ...live] : live;
  return [...new Set(out.filter(Boolean))];
}
const activeFolders = () => {
  const active = spaces().find((sp) => sp.active);
  return active ? spaceFolders(active, panes()) : [];
};
const folderScope = () => scopeOf().id === "folder";
const emptyScope = () => folderScope() && activeFolders().length === 0;
// --cwd args for index.py; nothing for "All".
const scopeArgs = () => (folderScope() ? activeFolders().flatMap((f) => ["--cwd", f]) : []);
// Identifies what recent/results were loaded for, so a change reloads them.
const scopeKey = () => (folderScope() ? "folder\n" + [...activeFolders()].sort().join("\n") : "all");

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
    this.input.on("submit", () => this.resume(this.shown[this.at]));
    this.input.focus();
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.query = "";
    this.recent = [];
    this.results = null; // null = no query, show recent
    this.at = 0;
    this.selPath = null; // the row the user picked (arrows/click); follows it across re-sorts
    this.key = scopeKey(); // the scope (and folders) that recent/results were loaded for
    this.error = null;
    this.indexing = null;
    this.capped = false;
    this.searching = false;
    this.pendingSearch = false; // a debounced search is waiting: update() must not race it
    this.wantMore = false; // the first index run catches up in slices, one per tick
    this.lastKick = 0;
    this.shown = [];
    this.token = 0;
    this.confirmDelete = null;
    this.closed = false;
    this.busy = false;
    this.debounce = null;
    // Timers only from init/handlers (QuickJS), kept so close() can stop them.
    this.tasks = [
      cx.timer.after(600, () => this.input.focus()),
      // One timer drives indexing: 15 s between slices when idle, every second while catching up.
      cx.timer.every(1000, (cx) => {
        if (scopeKey() !== this.key) this.rescope(cx); // the space's folders changed under us
        if (Date.now() - this.lastKick >= 15000 || this.wantMore) this.kick(cx);
      }),
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

  // One index slice (8 s budget) per call; the init timer calls again for the next one.
  // update() returns the recent list when anything changed, so no second python run is needed.
  kick(cx) {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.lastKick = Date.now();
    cx.spawn(async (cx) => {
      try {
        await this.update(cx);
      } finally {
        this.busy = false;
      }
    });
  }

  async update(cx) {
    try {
      const key = this.key;
      const r = await index(["update", "--budget", "8", "--limit", "300", ...scopeArgs()]);
      if (this.closed) return;
      this.error = null;
      if (r.busy) return cx.notify(); // another window holds the lock: keep what we knew
      this.indexing = r.pending > 0 ? r.pending : null;
      this.wantMore = r.pending > 0;
      if (r.recent && key === this.key && !emptyScope()) {
        this.recent = prepare(r.recent);
        // Rerun the query only on a change, and not while a debounced search is about to.
        if (this.query && !this.pendingSearch) await this.search(cx, ++this.token);
      }
    } catch (e) {
      this.wantMore = false; // back off to the 15 s cadence instead of respawning python
      this.error = String(e.message || e);
    }
    cx.notify();
  }

  // First paint; later update() sends the list only when something changed.
  loadRecent(cx) {
    const key = this.key;
    if (emptyScope()) { this.recent = []; return; }
    cx.spawn(async (cx) => {
      try {
        const r = await index(["search", "", "--limit", "300", ...scopeArgs()]);
        if (!this.closed && key === this.key && !this.recent.length) this.recent = prepare(r.results);
        this.error = null;
      } catch (e) {
        this.error = String(e.message || e);
      }
      if (!this.closed) cx.notify();
    });
  }

  // The scope or the space's folders changed: what we hold is for another scope, load again.
  rescope(cx) {
    this.key = scopeKey();
    this.token++;
    this.recent = [];
    this.results = this.query ? [] : null;
    this.capped = false;
    this.at = 0;
    this.selPath = null;
    this.confirmDelete = null;
    this.debounce?.cancel(); // a waiting typed search is replaced by this one (the token moved on)
    this.pendingSearch = false;
    this.loadRecent(cx);
    if (this.query) cx.spawn((cx) => this.search(cx, this.token));
    cx.notify();
  }

  queryChanged(cx) {
    this.query = this.input.value().trim();
    this.at = 0;
    this.selPath = null;
    this.confirmDelete = null;
    const token = ++this.token;
    this.debounce?.cancel();
    if (!this.query) {
      this.results = null;
      this.capped = false;
      this.searching = false;
      this.pendingSearch = false;
      cx.notify();
      return;
    }
    this.pendingSearch = true;
    this.debounce = cx.timer.after(180, (cx) => {
      this.pendingSearch = false;
      if (token === this.token) cx.spawn((cx) => this.search(cx, token));
    });
  }

  async search(cx, token) {
    this.searching = true;
    cx.notify();
    try {
      const r = emptyScope() ? { results: [] } : await index(["search", this.query, "--limit", String(SEARCH_LIMIT), ...scopeArgs()]);
      if (token !== this.token) return;
      this.results = prepare(r.results);
      this.capped = Boolean(r.capped);
      this.error = null;
    } catch (e) {
      if (token !== this.token) return;
      this.error = String(e.message || e);
    } finally {
      if (token === this.token) this.searching = false; // a stale search leaves the newer one's flag alone
      if (!this.closed) cx.notify();
    }
  }

  // Already scoped by index.py; the list is the whole truth.
  visible() {
    return this.results ?? this.recent;
  }

  resume(s) {
    if (!s?.argv?.length) return;
    const folder = s.cwd || home();
    const name = s.title || s.folder || s.agent;
    // Several spaces can share a folder: the one you are in wins, else the first that matches.
    // A space is where its terminals are now, not only the folder it was made in; the same
    // predicate as the "This space" filter (the session's folder is at or under one of them).
    const target = norm(folder);
    const livePanes = panes();
    const matches = spaces().filter((sp) => !sp.machine && spaceFolders(sp, livePanes).some((f) => under(target, f)));
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
    this.selPath = this.shown[this.at]?.path ?? null;
    this.confirmDelete = null;
    this.scroll.scroll_to_item(this.at);
  }

  badge(t, agent) {
    const color = AGENT_COLORS[agent] ?? t.working;
    return div().w(48).flex_none().h(16).rounded(4).flex().items_center().justify_center()
      .bg(color + "22").text_color(color).text_size(9.5).font_bold().child(agent.toUpperCase());
  }

  // Snippet {pre, hit, post} from index.py; the lead-in is already trimmed so the hit stays on screen.
  snippet(t, snip) {
    if (!snip.hit) return div().flex_1().min_w(0).truncate().text_color(t.muted).child(snip.pre);
    return h_flex().flex_1().min_w(0).overflow_hidden().text_color(t.muted)
      .child(div().flex_none().child(snip.pre))
      .child(div().flex_none().px(1).rounded(3).bg(t.accent + "33").text_color(t.foreground).font_semibold().child(snip.hit))
      .child(div().flex_1().min_w(0).truncate().child(snip.post));
  }

  row(t, s, i) {
    const sel = i === this.at;
    const title = s.title || s.preview || s.id;
    const second = this.results && s.snippet ? s.snippet : { pre: s.title ? s.preview : "", hit: "", post: "" };
    return v_flex().h(ROW_H).px(10).py(7).gap(4).rounded(8).cursor_pointer()
      .when(sel, (el) => el.bg(t.selected))
      .when(!sel, (el) => el.hover((el) => el.bg(t.hover)))
      .child(h_flex().items_center().gap(8)
        .child(this.badge(t, s.agent))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(title))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(s.folder || ""))
        .child(div().flex_none().w(30).text_size(10.5).text_color(t.dim).child(age(s.mtime))))
      .child(h_flex().pl(56).text_size(11).min_w(0).child(this.snippet(t, second)));
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
    const list = (this.shown = this.visible()); // once per render; the submit handler reads this.shown
    // A row the user picked stays selected when a background update re-sorts the list.
    const kept = this.selPath ? list.findIndex((s) => s.path === this.selPath) : -1;
    this.at = kept >= 0 ? kept : Math.min(this.at, Math.max(0, list.length - 1));
    if (this.selPath && kept < 0) this.selPath = list[this.at]?.path ?? null; // it vanished: the clamped row
    const sel = list[this.at];
    const scope = scopeOf();
    const status = this.error
      ?? (this.indexing ? `Indexing… ${this.indexing} left` : this.searching ? "Searching…" : `${list.length}${this.results ? (this.capped ? "+ matches" : " matches") : " sessions"}`);

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
        const k = e.keystroke;
        if (k === "escape") return this.dismiss();
        if (k === "down") this.move(1, list.length);
        else if (k === "up") this.move(-1, list.length);
        else if (k === "pagedown") this.move(8, list.length);
        else if (k === "pageup") this.move(-8, list.length);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(glyph(t.accent, ICONS.history).text_size(15))
        .child(div().flex_none().text_size(15).font_semibold().text_color(t.foreground).child("Agent History"))
        .child(div().flex_1())
        .children(SCOPES.map((s) => div().id(`scope-${s.id}`).px(8).h(22).rounded(6).flex().items_center().cursor_pointer().text_size(11)
          .when(scope.id === s.id, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(scope.id !== s.id, (el) => el.text_color(t.dim).hover((el) => el.bg(t.hover)))
          .on_click((_e, cx) => { setShared("agent-history.scope", s.id); this.rescope(cx); })
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
              if (i < 0) return;
              if (i === this.at) return this.resume(list[i]);
              this.at = i;
              this.selPath = key;
              this.confirmDelete = null;
              cx.notify();
            }))
          .child(Scrollbar.vertical("sh-rows").absolute().inset_0())))
      .when(Boolean(sel), (el) => el.child(h_flex().flex_none().gap(6).items_center().pt(2)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(sel.cwd || "(no folder recorded)"))
        .child(this.button(t, "sh-resume", "Resume ↵", () => this.resume(sel), { primary: true }))
        .child(this.button(t, "sh-copy", "Copy cmd", () => this.copyCmd(sel)))
        .child(this.button(t, "sh-reveal", isMac() ? "Finder" : "Folder", () => this.reveal(sel)))
        .when(this.confirmDelete === sel.path, (el) => el
          .child(this.button(t, "sh-del-yes", "Delete?", (cx) => this.delete(sel, cx), { danger: true }))
          .child(this.button(t, "sh-del-no", "Keep", (cx) => { this.confirmDelete = null; cx.notify(); })))
        .when(this.confirmDelete !== sel.path, (el) => el
          .child(this.button(t, "sh-del", "Delete", (cx) => this.delete(sel, cx))))));
  }
}
