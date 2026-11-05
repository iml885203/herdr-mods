import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { fonts, props, settings } from "herdr";

const NERD_FONT = "JetBrainsMono Nerd Font";

export const ICONS = {
  app: "\u{f1d3}", refresh: "\u{f021}", regenerate: "\u{f0d0}", sessions: "\u{f086}",
  close: "\u{f00d}", float: "\u{f2d0}", split: "\u{eb56}", tab: "\u{f2d2}",
  branch: "\u{f126}", caretRight: "\u{f0da}", caretDown: "\u{f0d7}",
  db: "\u{f1c0}", service: "\u{f013}", sdk: "\u{f1b3}", api: "\u{f1e0}",
  ui: "\u{f108}", tests: "\u{f0c3}", other: "\u{f15b}",
  dirty: "\u{f040}", unpushed: "\u{f093}", pushed: "\u{f00c}",
  added: "\u{f067}", modified: "\u{f040}", deleted: "\u{f068}", conflict: "\u{f071}",
  code: "\u{f121}", diff: "\u{f0ec}", sparkle: "\u{f0d0}",
  language: "\u{f0ac}", tag: "\u{f02b}", submodule: "\u{f1b2}", link: "\u{f08e}", warning: "\u{f071}", files: "\u{f0c5}",
};

let nerd = null;

export const hasNerdFont = () => (nerd ??= fonts().includes(NERD_FONT));

export function tint(color, alpha) {
  return `${String(color).slice(0, 7)}${alpha}`;
}

export function mono() {
  return hasNerdFont() ? NERD_FONT : settings().font_family ?? "JetBrains Mono";
}

export function glyph(color, one) {
  return div().flex_none().font_family(mono()).text_color(color).child(one);
}

export function iconLabel(color, one, text) {
  return h_flex().gap(5).items_center().child(glyph(color, one)).child(div().child(text));
}

export function iconButton(t, id, one, onClick, { size = 24, tooltip } = {}) {
  return div().id(id).flex_none().w(size).h(size).flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(onClick)
    .child(glyph(t.muted, one));
}

function buttonLook(t, options) {
  if (options.disabled) return { bg: t.surface, border: t.border, text: t.dim, hover: t.surface };
  if (options.active) return { bg: t.selected, border: t.accent, text: t.foreground, hover: t.selected };
  return { bg: t.raised, border: t.border, text: t.foreground, hover: t.hover };
}

export function button(t, id, label, onClick, options = {}) {
  const look = buttonLook(t, options);
  return div().id(id).flex_none().h(24).px(9).flex().items_center().rounded(6)
    .border_1().border_color(look.border).bg(look.bg).text_size(11.5).text_color(look.text)
    .when(!options.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(look.hover)))
    .when(Boolean(options.tooltip), (el) => el.tooltip(options.tooltip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      if (!options.disabled) onClick(e, cx);
    })
    .child(h_flex().gap(5).items_center()
      .child(typeof label === "string" ? div().child(label) : label)
      .when(Boolean(options.hotkey), (el) => el.child(div().px(3).rounded(3).bg(t.background).text_size(10).text_color(t.dim).child(options.hotkey ?? ""))));
}

export function windowButtons(t, app) {
  if (!props()?.overlay) {
    return button(t, "as-float", iconLabel(t.foreground, ICONS.float, "Float"), (_e, cx) => app.togglePlace(cx), { hotkey: "\u{2318}\u{21b5}", tooltip: "Back to a floating window" });
  }
  return h_flex().flex_none().gap(4).items_center()
    .child(button(t, "as-split", iconLabel(t.foreground, ICONS.split, "Split"), (_e, cx) => app.togglePlace(cx), { tooltip: "Dock beside the focused pane (cmd-enter)" }))
    .child(button(t, "as-tab", iconLabel(t.foreground, ICONS.tab, "Tab"), (_e, cx) => app.openTab(cx), { tooltip: "Open as a tab" }))
    .child(iconButton(t, "close", ICONS.close, () => app.hide(), { tooltip: "Close (esc)" }));
}

export function chip(t, content, color, variant = "tint") {
  const el = div().flex_none().h(18).px(6).flex().items_center().rounded(5).text_size(10.5).font_semibold();
  if (variant === "outline") return el.border_1().border_color(color).text_color(color).child(content);
  return el.bg(tint(color, "24")).text_color(color).child(content);
}
