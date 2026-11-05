import { div } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { settings } from "herdr";
import { sessionLabel } from "./claude.js";
import { LANGUAGES } from "./languages.js";
import { isOwned } from "./model.js";
import { layerTitle, rowId, rowKey } from "./tree.js";
import { ICONS, button, chip, glyph, iconButton, iconLabel, windowButtons } from "./widgets.js";

const HEIGHTS = { layer: 28, repo: 30, headline: 22, point: 20, links: 22, folder: 22, file: 24, divider: 28, more: 22, noise: 22, truncated: 22 };
const STATE_LABEL = { dirty: "uncommitted", unpushed: "unpushed", "no-upstream": "no upstream", pushed: "pushed" };
const LAYER_ICONS = { db: ICONS.db, service: ICONS.service, sdk: ICONS.sdk, api: ICONS.api, ui: ICONS.ui, tests: ICONS.tests, other: ICONS.other };
const STATE_ICONS = { dirty: ICONS.dirty, unpushed: ICONS.unpushed, "no-upstream": ICONS.unpushed, pushed: ICONS.pushed };
const STATUS_ICONS = { A: ICONS.added, M: ICONS.modified, D: ICONS.deleted, U: ICONS.conflict };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const KIND_ICON = { jira: ICONS.tag, submodule: ICONS.submodule, ident: ICONS.link };
const DIFF_ROW = 20;

export const rowHeights = (rows) => rows.map((row) => HEIGHTS[row.kind]);

const stateColor = (t, state) => ({ dirty: t.blocked, unpushed: t.ansi6, "no-upstream": t.ansi6, pushed: t.ansi2 })[state];
const statusColor = (t, status) => (status === "A" ? t.ansi2 : status === "D" || status === "U" ? t.ansi1 : t.blocked);

const plus = (t, n) => div().text_size(11).text_color(t.ansi2).child(`+${n}`);
const minus = (t, n) => div().text_size(11).text_color(t.ansi1).child(`−${n}`);
const indent = (px) => div().w(px).flex_none();

const spinner = (color) => div().flex_none().w(12).text_color(color).frames(SPINNER, 90);

function repoRow(row, app, t) {
  const repo = row.repo;
  const working = app.store.isSummarizing(repo.root);
  const color = stateColor(t, repo.state);
  return h_flex().h(HEIGHTS.repo).w(app.treeWidth).px(10).gap(8).items_center().cursor_pointer()
    .when(app.selected === rowKey(row), (e) => e.bg(t.selected))
    .child(glyph(t.dim, row.open ? ICONS.caretDown : ICONS.caretRight))
    .child(glyph(t.accent, LAYER_ICONS[repo.layer] ?? ICONS.other))
    .child(div().font_semibold().flex_none().child(repo.label))
    .child(h_flex().min_w(0).gap(4).items_center().child(glyph(t.dim, ICONS.branch)).child(div().min_w(0).truncate().text_color(t.dim).text_size(11).child(repo.branch)))
    .child(chip(t, iconLabel(color, STATE_ICONS[repo.state], STATE_LABEL[repo.state]), color))
    .child(div().flex_1())
    .child(h_flex().flex_none().gap(4).items_center().child(glyph(t.dim, ICONS.files)).child(div().text_size(11).text_color(t.dim).child(String(repo.owned))))
    .when(repo.added > 0, (e) => e.child(plus(t, repo.added)))
    .when(repo.deleted > 0, (e) => e.child(minus(t, repo.deleted)))
    .when(working, (e) => e.child(spinner(t.accent)));
}

function fileRow(row, app, t) {
  const file = row.file;
  const other = !isOwned(file);
  return h_flex().h(HEIGHTS.file).w(app.treeWidth).pl(34).pr(10).gap(8).items_center().cursor_pointer()
    .when(other, (e) => e.opacity(0.55))
    .when(app.selected === rowKey(row), (e) => e.bg(t.selected))
    .child(glyph(statusColor(t, file.status), STATUS_ICONS[file.status] ?? ICONS.modified))
    .child(div().flex_1().min_w(0).truncate().child(row.name))
    .when(file.secret, (e) => e.child(chip(t, "secret", t.ansi1)))
    .when(file.added > 0, (e) => e.child(plus(t, file.added)))
    .when(file.deleted > 0, (e) => e.child(minus(t, file.deleted)));
}

function linksRow(row, t, app) {
  return h_flex().h(HEIGHTS.links).w(app.treeWidth).pl(28).pr(10).gap(12).items_center().overflow_hidden().text_size(11)
    .children(row.relations.map((rel) =>
      iconLabel(rel.kind === "jira" ? t.accent : t.muted, KIND_ICON[rel.kind], `${rel.label} → ${rel.targets.join(", ")}`).flex_none()));
}

function headline(row, app, t) {
  const color = row.failed ? t.ansi1 : row.dim ? t.dim : t.foreground;
  return h_flex().h(HEIGHTS.headline).w(app.treeWidth).pl(28).pr(10).gap(6).items_center()
    .child(row.pending ? spinner(t.accent) : glyph(row.failed ? t.ansi1 : row.dim ? t.dim : t.accent, row.failed ? ICONS.warning : ICONS.sparkle))
    .child(div().flex_1().min_w(0).truncate().text_color(color).child(row.text));
}

function note(row, t, height, left, app) {
  return h_flex().h(height).w(app.treeWidth).pl(left).pr(10).items_center().truncate().text_size(11).text_color(t.dim).child(row.text);
}

function treeRow(row, app, t) {
  switch (row.kind) {
    case "layer": return h_flex().h(HEIGHTS.layer).w(app.treeWidth).px(10).gap(6).items_end().pb(3).text_size(10).font_semibold().text_color(t.dim)
      .child(glyph(t.dim, LAYER_ICONS[row.layer] ?? ICONS.other)).child(layerTitle(row.layer).toUpperCase());
    case "repo": return repoRow(row, app, t);
    case "headline": return headline(row, app, t);
    case "point": return h_flex().h(HEIGHTS.point).w(app.treeWidth).pl(36).pr(10).items_center().truncate().text_size(11).text_color(t.dim).child(`· ${row.text}`);
    case "links": return linksRow(row, t, app);
    case "folder": return note(row, t, HEIGHTS.folder, 28, app);
    case "file": return fileRow(row, app, t);
    case "divider": return h_flex().h(HEIGHTS.divider).w(app.treeWidth).pl(28).items_end().pb(3).text_size(10).text_color(t.dim).child(row.text);
    case "more": return note({ text: `+ ${row.count} more files` }, t, HEIGHTS.more, 34, app);
    case "truncated": return note({ text: `+ ${row.count} more files not shown` }, t, HEIGHTS.truncated, 34, app);
    default: return note({ text: `+ ${row.count} lockfiles / generated (hidden)` }, t, HEIGHTS.noise, 34, app);
  }
}

function sessionRows(app, t) {
  return app.sessions.map((session) =>
    h_flex().id(`session-${session.sessionId}`).h(30).w_full().px(12).gap(10).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .when(session.sessionId === app.store.session?.sessionId, (e) => e.bg(t.selected))
      .on_click((_e, cx) => app.pickSession(session, cx))
      .child(div().font_semibold().child(sessionLabel(session)))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).text_size(11).child(session.cwd ?? "")));
}

function languageRows(app, t) {
  return LANGUAGES.map((language) =>
    h_flex().id(`language-${language.id}`).h(30).w_full().px(12).gap(10).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .when(language.id === app.store.language, (e) => e.bg(t.selected))
      .on_click((_e, cx) => app.pickLanguage(language.id, cx))
      .child(glyph(language.id === app.store.language ? t.accent : t.dim, language.id === app.store.language ? ICONS.pushed : ICONS.language))
      .child(div().font_semibold().child(language.label)));
}

export function leftPane(app, t) {
  if (app.choosingLanguage) return v_flex().flex_1().w_full().min_h(0).id("sc-languages").children(languageRows(app, t));
  if (app.picking) {
    return v_flex().flex_1().w_full().min_h(0).overflow_y_scrollbar().id("sc-sessions")
      .children(app.sessions.length ? sessionRows(app, t) : [div().p(12).text_color(t.dim).child("No Claude sessions running")]);
  }
  const rows = app.rows;
  if (!rows.length) return div().p(12).text_color(t.dim).child(app.emptyText());
  return div().flex_1().min_h(0).relative()
    .child(div().id("sc-tree-x").size_full().overflow_x_scrollbar()
      .child(div().w_full().min_w(320).h_full().child(v_virtual_list("sc-tree", rows.length, app.heights, (i) => rowId(rows[i], i),
        (range) => rows.slice(range.start, range.end).map((row) => treeRow(row, app, t))).on_item_click((key, cx) => app.clickKey(key, cx)).track_scroll(app.treeScroll).size_full())))
    .child(Scrollbar.vertical("sc-tree").viewport_from_layout().absolute().inset_0());
}

function diffLine({ kind, number, text }, t) {
  if (kind === "@") return div().w_full().px(12).h(DIFF_ROW).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
  return h_flex().w_full().h(DIFF_ROW).flex_none().gap(10)
    .when(kind === "+", (e) => e.bg(`${t.ansi2}18`)).when(kind === "-", (e) => e.bg(`${t.ansi1}18`))
    .child(div().w(36).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
    .child(div().flex_1().min_w(0).truncate().child(text));
}

export function diffPane(app, t) {
  const file = app.openFile();
  if (!file) return div();
  const parts = file.path.split("/");
  const name = parts.pop();
  return v_flex().flex_1().min_w(0).h_full().border_l(1).border_color(t.border)
    .child(h_flex().h(34).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(glyph(statusColor(t, file.status), STATUS_ICONS[file.status] ?? ICONS.modified))
      .child(h_flex().flex_1().min_w(0).child(div().min_w(0).truncate().text_color(t.dim).child(parts.length ? `${parts.join("/")}/` : "")).child(div().flex_none().font_semibold().child(name)))
      .when(!isOwned(file), (e) => e.child(chip(t, "other source", t.dim)))
      .when(app.hasCode, (e) => e
        .child(iconButton(t, "code-open", ICONS.code, (_e, cx) => app.openInCode(cx), { tooltip: "Open in VS Code (o)" }))
        .child(iconButton(t, "code-diff", ICONS.diff, (_e, cx) => app.diffInCode(cx), { tooltip: "Diff in VS Code (d)" })))
      .child(iconButton(t, "diff-close", ICONS.close, (_e, cx) => app.closeDiff(cx), { tooltip: "Close the diff (esc)" })))
    .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .child(div().id("sc-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(app.diff.width).h_full().child(v_virtual_list("sc-diff", app.diff.rows.length, DIFF_ROW, (i) => String(i),
          (range) => app.diff.rows.slice(range.start, range.end).map((row) => diffLine(row, t))).size_full())))
      .child(Scrollbar.vertical("sc-diff").viewport_from_layout().absolute().inset_0()));
}

function sessionPill(app, t) {
  return h_flex().id("session-pill").flex_none().h(24).px(9).gap(6).items_center().rounded(12).cursor_pointer().text_size(12)
    .border_1().border_color(app.picking ? t.accent : t.border).text_color(t.foreground).hover((s) => s.bg(t.hover))
    .tooltip("Pick another Claude session (p)")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => app.togglePicker(cx))
    .child(glyph(t.accent, ICONS.sessions))
    .child(div().font_semibold().child(sessionLabel(app.store.session)));
}

export function header(app, t) {
  const totals = app.store.totals;
  const row = app.selectedRow();
  return h_flex().flex_none().px(10).py(8).gap(8).items_center().bg(t.surface).border_b(1).border_color(t.border)
    .child(glyph(t.accent, ICONS.app))
    .child(div().flex_none().font_bold().text_size(13).child("Session changes"))
    .child(sessionPill(app, t))
    .child(h_flex().flex_1().min_w(0).flex_wrap().gap(6).items_center()
      .child(chip(t, `${totals.repos} repos`, t.muted))
      .child(chip(t, `${totals.files} files`, t.muted))
      .when(totals.added > 0, (e) => e.child(chip(t, `+${totals.added}`, t.ansi2)))
      .when(totals.deleted > 0, (e) => e.child(chip(t, `−${totals.deleted}`, t.ansi1)))
      .when(totals.unpushed > 0, (e) => e.child(chip(t, iconLabel(t.ansi6, ICONS.unpushed, `${totals.unpushed} unpushed`), t.ansi6))))
    .child(iconButton(t, "language", ICONS.language, (_e, cx) => app.toggleLanguages(cx), { tooltip: "Summary language" }))
    .child(button(t, "refresh", iconLabel(t.foreground, ICONS.refresh, "Refresh"), (_e, cx) => app.refresh(cx), { hotkey: "r", tooltip: "Read the session and the repos again" }))
    .child(button(t, "regenerate", iconLabel(t.foreground, ICONS.regenerate, "Regenerate"), (_e, cx) => app.summarize(row.root, cx), { hotkey: "s", disabled: !row, tooltip: "Write this repo's summary again, ignoring the cache" }))
    .child(windowButtons(t, app));
}

export function footer(app, t) {
  const [warning, ...more] = app.store.warnings();
  const problem = app.message || app.store.error || (warning && `${warning}${more.length ? ` (+${more.length} more)` : ""}`);
  const text = problem || (app.store.pending ? `Reading transcript ${Math.round(app.store.progress * 100)}%` : "");
  if (!text) return [];
  return [div().flex_none().px(14).py(5).border_t(1).border_color(t.border).text_size(11).text_color(problem ? t.ansi1 : t.dim).child(text)];
}

export function overviewBlock(app, t) {
  const overview = app.overview;
  if (!overview) return [];
  const text = overview.text ?? (overview.running ? "writing the overview…" : overview.error);
  if (!text) return [];
  const live = overview.running;
  const color = overview.text ? (overview.stale || live ? t.muted : t.foreground) : t.dim;
  return [h_flex().flex_none().px(14).py(9).gap(10).items_start().border_b(1).border_color(t.border).text_size(13)
    .child(live ? spinner(t.accent) : glyph(overview.stale || !overview.text ? t.dim : t.accent, ICONS.sparkle))
    .child(div().flex_1().min_w(0).text_color(color).child(text))];
}
