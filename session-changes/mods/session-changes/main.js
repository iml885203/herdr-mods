import { View } from "gpui-kit";
import { Panel } from "./panel.js";

export default class SessionChanges extends View {
  init(_props, cx) {
    this.panel = new Panel();
    this.panel.init(cx);
  }

  render(cx) {
    return this.panel.render(cx);
  }

  async close(cx) {
    await this.panel.close(cx);
  }
}
