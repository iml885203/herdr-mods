// cmd-w: close the focused pane while the tab has several; close the tab when it has one.
// (cmd-shift-t is the gallery's reopen-tab mod, which reads closes from herdr-core.)
import { View, div } from "gpui-kit";
import { run, props, closeOverlay, spaces } from "herdr";

export default class SmartClose extends View {
  init() {
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    if (!tab) return;
    if (tab.panes > 1) run("pane.close");
    else run("tab.close", { id: tab.id });
  }

  render() {
    return div();
  }
}
