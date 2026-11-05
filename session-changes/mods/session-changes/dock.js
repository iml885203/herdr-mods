export const FLOAT = { kind: "window", key: "session-changes-panel", width: 1000, height: 680, at: { x: 200, y: 80 } };

const propsOf = (session) => (session ? { session: session.sessionId, name: session.name ?? null } : undefined);

export function createDock(api) {
  const modPane = (tab, mod) => api.panes().find((one) => one.tab === tab && one.mod === mod) ?? null;

  function hostPane() {
    const f = api.focused();
    const all = api.panes();
    return all.find((one) => one.pane === f?.pane) ?? all.find((one) => one.tab === f?.tab && one.terminal) ?? null;
  }

  function dockHere(mod, session) {
    const overlay = api.props()?.overlay;
    const host = hostPane();
    if (!overlay || !host) return "No pane to dock beside.";
    const existing = modPane(host.tab, mod);
    if (existing) api.run("pane.close", { pane: existing.pane });
    api.run("pane.split", { pane: host.pane, direction: "right", mod, props: propsOf(session) });
    api.closeOverlay(overlay);
    return "";
  }

  function floatAgain(mod, session) {
    if (api.props()?.overlay) return "";
    const own = api.panes().find((one) => one.mod === mod && one.focused);
    api.openOverlay({ ...FLOAT, mod, props: propsOf(session) });
    if (own) api.run("pane.close", { pane: own.pane });
    return "";
  }

  function openAsTab(mod, name, session) {
    const overlay = api.props()?.overlay;
    if (!overlay) return "No window to move into a tab.";
    const space = api.focused()?.space;
    if (!space) return "No space to open a tab in.";
    api.run("tab.new", { space, mod, name, props: propsOf(session) });
    api.closeOverlay(overlay);
    return "";
  }

  return { dockHere, floatAgain, openAsTab };
}
