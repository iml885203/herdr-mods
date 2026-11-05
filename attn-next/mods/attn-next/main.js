// cmd-shift-j: focus the next agent that needs me (blocked first, then done).
import { View, div } from "gpui-kit";
import { run, props, closeOverlay, agents, notify } from "herdr";
import { pickNext } from "./pick.js";

export default class AttnNext extends View {
  init() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    const next = pickNext(agents());
    if (next) run("agent.focus", { terminal: next.address });
    else notify({ title: "No agent needs you", timeout: 2000 });
  }

  render() {
    return div();
  }
}
