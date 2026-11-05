import { v_flex, h_flex, VirtualListScrollHandle } from "gpui-base";
import { theme, closeOverlay, props } from "herdr";
import { api, io } from "./io.js";
import { Store } from "./store.js";
import { claudeSessions, initialSession } from "./session.js";
import { loadLanguage } from "./settings.js";
import { diffRows, diffWidth } from "./diff.js";
import { POLL_STEPS, createPacer } from "./poll.js";
import { intentOf } from "./keymap.js";
import { diffStamp, emptyMessage } from "./model.js";
import { flattenRows, moveSelection, rowKey } from "./tree.js";
import { createVscode } from "./vscode.js";
import { createDock } from "./dock.js";
import { diffPane, footer, header, leftPane, overviewBlock, rowHeights } from "./views.js";

const TREE_GUTTER = 12;
const NO_DIFF = { rows: [], width: 300 };

export class Panel {
  init(cx) {
    this.store = new Store(io);
    this.code = createVscode(io.exec, this.store.git);
    this.dock = createDock(api);
    this.handle = cx.focus_handle();
    this.treeScroll = VirtualListScrollHandle.new();
    this.size = null;
    this.rows = [];
    this.rowAt = new Map();
    this.openedFile = null;
    this.pace = createPacer();
    this.heights = [];
    this.summaries = {};
    this.overview = null;
    this.expanded = new Set();
    this.selected = null;
    this.open = null;
    this.diff = NO_DIFF;
    this.diffToken = 0;
    this.picking = false;
    this.choosingLanguage = false;
    this.sessions = [];
    this.message = "";
    this.hasCode = false;
    this.focused = false;
    this.starting = true;
    cx.spawn(async (cx) => { this.hasCode = await this.code.hasCode(); cx.notify(); });
    cx.spawn((cx) => this.begin(cx));
    cx.spawn((cx) => this.changeLoop(cx));
    this.closed = false;
    // The timer fires at the fastest pace; a firing that is not due yet does nothing, so the pace can slow down without making a timer from a callback.
    this.tasks = [cx.timer.every(POLL_STEPS[0], (cx) => { if (this.pace.due(Date.now())) this.tick(cx); })];
  }

  async begin(cx) {
    this.store.language = await loadLanguage(io).catch(() => this.store.language);
    const session = await initialSession().catch(() => null);
    if (this.closed) return;
    this.starting = false;
    if (session && !this.store.session) this.startSession(session, cx);
    cx.notify();
  }

  async changeLoop(cx) {
    let seen = this.store.rev;
    while (await this.store.changed(seen)) {
      seen = this.store.rev;
      this.reflow();
      cx.notify();
    }
  }

  startSession(session, cx) {
    this.store.start(session);
    this.dropDiff();
    this.expanded = new Set();
    this.selected = null;
    this.message = "";
    this.reflow();
    this.tick(cx, true);
  }

  openStamp() {
    return diffStamp(this.open, this.store.stateOf(this.open?.root), this.openedFile);
  }

  tick(cx, force = false) {
    if (this.closed) return;
    if (force) this.pace.reset();
    this.pace.started(Date.now());
    const epoch = this.store.epoch;
    cx.spawn(async (cx) => {
      let run = force;
      for (;;) {
        const before = this.openStamp();
        const result = await this.store.tick(run);
        run = false;
        if (!result || epoch !== this.store.epoch) return;
        this.pace.settle(result.grew);
        if (result.changed) {
          this.reflow();
          if (this.open && before !== this.openStamp()) this.loadDiff(cx);
          cx.notify();
        }
        if (!result.pending) return;
      }
    });
  }

  reflow() {
    this.summaries = this.store.views.length ? this.store.summaryRows() : {};
    this.rows = flattenRows({ repos: this.store.views, expanded: this.expanded, summaries: this.summaries, relations: this.store.relations });
    this.heights = rowHeights(this.rows);
    this.overview = this.store.overviewState();
    this.rowAt = new Map(this.rows.flatMap((r, i) => (r.selectable ? [[rowKey(r), i]] : [])));
    if (!this.rowAt.has(this.selected)) this.selected = moveSelection(this.rows, null, 1);
    this.resolveOpen();
    if (this.open && !this.openedFile) this.dropDiff();
  }

  resolveOpen() {
    const { open } = this;
    this.openedFile = open ? this.store.stateOf(open.root)?.repo?.files.find((f) => f.path === open.path) ?? null : null;
  }

  emptyText() {
    const { store } = this;
    return emptyMessage({ starting: this.starting, session: store.session, error: store.error, loaded: store.loaded, pending: store.pending });
  }

  openFile() {
    return this.openedFile;
  }

  refresh(cx) {
    this.message = "";
    this.tick(cx, true);
    cx.notify();
  }

  togglePicker(cx) {
    this.picking = !this.picking;
    this.choosingLanguage = false;
    if (this.picking) cx.spawn(async (cx) => { this.sessions = await claudeSessions(); cx.notify(); });
    cx.notify();
  }

  toggleLanguages(cx) {
    this.choosingLanguage = !this.choosingLanguage;
    this.picking = false;
    cx.notify();
  }

  pickLanguage(id, cx) {
    this.choosingLanguage = false;
    this.store.setLanguage(id);
    cx.notify();
  }

  pickSession(session, cx) {
    this.picking = false;
    this.startSession(session, cx);
    cx.notify();
  }

  select(key) {
    this.selected = key;
    const at = this.rowAt.get(key);
    if (at !== undefined) this.treeScroll.scroll_to_item(at, "top");
  }

  toggleRepo(root) {
    if (this.expanded.has(root)) this.expanded.delete(root);
    else this.expanded.add(root);
    this.expanded = new Set(this.expanded);
    this.reflow();
  }

  clickKey(key, cx) {
    const row = this.rowOf(key);
    if (row?.kind === "repo") this.clickRepo(row.root, cx);
    else if (row) this.clickFile(row, cx);
  }

  clickRepo(root, cx) {
    this.select(`repo:${root}`);
    this.toggleRepo(root);
    this.handle.focus();
    cx.notify();
  }

  clickFile(row, cx) {
    this.select(rowKey(row));
    this.showDiff(row.root, row.file.path, cx);
    this.handle.focus();
    cx.notify();
  }

  showDiff(root, path, cx) {
    this.open = { root, path };
    this.resolveOpen();
    this.diff = NO_DIFF;
    this.loadDiff(cx);
  }

  loadDiff(cx) {
    const file = this.openFile();
    if (!file) { this.dropDiff(); return; }
    const token = ++this.diffToken;
    const { root } = this.open;
    const { baseline, stats } = this.store.stateOf(root);
    const size = stats?.get(file.path)?.size ?? null;
    cx.spawn(async (cx) => {
      let lines;
      try { lines = await this.store.git.diffLines(root, baseline, file, size); } catch { lines = ["Cannot preview this diff (too large or unreadable)"]; }
      if (token !== this.diffToken) return;
      this.diff = { rows: diffRows(lines), width: diffWidth(lines) };
      cx.notify();
    });
  }

  dropDiff() {
    this.open = null;
    this.openedFile = null;
    this.diff = NO_DIFF;
    this.diffToken++;
  }

  closeDiff(cx) {
    this.dropDiff();
    this.handle.focus();
    cx.notify();
  }

  summarize(root, cx) {
    this.store.regenerate(root);
    cx.notify();
  }

  rowOf(key) {
    return this.rows[this.rowAt.get(key)] ?? null;
  }

  selectedRow() {
    return this.rowOf(this.selected);
  }

  selectedFile() {
    const row = this.selectedRow();
    return row?.kind === "file" ? row : null;
  }

  codeTarget() {
    return this.selectedFile() ?? (this.open && this.openedFile ? { root: this.open.root, file: this.openedFile } : null);
  }

  runCode(action, cx) {
    cx.spawn(async (cx) => { this.message = await action(); cx.notify(); });
  }

  openInCode(cx) {
    const target = this.codeTarget();
    if (target) this.runCode(() => this.code.openFile(target.root, target.file.path), cx);
  }

  diffInCode(cx) {
    const target = this.codeTarget();
    if (target) this.runCode(() => this.code.openDiff(target.root, this.store.stateOf(target.root).baseline, target.file), cx);
  }

  activate(cx) {
    const row = this.selectedRow();
    if (row?.kind === "repo") { this.toggleRepo(row.root); this.select(rowKey(row)); }
    else if (row) this.showDiff(row.root, row.file.path, cx);
  }

  togglePlace(cx) {
    this.place();
    cx.notify();
  }

  openTab(cx) {
    this.message = this.dock.openAsTab("session-changes", "Session changes", this.store.session);
    cx.notify();
  }

  hide() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  place() {
    const { session } = this.store;
    this.message = props()?.overlay ? this.dock.dockHere("session-changes", session) : this.dock.floatAgain("session-changes", session);
  }

  onKey(e, cx) {
    const intent = intentOf({ key: e.key, modifiers: e.modifiers, picking: this.picking || this.choosingLanguage, hasDiff: Boolean(this.open), overlay: Boolean(props()?.overlay) });
    if (!intent || !this.perform(intent, cx)) return;
    cx.stop_propagation();
    cx.notify();
  }

  perform(intent, cx) {
    const row = this.selectedRow();
    switch (intent) {
      case "place": this.place(); break;
      case "closePicker": this.picking = false; this.choosingLanguage = false; break;
      case "closeDiff": this.closeDiff(cx); break;
      case "closeWindow": closeOverlay(props().overlay); break;
      case "next": this.select(moveSelection(this.rows, this.selected, 1)); break;
      case "previous": this.select(moveSelection(this.rows, this.selected, -1)); break;
      case "activate": this.activate(cx); break;
      case "expand": if (row?.kind === "repo" && !row.open) this.toggleRepo(row.root); break;
      case "collapse": if (row?.kind === "repo" && row.open) this.toggleRepo(row.root); break;
      case "refresh": this.refresh(cx); break;
      case "picker": this.togglePicker(cx); break;
      case "summarize": if (row) this.summarize(row.root, cx); break;
      case "open": this.openInCode(cx); break;
      case "diff": this.diffInCode(cx); break;
      default: return false;
    }
    return true;
  }

  render() {
    const t = theme();
    if (!this.focused && props()?.overlay) { this.focused = true; this.handle.focus(); }
    const width = this.size?.width ?? 800;
    const showDiff = Boolean(this.open && this.openedFile && !this.picking && !this.choosingLanguage);
    const left = showDiff ? Math.min(560, Math.max(340, Math.round(width * 0.4))) : null;
    this.treeWidth = (left ?? width) - TREE_GUTTER;
    return v_flex().id("session-changes").track_focus(this.handle).size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(12.5)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(header(this, t))
      .children(overviewBlock(this, t))
      .child(h_flex().w_full().flex_1().min_h(0).items_stretch()
        .child(v_flex().min_w(0).min_h(0).when(left, (e) => e.flex_none().w(left)).when(!left, (e) => e.flex_1()).child(leftPane(this, t)))
        .when(showDiff, (e) => e.child(diffPane(this, t))))
      .children(footer(this, t));
  }

  async close() {
    this.closed = true;
    for (const task of this.tasks) task.cancel();
    this.treeScroll?.release();
    this.handle?.release?.();
    await this.store.dispose();
  }
}
