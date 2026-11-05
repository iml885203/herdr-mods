// k9s-style browser across several kube contexts, in a floating window that
// cmd-k toggles (keys.json "mod.open:kubernetes"); ⇱/◫ pin it as a tab or a split.
// Lists pods, deployments, nodes, services and ingresses from each context's
// default namespace (or all). A click shows the row in the side panel
// (overview, usage, events, YAML, and restart/scale/delete where the context
// is writable; prod is read-only). Enter or a double click opens its logs.
// Everything reads through one read-only `kubectl proxy` per context (proxy.sh).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, Editor, EditorState, h_resizable, resizable_panel, Popup } from "gpui-base";
import { loadDetail, draw, drawEvents, yamlOf } from "./detail.js";
import { exec, run, theme, settings, fonts, props, closeOverlay, spaces, panes, agents, notify } from "herdr";
import * as fs from "fs/promises";
import { DIR, ensureDir, api, table, namespacesOf, dropNamespace } from "./api.js";
import { SINCE, TAIL, LEVELS, CHAR_W, nextLevel, lineParts, newLog, restoreLines, resetLog, streamsOf, due, logQuery, ingest, visibleLines, stepMatch, errorOf,
  layout, indexAt, pick, pressPick, dragPick, releasePick, chosen, asText } from "./logs.js";

const NOTIFY_MS = 300; // longest a dirty log waits for slower streams before it redraws

// Nerd Font icons (falls back to the terminal font without the Nerd Font).
const NERD_FONT = "JetBrainsMono Nerd Font";
const ICONS = {
  k8s: "\u{f10fe}", pods: "\u{f1b2}", deploy: "\u{f1b3}", nodes: "\u{f233}", svc: "\u{f0e8}", ing: "\u{f0ac}",
  refresh: "\u{f021}", settings: "\u{f013}", follow: "\u{f04b}", pause: "\u{f04c}", ask: "\u{f0d0}",
  up: "\u{f062}", down: "\u{f063}", back: "\u{f060}", close: "\u{f00d}", ok: "\u{f00c}", fail: "\u{f00d}",
  logs: "\u{f15c}", shell: "\u{f120}", trash: "\u{f1f8}", restart: "\u{f01e}", scale: "\u{f0dc}",
  warn: "\u{f071}", lock: "\u{f023}", live: "\u{f111}", split: "\u{eb56}", tab: "\u{f2d2}",
};
const iconFont = () => (fonts().includes(NERD_FONT) ? NERD_FONT : settings().font_family ?? "JetBrains Mono");
const glyph = (color, icon) => div().flex_none().font_family(iconFont()).when(Boolean(color), (el) => el.text_color(color)).child(icon);
const isIcon = (ch) => { const c = ch.codePointAt(0); return (c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000; };
// "<icon> text" labels: the icon in the Nerd Font, the text in the UI font.
const lbl = (text) => {
  const str = String(text ?? "");
  const first = [...str][0];
  if (!first || !isIcon(first)) return str;
  const rest = str.slice(first.length).trimStart();
  return h_flex().min_w(0).gap(5).items_center().child(glyph(null, first))
    .when(rest !== "", (el) => el.child(div().min_w(0).truncate().child(rest)));
};

// Lists come from the API server's own table view (what `kubectl get` prints),
// per namespace: ~100x smaller than full objects.
const NONE = (v) => (v === undefined || v === null || v === "<none>" ? "" : String(v));
const KINDS = [
  {
    id: "pods", label: "Pods", res: "pods", logs: true, path: (ns) => `/api/v1/namespaces/${ns}/pods`,
    parse(c, ns) {
      const [r, w] = NONE(c.Ready).split("/"), st = NONE(c.Status), restarts = NONE(c.Restarts) || "0";
      const ok = (st === "Running" && r === w) || st === "Completed";
      return { ns, name: c.Name, age: NONE(c.Age), restarts: parseInt(restarts) || 0,
        tone: ok ? "ok" : /Pending|ContainerCreating|PodInitializing|Init:|Terminating/.test(st) ? "warn" : "bad",
        cols: [NONE(c.Ready), st, restarts, NONE(c.Node)] };
    },
    cols: [["READY", 56], ["STATUS", 150], ["RESTARTS", 92], ["NODE", 220]],
  },
  {
    id: "deploy", label: "Deployments", res: "deployments", logs: true, path: (ns) => `/apis/apps/v1/namespaces/${ns}/deployments`,
    parse(c, ns) {
      const [r, w] = NONE(c.Ready).split("/").map(Number);
      return { ns, name: c.Name, age: NONE(c.Age), selector: NONE(c.Selector),
        tone: !w ? "dim" : r >= w ? "ok" : r === 0 ? "bad" : "warn",
        cols: [NONE(c.Ready), NONE(c["Up-to-date"]), NONE(c.Available), NONE(c.Images).split(",").map((i) => i.split("/").pop()).join(" ")] };
    },
    cols: [["READY", 64], ["UP-TO-DATE", 84], ["AVAILABLE", 78], ["IMAGE", 300]],
  },
  {
    id: "nodes", label: "Nodes", res: "nodes", cluster: true, path: () => "/api/v1/nodes",
    parse(c) {
      const st = NONE(c.Status);
      return { ns: "", name: c.Name, age: NONE(c.Age), tone: st === "Ready" ? "ok" : st.startsWith("Ready,") ? "warn" : "bad",
        cols: [st, NONE(c.Roles), NONE(c.Version), NONE(c["Internal-IP"])] };
    },
    cols: [["STATUS", 170], ["ROLES", 110], ["VERSION", 150], ["IP", 120]],
  },
  {
    id: "svc", label: "Services", res: "services", logs: true, path: (ns) => `/api/v1/namespaces/${ns}/services`,
    parse(c, ns) {
      return { ns, name: c.Name, age: NONE(c.Age), selector: NONE(c.Selector), tone: "plain",
        cols: [NONE(c.Type), NONE(c["Cluster-IP"]), NONE(c["Port(s)"]), NONE(c["External-IP"])] };
    },
    cols: [["TYPE", 100], ["CLUSTER-IP", 120], ["PORTS", 200], ["EXTERNAL", 260]],
  },
  {
    id: "ing", label: "Ingresses", res: "ingresses", path: (ns) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
    parse(c, ns) {
      return { ns, name: c.Name, age: NONE(c.Age), tone: "plain", cols: [NONE(c.Class), NONE(c.Hosts), NONE(c.Address)] };
    },
    cols: [["CLASS", 90], ["HOSTS", 340], ["ADDRESS", 260]],
  },
];

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const sh = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
// Like Promise.allSettled, but at most `limit` calls run at once.
async function settledPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: "fulfilled", value: await fn(items[i]) }; }
      catch (reason) { out[i] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const rowKey = (r) => `${r.kind}|${r.ctx}|${r.ns}|${r.name}`;
const KIND_LABEL = { pods: "Pod", deploy: "Deployment", nodes: "Node", svc: "Service", ing: "Ingress" };
const readOnlyNote = (ctx) => `${ICONS.lock} ${ctx} is read-only`;
// A log is not restored as a view (it comes back from disk), a text view never is.
const normalizeView = (view, keepLogs) => (view === "text" || (view === "logs" && !keepLogs) ? "list" : view ?? "list");
const writeBig = async (file, text) => { await ensureDir(); await fs.writeFile(file, text + "\n").catch(() => {}); };
const yamlSyntax = (t) => ({ keyword: t.ansi6, string: t.ansi3, comment: t.dim, function: t.ansi4, type: t.ansi5, number: t.ansi5, constant: t.ansi2 });

// The window starts a fresh copy each time it opens; lists and the open view
// are kept on disk (shown at once, then refreshed). Only small things here.
const memo = { kind: null, data: {}, view: null, selKey: null, filter: "" };
const DATA_AGE = 30 * 60 * 1000; // lists older than this are not kept on disk
const LOG_CACHE = 3000, LOG_CACHE_AGE = 10 * 60 * 1000;
const logKey = (L) => `${L.ctx}|${L.ns}|${L.kind}|${L.name}|${L.since}|${L.previous ? 1 : 0}`;
const ASK_INLINE = 60000; // characters of log put straight into the agent's first message

// The working folder of the agent (or shell) running in one of these terminals:
// each Herdr terminal's processes carry HC_TERMINAL_ID, so find a process with
// that id and read its cwd. (The terminal's own cwd is only the shell's.)
async function sessionFolder(terms) {
  if (!terms.length) return null;
  const script = 'for pid in $(pgrep -x claude; pgrep -x codex); do id=$(ps -E -o command= -p "$pid" 2>/dev/null | tr " " "\\n" | sed -n "s/^HC_TERMINAL_ID=//p" | head -1); for t in "$@"; do [ "$id" = "$t" ] && lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n "s/^n//p" && exit 0; done; done; exit 1';
  const r = await exec("sh", ["-c", script, "sh", ...terms]).catch(() => null);
  return r?.code === 0 ? r.stdout.trim().split("\n")[0] || null : null;
}

const LOG_PARALLEL = 8; // log requests in flight at once
const LOG_KEEP = ["previous", "ctx", "ns", "name", "kind", "selector", "since", "ts", "wrap", "level", "q", "filterOnly"];

export default class K8s extends View {
  init(initial, cx) {
    this.contexts = memo.contexts ?? load("contextList", []);
    this.selected = new Set(load("contexts", []));
    this.kind = memo.kind ?? load("kind", "deploy");
    this.allNs = load("allNs", false);
    this.defaultNs = load("defaultNs", {});
    this.data = memo.data;
    this.loading = new Set();
    this.filter = memo.filter || load("filter", "");
    this.at = 0; // the selected row's index; selKey is what is remembered (rows move between refreshes)
    this.selKey = memo.selKey ?? load("selKey", null);
    this.view = normalizeView(memo.view, false); // list | logs | text
    this.log = null;
    this.dataVer = 0;
    this.text = null;
    this.panel = { open: load("panelOpen", false), tab: "overview", key: null, d: null, error: null, busy: false, full: false, yaml: null };
    // Everything later code reads is declared here, whether it is set in a handler or a task.
    this.closed = false; this.saving = false; this.prefetched = false;
    this.note = null; this.asking = false; this.showSettings = false;
    this.size = null; this.lay = null; this.drag = null; this.thumb = null;
    this.lastClick = 0; this.panelBefore = false;
    this.rowsCache = null; this.poolCache = null; this.savedPref = null;
    this.ro = {}; // context -> read-only, from settings.json (prod contexts are read-only unless set otherwise)
    this.confirm = null;
    this.typing = null; // which input holds the keyboard
    this.stick = true;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.logTop = 0; this.logH = 400; // the log area scrolls by itself (see renderLogs)

    this.input = InputState.new({ placeholder: "filter: words match context / namespace / name / status" });
    if (this.filter) this.input.set_value(this.filter);
    // Timers are kept so close() can stop them (a closed copy must not keep polling).
    this.tasks = [];
    if (this.selKey) this.tasks.push(cx.timer.after(50, () => { this.rows(); if (this.at) this.scroll.scroll_to_item(this.at, "center"); }));
    this.input.on("change", (_e, cx) => { this.setFilter(this.input.value()); this.select(0); this.scroll.scroll_to_item(0); this.syncPanel(cx); cx.notify(); });
    // Enter goes one level in: the selected row's logs.
    this.input.on("submit", (_e, cx) => { this.leaveInput(cx); this.open(this.selectedRow(), cx); });
    this.input.on("focus", (_e, cx) => { this.typing = "list"; cx.notify(); });
    this.input.on("blur", (_e, cx) => { if (this.typing === "list") this.typing = null; cx.notify(); });

    this.search = InputState.new({ placeholder: "search logs  (Enter next · ⇧Enter prev)" });
    this.search.on("change", (_e, cx) => { if (this.log) { this.log.q = this.search.value(); this.log.match = -1; } cx.notify(); });
    this.search.on("submit", (e, cx) => { this.step(e?.shift ? -1 : 1); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.typing = "search"; cx.notify(); });
    this.search.on("blur", (_e, cx) => { if (this.typing === "search") this.typing = null; cx.notify(); });

    this.askInput = InputState.new({ placeholder: "What should the agent look at? (Enter to send)" });
    this.askInput.on("submit", (_e, cx) => this.sendAsk(cx));
    this.askInput.on("focus", (_e, cx) => { this.typing = "ask"; cx.notify(); });
    this.askInput.on("blur", (_e, cx) => { if (this.typing === "ask") this.typing = null; cx.notify(); });
    this.scaleInput = InputState.new({ placeholder: "replicas" });
    this.scaleInput.on("submit", (_e, cx) => this.accept(cx));
    this.scaleInput.on("focus", (_e, cx) => { this.typing = "scale"; cx.notify(); });
    this.scaleInput.on("blur", (_e, cx) => { if (this.typing === "scale") this.typing = null; cx.notify(); });
    cx.spawn(async (cx) => {
      try { this.ro = JSON.parse(await fs.readFile(`${DIR()}/settings.json`, "utf8")).readOnly ?? {}; } catch {}
      cx.notify();
    });
    this.tasks.push(cx.timer.every(10000, (cx) => { if (this.view === "list" && this.panel.open && this.visible()) this.loadPanel(cx, true); }));
    // Files handed to "Ask agent" are only needed for a while.
    exec("find", [DIR(), "-name", "ask-*.log", "-mtime", "+1", "-delete"]).catch(() => {});

    cx.spawn(async (cx) => {
      const r = await exec("kubectl", ["config", "get-contexts", "-o", "name"]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.contexts = memo.contexts = r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      save("contextList", this.contexts);
      const v = await exec("kubectl", ["config", "view", "-o", "json"]).catch((e) => ({ code: 1, stderr: String(e) }));
      try {
        if (v.code !== 0) throw new Error(v.stderr);
        this.defaultNs = Object.fromEntries((JSON.parse(v.stdout).contexts ?? []).map((c) => [c.name, c.context?.namespace || "default"]));
        save("defaultNs", this.defaultNs);
      } catch (e) { this.note = `kubeconfig: ${String(e?.message ?? e).slice(0, 200)}`; }
      if (r.code !== 0) this.note = r.stderr;
      this.selected = new Set([...this.selected].filter((c) => this.contexts.includes(c)));
      if (!this.selected.size && this.contexts.length) this.selected.add(this.contexts[0]);
      this.refresh(cx);
      cx.notify();
    });
    this.tasks.push(
      cx.timer.every(20000, (cx) => { if (this.view === "list" && this.visible()) this.refresh(cx); }),
      cx.timer.after(2500, (cx) => this.prefetch(cx)),
      cx.timer.every(1000, (cx) => this.pollLogs(cx)));
    // Opens ready to type a filter; ↑/↓ move through the rows from there.
    const start = () => (this.view === "list" ? this.input.focus() : this.handle.focus());
    start();
    this.tasks.push(cx.timer.after(150, start));
    this.restore(initial ?? {}, cx);
  }

  // Opened from the window's ⇱/◫ buttons: start where the window was.
  // Otherwise: lists from disk at once, and the last view.
  restore(p, cx) {
    if (p.kind) this.kind = p.kind;
    if (p.filter !== undefined) { this.filter = p.filter; this.input.set_value(p.filter); }
    if (p.log) { this.startLogs(p.log, cx); return; }
    cx.spawn(async (cx) => {
      try {
        const disk = JSON.parse(await fs.readFile(`${DIR()}/state.json`, "utf8"));
        for (const [k, v] of Object.entries(disk.data ?? {})) if (!this.data[k] || this.data[k].at < v.at) this.data[k] = { ...v, error: null };
        this.dataVer++;
        if (disk.ui?.view === "logs" && disk.ui.log && !this.log) {
          let cache = null;
          try { cache = JSON.parse(await fs.readFile(`${DIR()}/logs.json`, "utf8")); } catch {}
          this.startLogs(disk.ui.log, cx, cache);
        }
      } catch {}
      if (this.closed) return;
      this.refresh(cx);
      cx.notify();
    });
  }

  snapshot() {
    const L = this.log;
    return { view: normalizeView(this.view, true), kind: this.kind, filter: this.filter,
      log: L ? Object.fromEntries(LOG_KEEP.map((k) => [k, L[k]])) : null };
  }

  // Lists of the selected contexts from the last half hour, and where the view is.
  stateJson() {
    const now = Date.now(), keep = {};
    for (const [k, v] of Object.entries(this.data)) if (this.selected.has(k.split("|")[1]) && now - v.at < DATA_AGE && !v.error) keep[k] = v;
    return JSON.stringify({ data: keep, ui: this.snapshot() }, (k, v) => (k === "hay" ? undefined : v));
  }

  persist() {
    if (this.saving) return;
    this.saving = true;
    const body = this.stateJson();
    ensureDir()
      .then(() => fs.writeFile(`${DIR()}/state.json`, body)).catch(() => {})
      .finally(() => { this.saving = false; });
  }

  // ⇱: this view as a tab of its own; ◫: beside the focused pane.
  detach(where) {
    const s = this.snapshot();
    const p = { kind: s.kind, filter: s.filter, ...(s.view === "logs" && s.log ? { log: s.log } : {}) };
    const name = s.view === "logs" && s.log ? `logs ${s.log.name}` : "Kubernetes";
    if (where === "tab") run("tab.new", { name, mod: "kubernetes", props: p });
    else run("pane.split", { direction: "right", mod: "kubernetes", props: p });
    this.hide();
  }

  // On close only (not while following): the last lines and where each stream
  // stopped, so reopening shows them at once and fetches only what came after.
  logCache() {
    const L = this.log;
    if (!L || this.view !== "logs") return null;
    return { key: logKey(L), at: Date.now(), cursor: L.cursor, pods: L.pods,
      lines: L.lines.slice(-LOG_CACHE).map(({ pod, ctr, key, ts, time, text, level }) => ({ pod, ctr, key, ts, time, text, level })) };
  }

  // Everything this copy holds is let go here: timers stop, host objects are
  // released, and late async results are ignored (this.closed).
  async close() {
    this.closed = true;
    for (const task of this.tasks) task.cancel();
    save("selKey", this.selKey);
    const cache = this.logCache(), state = this.stateJson();
    memo.view = normalizeView(this.view, true);
    memo.selKey = this.selKey; memo.kind = this.kind;
    this.log = null;
    for (const x of [this.scroll, this.text?.editor, this.panel?.yaml, this.input, this.search, this.askInput, this.scaleInput, this.handle]) x?.release?.();
    await ensureDir();
    await Promise.all([
      fs.writeFile(`${DIR()}/state.json`, state).catch(() => {}),
      cache ? fs.writeFile(`${DIR()}/logs.json`, JSON.stringify(cache)).catch(() => {}) : null,
    ]);
  }

  hide() { const o = props()?.overlay; if (o) closeOverlay(o); }

  kindDef() { return KINDS.find((k) => k.id === this.kind) ?? KINDS[1]; }

  // "default": each context's own namespace from kubeconfig; "all": every namespace.
  // null until kubeconfig has been read: nothing is fetched for the wrong namespace.
  scopeOf(kind, ctx) { return kind.cluster || this.allNs ? "*" : this.defaultNs[ctx] ?? null; }
  keyOf(kind, ctx) { return `${kind.id}|${ctx}|${this.scopeOf(kind, ctx)}`; }

  setAllNs(on, cx) {
    this.allNs = on; save("allNs", on); this.select(0); this.scroll.scroll_to_item(0);
    this.prefetched = false; this.refresh(cx); this.prefetch(cx); this.syncPanel(cx);
  }

  // ---------------------------------------------------------------- list
  // kind: which kind to fetch (the shown one by default; the shown kind is never changed here).
  // maxAge: data younger than this is kept (opening often costs nothing).
  refresh(cx, { kind: id = this.kind, force = false, maxAge = 15000 } = {}) {
    const kind = KINDS.find((k) => k.id === id) ?? this.kindDef();
    for (const ctx of this.selected) {
      if (this.scopeOf(kind, ctx) === null) continue;
      const key = this.keyOf(kind, ctx);
      if (this.loading.has(key)) continue;
      if (!force && this.data[key] && !this.data[key].error && Date.now() - this.data[key].at < maxAge) continue;
      this.loading.add(key);
      cx.spawn(async (cx) => {
        try {
          const scope = this.scopeOf(kind, ctx);
          const nss = kind.cluster ? [""] : scope === "*" ? await namespacesOf(ctx) : [scope];
          // One namespace failing (deleted meanwhile, no access) must not hide the others.
          const parts = await settledPool(nss, 16, async (ns) => (await table(ctx, kind.path(ns))).map((c) => ({ ctx, kind: kind.id, ...kind.parse(c, ns) })));
          const prevRows = this.data[key]?.rows ?? [];
          const failed = parts.map((p, i) => [p, nss[i]]).filter(([p]) => p.status === "rejected");
          if (failed.length === nss.length && failed.length) throw failed[0][0].reason;
          let lost = 0;
          const kept = []; // a namespace that failed transiently keeps the rows it had
          for (const [p, ns] of failed) {
            if (/^404\b/.test(p.reason?.message ?? "")) dropNamespace(ctx, ns);
            else { lost++; for (const row of prevRows) if (row.ns === ns) kept.push(row); }
          }
          this.data[key] = { at: Date.now(), rows: [...parts.flatMap((p) => (p.status === "fulfilled" ? p.value : [])), ...kept],
            ...(lost ? { warn: `${lost} of ${nss.length} namespaces failed` } : {}) };
        } catch (e) {
          this.data[key] = { rows: this.data[key]?.rows ?? [], error: String(e?.message ?? e), at: Date.now() };
        } finally {
          this.loading.delete(key);
          this.dataVer++;
          if (!this.closed) {
            const was = this.at;
            this.rows();
            if (this.at !== was) this.scroll.scroll_to_item(this.at); // the selected row moved: keep it in view
            this.syncPanel(cx); cx.notify();
          }
        }
      });
    }
    cx.notify();
  }

  // Is this copy on screen? (a window always is; a tab or split only while its tab shows)
  visible() {
    if (props()?.overlay) return true;
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
    return Boolean(tab) && panes().some((p) => p.tab === tab.id && p.mod === "kubernetes");
  }

  // Fills every kind once in the background so switching is instant.
  prefetch(cx) {
    if (this.prefetched) return;
    this.prefetched = true;
    for (const k of KINDS) if (k.id !== this.kind) this.refresh(cx, { kind: k.id, maxAge: 120000 });
  }

  // The shown rows, worked out once per change (called several times a render).
  rows() {
    const kind = this.kindDef();
    const key = `${this.filter}|${[...this.selected]}|${this.contexts.length}|${kind.id}|${this.allNs}|${this.dataVer}|${Object.keys(this.defaultNs).length}`;
    if (this.rowsCache?.key === key) return this.rowsCache.rows;
    const words = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const ctx of this.contexts) {
      if (!this.selected.has(ctx)) continue;
      for (const r of this.data[this.keyOf(kind, ctx)]?.rows ?? []) {
        if (words.length) {
          r.hay ??= `${r.ctx} ${r.ns} ${r.name} ${r.cols.join(" ")}`.toLowerCase();
          if (!words.every((w) => r.hay.includes(w))) continue;
        }
        out.push(r);
      }
    }
    this.rowsCache = { key, rows: out };
    this.follow(out);
    return out;
  }

  // The selection is a row, not a position: after the rows change (a refresh, a
  // filter) it moves to where its row now is. A row that is gone leaves the
  // selection at the same position (clamped), now on whatever is there.
  follow(rows) {
    if (!rows.length) return; // nothing to select yet: keep the remembered row for when the data arrives
    if (this.selKey && rowKey(rows[this.at] ?? {}) === this.selKey) return;
    const i = this.selKey ? rows.findIndex((r) => rowKey(r) === this.selKey) : -1;
    this.at = i >= 0 ? i : Math.min(this.at, rows.length - 1);
    // Only forget the remembered row when the data is complete: with another context still
    // loading, or a namespace that failed, the row may just not have arrived (or come back).
    if (i >= 0 || !this.selKey || this.allLoaded()) this.selKey = rowKey(rows[this.at]);
  }

  // Is every selected context loaded for the shown kind, without error or warning?
  allLoaded() {
    const kind = this.kindDef();
    return [...this.selected].every((ctx) => {
      const d = this.data[this.keyOf(kind, ctx)];
      return d && !d.error && !d.warn && !this.loading.has(this.keyOf(kind, ctx));
    });
  }

  select(i) {
    this.at = i;
    const r = this.rows()[i];
    this.selKey = r ? rowKey(r) : null;
  }

  // Completions for the word being typed: names of this kind, namespaces and
  // contexts already loaded (no extra requests). Prefix matches first.
  suggestions() {
    const words = this.filter.split(/\s+/), last = (words.pop() ?? "").toLowerCase();
    if (!last || (this.typing !== "list")) return [];
    const seen = new Set(words.map((w) => w.toLowerCase()));
    const starts = [], has = [];
    for (const [name, low] of this.suggestionPool()) {
      if (low === last || seen.has(low)) continue;
      if (low.startsWith(last)) starts.push(name); else if (low.includes(last)) has.push(name);
    }
    const byLen = (a, b) => a.length - b.length || a.localeCompare(b);
    return [...starts.sort(byLen), ...has.sort(byLen)].slice(0, 6);
  }

  // Every name that can be completed, with its lower-case form: worked out when
  // the data, kind or contexts change, not on every keystroke.
  suggestionPool() {
    const kind = this.kindDef();
    const key = `${this.dataVer}|${kind.id}|${[...this.selected]}|${this.allNs}`;
    if (this.poolCache?.key === key) return this.poolCache.pool;
    const names = new Set();
    for (const ctx of this.selected) {
      names.add(ctx);
      for (const r of this.data[this.keyOf(kind, ctx)]?.rows ?? []) { names.add(r.name); if (r.ns) names.add(r.ns); }
    }
    const pool = [...names].map((n) => [n, n.toLowerCase()]);
    this.poolCache = { key, pool };
    return pool;
  }

  complete(word, cx) {
    const words = this.filter.split(/\s+/);
    words[words.length - 1] = word;
    const v = words.join(" ") + " ";
    this.setFilter(v, true);
    this.select(0); this.scroll.scroll_to_item(0);
    this.input.focus();
    cx.notify();
  }

  // State only; setFilter/applyKind never fetch or redraw.
  setFilter(v, syncInput = false) {
    if (syncInput) this.input.set_value(v);
    this.filter = memo.filter = v; save("filter", v);
  }
  applyKind(id) { this.kind = memo.kind = id; save("kind", id); }

  setKind(id, cx) {
    if (this.kind === id) return;
    this.applyKind(id); this.select(0); this.scroll.scroll_to_item(0);
    this.refresh(cx);
    this.syncPanel(cx);
  }

  toggleContext(ctx, cx) {
    if (this.selected.has(ctx)) this.selected.delete(ctx); else this.selected.add(ctx);
    save("contexts", [...this.selected]); this.refresh(cx); this.syncPanel(cx);
  }

  leaveInput(cx) { this.typing = null; this.handle.focus(); cx.notify(); }

  move(delta, cx) {
    const n = this.rows().length;
    if (!n) return;
    this.select(Math.max(0, Math.min(n - 1, this.at + delta)));
    this.scroll.scroll_to_item(this.at);
    this.loadPanel(cx);
    cx.notify();
  }

  open(r, cx) {
    if (!r) return;
    if (!this.kindDef().logs) return this.inspect(r, "describe", cx);
    if (r.kind !== "pods" && !r.selector) { this.note = "no selector to follow"; return; }
    this.startLogs({ ctx: r.ctx, ns: r.ns, name: r.name, kind: r.kind, selector: r.selector }, cx);
  }

  inspect(r, what, cx) {
    if (!r) return;
    const kind = this.kindDef();
    const args = ["--context", r.ctx, ...(kind.cluster ? [] : ["-n", r.ns]), ...(what === "yaml" ? ["get", kind.res, r.name, "-o", "yaml"] : ["describe", kind.res, r.name])];
    this.text?.editor?.release();
    this.text = { title: `${what} ${kind.res}/${r.name}`, sub: `${r.ctx}${r.ns ? " · " + r.ns : ""}`, editor: null, error: null };
    this.view = "text";
    const mine = this.text;
    cx.spawn(async (cx) => {
      const out = await exec("kubectl", args).catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.closed || this.text !== mine) return;
      if (out.code !== 0) mine.error = out.stderr || "kubectl failed";
      else {
        const t = theme();
        mine.editor = EditorState.new({ language: "yaml", readonly: true, value: out.stdout,
          font_family: settings().font_family, font_size: 12,
          syntax: yamlSyntax(t) });
      }
      cx.notify();
    });
    cx.notify();
  }

  shell(r) {
    if (!r || r.kind !== "pods") { this.note = "shell: pick a pod (1 Pods)"; return; }
    if (this.isReadOnly(r.ctx)) { this.note = readOnlyNote(r.ctx); return; }
    const cmd = `kubectl --context ${sh(r.ctx)} -n ${sh(r.ns)} exec -it ${sh(r.name)} -- sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
    run("terminal.open", { argv: ["sh", "-c", cmd], place: "tab", name: `${r.ctx}/${r.name}` });
    this.hide();
  }

  back(cx) {
    this.asking = false;
    if (this.view === "text") { this.text?.editor?.release(); this.text = null; }
    this.view = memo.view = "list";
    this.log = null; // a log can hold 30000 lines; reopening it fetches again
    this.persist();
    // Back on the list: ready to type a filter again (↑/↓ still move the rows).
    this.input.focus();
    cx.notify();
  }

  // ---------------------------------------------------------------- guard
  // Production stays read-only: every change to a cluster goes through
  // mutate(), which refuses read-only contexts. (The proxy is read-only too;
  // changes run as one `kubectl` command after a confirmation.)
  isReadOnly(ctx) { return this.ro[ctx] ?? /prod/i.test(ctx); }

  setReadOnly(ctx, on) {
    this.ro = { ...this.ro, [ctx]: on };
    ensureDir()
      .then(() => fs.writeFile(`${DIR()}/settings.json`, JSON.stringify({ readOnly: this.ro }, null, 2))).catch(() => {});
  }

  ask(c) {
    if (this.isReadOnly(c.ctx)) { this.note = readOnlyNote(c.ctx); return; }
    this.confirm = c;
    if (c.input) { this.scaleInput.set_value(String(c.input)); this.scaleInput.focus(); } else this.handle.focus();
  }

  accept(cx) {
    const c = this.confirm;
    if (!c) return;
    let args = c.args;
    if (c.input !== undefined) {
      const n = Number(this.scaleInput.value());
      if (!Number.isInteger(n) || n < 0 || n > 50) { this.note = "replicas: a whole number 0–50"; cx.notify(); return; }
      args = [...args, `--replicas=${n}`];
    }
    this.confirm = null;
    this.handle.focus();
    this.mutate(c.ctx, args, c.title, cx);
  }

  mutate(ctx, args, title, cx) {
    if (this.isReadOnly(ctx)) { this.note = readOnlyNote(ctx); return; }
    this.note = `${title}…`;
    cx.spawn(async (cx) => {
      const r = await exec("kubectl", ["--context", ctx, ...args]).catch((e) => ({ code: 1, stderr: String(e) }));
      this.note = r.code === 0 ? `${ICONS.ok} ${(r.stdout || title).trim().split("\n").pop()}` : `${ICONS.fail} ${(r.stderr || "failed").trim().split("\n").pop()}`;
      this.refresh(cx, { force: true });
      this.loadPanel(cx, true, true);
      cx.notify();
    });
    cx.notify();
  }

  // The actions a row offers: [id, label, run, changes the cluster?]
  actions(r) {
    if (!r) return [];
    const ns = ["-n", r.ns], out = [];
    if (r.kind === "pods" || r.selector) out.push(["logs", `${ICONS.logs} Logs`, (cx) => this.open(r, cx), false]);
    if (r.kind === "pods") {
      out.push(["shell", `${ICONS.shell} Shell`, () => this.shell(r), true]);
      out.push(["delete", `${ICONS.trash} Delete pod`, () => this.ask({ ctx: r.ctx, title: `Delete pod ${r.name} (its controller starts a new one)`, args: [...ns, "delete", "pod", r.name, "--wait=false"] }), true]);
    }
    if (r.kind === "deploy") {
      out.push(["restart", `${ICONS.restart} Restart`, () => this.ask({ ctx: r.ctx, title: `Rolling restart of deployment ${r.name}`, args: [...ns, "rollout", "restart", `deployment/${r.name}`] }), true]);
      const want = this.panel.d?.obj?.spec?.replicas ?? Number(String(r.cols[0]).split("/")[1] ?? 1);
      out.push(["scale", `${ICONS.scale} Scale`, () => this.ask({ ctx: r.ctx, title: `Scale deployment ${r.name}`, args: [...ns, "scale", `deployment/${r.name}`], input: want }), true]);
    }
    if (r.kind === "nodes") {
      const cordoned = Boolean(this.panel.d?.obj?.spec?.unschedulable);
      out.push(["cordon", cordoned ? "Uncordon" : "Cordon", () => this.ask({ ctx: r.ctx, title: `${cordoned ? "Uncordon" : "Cordon"} node ${r.name}`, args: [cordoned ? "uncordon" : "cordon", r.name] }), true]);
    }
    return out;
  }

  // ---------------------------------------------------------------- panel
  selectedRow() { return this.rows()[this.at]; }

  // After anything that can change which row is selected (typing, kind,
  // contexts, fresh data): load the panel if it now shows another row.
  // (Never from render: timers and tasks can't be started there.)
  syncPanel(cx) {
    const r = this.selectedRow();
    if (this.panel.open && r && this.panel.key !== rowKey(r)) this.loadPanel(cx);
  }

  // Loads the selected row into the side panel. One load at a time: rows
  // passed over while one is in flight are skipped, and the row you stop on
  // is loaded when it finishes. (No timers: this runs from tasks too.)
  // A refresh of the row already shown fetches only what its tab shows; `full`
  // (after a change to the cluster) fetches everything.
  loadPanel(cx, again, full = false) {
    const P = this.panel, r = this.selectedRow();
    if (this.closed || !P.open || !r) return;
    const key = rowKey(r);
    if (!again && P.key === key) return;
    if (P.key !== key) { P.key = key; P.d = null; P.error = null; P.yaml?.release(); P.yaml = null; }
    if (full) P.full = true;
    if (P.busy) return;
    P.busy = true;
    cx.spawn(async (cx) => {
      let done = null;
      try {
        while (!this.closed && P.key) {
          const want = P.key, tab = P.tab, stamp = `${want}|${tab}`;
          if (stamp === done) break;
          const row = this.selectedRow();
          if (!row || rowKey(row) !== want) break;
          const opts = P.full || !P.d ? {} : { tab, prev: P.d };
          P.full = false;
          try {
            const d = await loadDetail(api, row, opts);
            if (this.closed || P.key !== want) continue;
            const changed = P.d?.obj?.metadata?.resourceVersion !== d.obj?.metadata?.resourceVersion;
            P.d = d; P.error = null;
            if (P.yaml && changed) P.yaml.set_value(yamlOf(d.obj)); else this.ensureYaml();
          } catch (e) {
            // A failed refresh keeps what is shown; only a first load shows the error.
            if (P.key === want) { if (P.d) this.note = `panel: ${String(e?.message ?? e)}`; else P.error = String(e?.message ?? e); }
          }
          done = stamp;
        }
      } finally { P.busy = false; if (!this.closed) cx.notify(); }
    });
  }

  openPod(ctx, ns, name, cx) {
    this.applyKind("pods"); this.dataVer++;
    const scope = this.allNs || ns === this.defaultNs[ctx];
    if (!scope) this.setAllNs(true, cx);
    this.setFilter(name, true); this.select(0);
    this.refresh(cx);
    cx.notify();
  }

  // The YAML editor is made outside render (host objects can't be created there).
  ensureYaml() {
    const P = this.panel;
    if (this.closed || P.tab !== "yaml" || P.yaml || !P.d) return;
    P.yaml = EditorState.new({ language: "yaml", readonly: true, value: yamlOf(P.d.obj), font_family: settings().font_family, font_size: 12, syntax: yamlSyntax(theme()) });
  }

  // Only the shown tab's data is fetched again (see loadDetail), so a new tab refreshes at once.
  setTab(id, cx) {
    this.panel.tab = id; this.ensureYaml(); this.loadPanel(cx, true);
  }

  togglePanel(cx) { this.setPanel(!this.panel.open, cx); }
  setPanel(open, cx) {
    this.panel.open = open;
    save("panelOpen", open);
    if (!open) this.confirm = null;
    this.loadPanel(cx);
    this.handle.focus();
    cx.notify();
  }

  renderPanel(t, mono) {
    const P = this.panel, r = this.selectedRow();
    if (!r) return v_flex().size_full().p(16).text_color(t.dim).child("Select a row");
    const ro = this.isReadOnly(r.ctx);
    const kindLabel = KIND_LABEL[r.kind];
    const tab = (id, label) => this.chip(t, `ptab-${id}`, label, P.tab === id, (cx) => this.setTab(id, cx));
    let body;
    if (P.error) body = [div().text_color(t.ansi1).child(P.error)];
    else if (!P.d) body = [div().text_color(t.dim).child("Loading…")];
    else if (P.tab === "events") body = drawEvents(t, P.d);
    else if (P.tab === "yaml") body = P.yaml ? null : [div().text_color(t.dim).child("Loading…")];
    else body = draw(this, t, mono, r, P.d);
    const evWarn = P.d?.events?.filter((e) => e.type === "Warning").length ?? 0;
    return v_flex().size_full().min_h(0).bg(t.background).border_l(1).border_color(t.border)
      .child(v_flex().flex_none().px(14).pt(10).pb(8).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(11).text_color(t.dim).child(kindLabel))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(r.name))
          .when(P.busy, (el) => el.child(div().text_size(12).text_color(t.dim).frames(SPIN, 90).child("⠋")))
          .child(div().id("panel-close").w(22).h(22).flex().items_center().justify_center().rounded(6).cursor_pointer()
            .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.togglePanel(cx)).child(glyph(null, ICONS.close))))
        .child(h_flex().gap(8).items_center().text_size(12)
          .child(div().text_color(t.muted).child(`${r.ctx}${r.ns ? ` · ${r.ns}` : ""}`))
          .child(div().px(6).rounded(4).text_size(11).bg(ro ? t.ansi1 + "22" : t.raised).text_color(ro ? t.ansi1 : t.dim).child(ro ? lbl(`${ICONS.lock} read-only`) : "writable")))
        .child(h_flex().flex_wrap().gap(4).children(this.actions(r).map(([id, label, go, changes]) => {
          const off = changes && ro;
          return div().id(`act-${id}`).px(8).py(3).rounded(6).text_size(12).border_1().border_color(t.border)
            .text_color(off ? t.dim : t.foreground).when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { if (off) this.note = readOnlyNote(r.ctx); else go(cx); cx.notify(); })
            .child(lbl(off ? `${ICONS.lock} ${label.replace(/^\S+ /, "")}` : label));
        })))
        .child(h_flex().gap(2).child(tab("overview", "Overview")).child(tab("events", evWarn ? `Events · ${evWarn} ${ICONS.warn}` : "Events")).child(tab("yaml", "YAML"))))
      .when(Boolean(this.confirm), (el) => {
        const c = this.confirm;
        return el.child(v_flex().flex_none().mx(12).mt(10).p(10).gap(8).rounded(8).border_1().border_color(t.ansi3).bg(t.ansi3 + "14")
          .child(div().text_size(12).font_semibold().child(c.title))
          .child(div().text_size(11).text_color(t.dim).child(`${c.ctx}: kubectl ${c.args.join(" ")}${c.input !== undefined ? " --replicas=N" : ""}`))
          .child(h_flex().gap(8).items_center()
            .when(c.input !== undefined, (el) => el.child(div().w(90).child(this.inputBox(t, "scale", this.scaleInput, this.typing === "scale", 60))))
            .child(div().id("confirm-yes").px(10).py(4).rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.accept(cx)).child("Confirm ↵"))
            .child(div().id("confirm-no").px(10).py(4).rounded(6).text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { this.confirm = null; this.handle.focus(); cx.notify(); }).child("Cancel esc"))));
      })
      .child(body === null
        ? this.textArea("panel-yaml", P.yaml)
        : v_flex().id("panel-body").flex_1().min_h(0).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).overflow_y_scrollbar().px(14).pb(14).text_size(13).children(body));
  }

  // ---------------------------------------------------------------- logs
  startLogs(target, cx, cache) {
    // The toolbar's choices (range, time, wrap, level) carry over to every log.
    const L = this.log = newLog(target, this.log, load("logPrefs", {}));
    // Closed less than 10 minutes ago: show what was there and fetch only what came after.
    if (cache && cache.key === logKey(L) && Date.now() - cache.at < LOG_CACHE_AGE) restoreLines(L, cache);
    this.search.set_value(L.q);
    this.view = memo.view = "logs";
    this.saveLogPrefs();
    this.persist();
    this.stick = true;
    this.pollLogs(cx, true);
    this.handle.focus();
    cx.notify();
  }

  reload(cx) {
    const L = this.log;
    if (!L) return;
    resetLog(L);
    this.stick = true;
    this.pollLogs(cx, true);
  }

  // Remembers the toolbar's choices for the next log (only when one changed).
  saveLogPrefs() {
    const L = this.log, sp = this.savedPref;
    if (!L || (sp && sp.since === L.since && sp.ts === L.ts && sp.wrap === L.wrap && sp.level === L.level)) return;
    this.savedPref = { since: L.since, ts: L.ts, wrap: L.wrap, level: L.level };
    save("logPrefs", this.savedPref);
  }
  setLogOpt(name, value) { this.log[name] = value; this.saveLogPrefs(); }

  // Each pod/container is read with the log API: first the chosen range, then
  // only what came after its last line (sinceTime), every second while shown
  // (every 10 s in a hidden tab). A container with nothing new is asked less
  // often (2, 4, then 8 s apart; see logs.js). Pods behind a selector are
  // re-listed every 15 s. The window redraws only when something changed:
  // new lines, a new error, or the first load (its spinner).
  //
  // Requests are not awaited together: each stream is read by a task of its own and
  // merged when it answers, at most LOG_PARALLEL at a time, so one slow or hung
  // stream delays only itself. (There is no timeout: fetch has no abort option and a
  // timer may not be started from a callback, so a request that never answers keeps
  // its slot, and its stream is not asked again meanwhile.)
  pollLogs(cx, initial) {
    const L = this.log;
    if (!L || L.busy || this.view !== "logs") return;
    // A paused or previous-container log is read once; streams not yet read (more than LOG_PARALLEL) still are.
    const unread = !L.streams || L.streams.some((s) => !s.read);
    if (!initial && ((!L.follow || L.previous) && !unread || !L.loaded)) return;
    if (!initial && !this.visible() && Date.now() - L.at < 10000) return;
    const gen = L.gen, live = () => !this.closed && this.log === L && L.gen === gen;
    const first = !L.loaded, wasError = L.error;
    L.busy = true;
    cx.spawn(async (cx) => {
      let batch = [];
      try {
        if (!L.streams || Date.now() - L.streamsAt > 15000) {
          const pods = L.kind === "pods"
            ? [await (await api(L.ctx, `/api/v1/namespaces/${L.ns}/pods/${L.name}`)).json()]
            : (await (await api(L.ctx, `/api/v1/namespaces/${L.ns}/pods?labelSelector=${encodeURIComponent(L.selector)}`)).json()).items ?? [];
          if (!live()) return;
          L.streams = streamsOf(pods, L.streams ?? []);
          L.streamsAt = Date.now();
        }
        const now = Date.now(), streams = L.streams;
        const want = (s) => !s.flying && (L.previous || !L.follow ? !s.read : initial || due(s, now));
        batch = streams.filter(want).slice(0, Math.max(0, LOG_PARALLEL - L.flying));
        for (const s of batch) { s.flying = true; L.flying++; }
        L.error = errorOf(L);
        if (!batch.length && !streams.some((s) => s.flying)) L.loaded = true;
      } catch (e) {
        if (live()) { L.error = String(e?.message ?? e); L.loaded = true; }
      } finally {
        if (live()) L.at = Date.now();
        if (live()) L.busy = false; // a reset or another log already cleared it for a stale run
        if (!this.closed && (first || L.loaded && L.error !== wasError)) cx.notify();
      }
      if (!live()) { for (const s of batch) { s.flying = false; L.flying--; } return; }
      for (const s of batch) {
        cx.spawn(async (cx) => {
          let body = "", err = null;
          try { body = await (await api(L.ctx, `/api/v1/namespaces/${L.ns}/pods/${s.pod}/log?${logQuery(L, s, L.streams.length)}`)).text(); }
          catch (e) { if (!/waiting to start|ContainerCreating|PodInitializing/.test(e.message)) err = `${s.key}: ${e.message}`; }
          s.flying = false; L.flying--;
          if (!live()) return;
          const was = { version: L.version, error: L.error, loaded: L.loaded };
          if (err) L.errs.set(s.key, err); else L.errs.delete(s.key);
          ingest(L, [[s, body]]);
          L.error = errorOf(L); L.loaded = true; L.at = Date.now();
          // One notify per batch: the first result, then when the last request in flight is done —
          // or after NOTIFY_MS, so a request that never answers can't freeze the rest of the log.
          if (L.version !== was.version || L.error !== was.error) L.dirty = true;
          if (!was.loaded || (L.dirty && (L.flying <= 0 || Date.now() - (L.notifiedAt ?? 0) > NOTIFY_MS))) {
            L.dirty = false; L.notifiedAt = Date.now(); cx.notify();
          }
        });
      }
    });
    if (first) cx.notify();
  }

  step(dir) {
    const L = this.log;
    if (!L) return;
    const i = stepMatch(L, visibleLines(L).matches, dir);
    if (i >= 0) this.scrollToLine(i);
  }

  setSince(s, cx) { const L = this.log; if (!L || L.since === s) return; this.setLogOpt("since", s); this.reload(cx); }

  // ------------------------------------------------------- pick, copy, ask
  copyLines(cx) {
    if (!this.log) return;
    const lines = chosen(this.log, visibleLines(this.log).lines);
    cx.write_to_clipboard(asText(lines));
    this.note = `Copied ${lines.length} lines`;
    notify({ title: `Copied ${lines.length} log lines`, timeout: 2000 });
  }

  // The agent gets the lines in its first message, and starts in the same
  // folder as the agent session you are working in (the active tab's), not
  // in home where the Kubernetes window sits. Very large picks also go to a file.
  // where: "new" opens a new tab with Claude; "current" pastes into the agent
  // of the tab you are on (hc send waits until it pauses, then submits).
  sendAsk(cx, where = "new") {
    if (!this.log) return;
    const L = this.log, lines = chosen(L, visibleLines(L).lines), q = this.askInput.value().trim();
    if (!lines.length) return;
    const what = `${KIND_LABEL[L.kind].toLowerCase()} ${L.name} (context ${L.ctx}, namespace ${L.ns})`;
    const text = asText(lines);
    const big = text.length > ASK_INLINE;
    const file = `${DIR()}/ask-${Date.now()}.log`;
    const shown = big ? text.slice(-ASK_INLINE).replace(/^[^\n]*\n/, "") : text;
    const task = `${q || "Look at these Kubernetes logs and tell me what is going on, especially errors and their likely cause."}\n\n` +
      `Logs from ${what}, ${lines[0].ts} → ${lines[lines.length - 1].ts} (timestamp pod/container message)` +
      (big ? `; the last part is below, all ${lines.length} lines are in ${file}` : "") + `:\n\n${shown}\n\n` +
      `More: kubectl --context ${L.ctx} -n ${L.ns} logs ...`;
    const space = spaces().find((x) => x.active), tab = space?.tabs.find((x) => x.active);
    const terms = panes().filter((p) => p.terminal && p.tab === tab?.id).map((p) => p.terminal.split("/").pop());
    if (where === "current") {
      const agent = agents().find((a) => a.tab === tab?.id);
      if (!agent) { this.note = "No agent in the current tab"; return; }
      cx.spawn(async (cx) => {
        if (big) await writeBig(file, text);
        const r = await exec("hc", ["send", agent.address, task]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) { this.note = `${ICONS.fail} ${(r.stderr || "hc send failed").trim().split("\n").pop()}`; if (!this.closed) cx.notify(); return; }
        this.asking = false; this.askInput.set_value("");
        run("pane.focus", { terminal: agent.address });
        this.hide();
      });
      return;
    }
    cx.spawn(async (cx) => {
      if (big) await writeBig(file, text);
      const folder = await sessionFolder(terms) ?? space?.folder;
      run("tab.new", { name: `ask: ${L.name}`, argv: ["claude"], task, ...(folder ? { folder } : {}) });
      this.asking = false; this.askInput.set_value("");
      this.hide();
      if (!this.closed) cx.notify();
    });
  }


  scrollToLine(i) {
    const lay = this.lay;
    if (!lay || i < 0) return;
    this.stick = false;
    this.logTop = Math.max(0, Math.min(lay.maxTop, lay.tops[i] - this.logH / 2));
  }

  // Press, drag over lines to pick a range (the view scrolls at the edges),
  // shift-click to extend, cmd-click to add one. A click on the only picked line unpicks it.
  pressLine(e, lines) {
    const L = this.log, y = e.local_position?.y;
    if (y === undefined) return;
    const i = indexAt(this.lay, y + this.logTop);
    if (i < 0) return;
    this.stick = false;
    if (e.modifiers?.shift || e.modifiers?.platform || e.modifiers?.control) { pick(L, i, e.modifiers, lines); return; }
    this.drag = pressPick(L, i, lines);
  }
  dragLine(e, lines) {
    const y = e.local_position?.y;
    if (!this.drag || y === undefined) return false;
    if (y < 0) this.logTop = Math.max(0, this.logTop - 24);
    if (y > this.logH) this.logTop = Math.min(this.lay?.maxTop ?? 0, this.logTop + 24);
    const i = indexAt(this.lay, Math.max(0, Math.min(this.logH - 1, y)) + this.logTop);
    if (i < 0) return false;
    dragPick(this.log, this.drag, i, lines);
    return true;
  }
  releaseLine() {
    if (this.log) releasePick(this.log, this.drag);
    this.drag = null; this.thumb = null;
  }

  toggleFollow(cx) {
    const L = this.log;
    L.follow = !L.follow;
    if (L.follow) { this.stick = true; this.pollLogs(cx); }
  }

  // ---------------------------------------------------------------- keys
  key(e, cx) {
    const k = e.key, ch = e.key_char, mod = e.modifiers ?? {};
    const stop = () => { cx.stop_propagation(); cx.notify(); };
    if (mod.platform || mod.alt) return;
    this.note = null;

    if (this.view === "text") {
      if (k === "escape" || k === "backspace" || ch === "q") { this.back(cx); return stop(); }
      return;
    }

    if (this.view === "logs") {
      const L = this.log;
      if (mod.control) {
        if (k === "f") { this.search.focus(); return stop(); }
        return;
      }
      if (k === "escape" && (this.asking || L.picked?.size)) {
        if (this.asking) this.asking = false;
        else L.picked = new Set();
      } else if (ch === "c") this.copyLines(cx);
      else if (ch === "a") { this.asking = true; this.askInput.focus(); }
      else if (k === "escape" || k === "backspace" || ch === "q") {
        if (L.q) { this.search.set_value(""); L.q = ""; L.match = -1; } else this.back(cx);
      } else if (ch === "/") this.search.focus();
      else if (ch === "n") this.step(1);
      else if (ch === "N") this.step(-1);
      else if (ch === "f") L.filterOnly = !L.filterOnly;
      else if (ch === "e") this.setLogOpt("level", nextLevel(L.level));
      else if (ch === " " || ch === "p") this.toggleFollow(cx);
      else if (ch === "t") this.setLogOpt("ts", !L.ts);
      else if (ch === "w") this.setLogOpt("wrap", !L.wrap);
      else if (ch === "G" || k === "end") { this.stick = true; }
      else if (ch === "g" || k === "home") { this.stick = false; this.logTop = 0; }
      else if (ch >= "1" && ch <= String(SINCE.length)) this.setSince(SINCE[Number(ch) - 1], cx);
      else if (ch === "r") this.reload(cx);
      else return;
      return stop();
    }

    if (this.confirm) {
      if (k === "enter") this.accept(cx);
      else if (k === "escape") { this.confirm = null; }
      else return;
      return stop();
    }
    const rows = this.rows(), r = rows[this.at];
    if (mod.control) {
      if (k === "d") { this.move(15, cx); return stop(); }
      if (k === "u") { this.move(-15, cx); return stop(); }
      return;
    }
    if (k === "down" || ch === "j") this.move(1, cx);
    else if (k === "up" || ch === "k") this.move(-1, cx);
    else if (k === "pagedown") this.move(15, cx);
    else if (k === "pageup") this.move(-15, cx);
    else if (ch === "g" || k === "home") this.move(-1e9, cx);
    else if (ch === "G" || k === "end") this.move(1e9, cx);
    else if (ch >= "1" && ch <= String(KINDS.length)) this.setKind(KINDS[Number(ch) - 1].id, cx);
    else if (ch === "l" || k === "enter") this.open(r, cx);
    else if (ch === "d") this.inspect(r, "describe", cx);
    else if (ch === "y") { this.setTab("yaml", cx); if (!this.panel.open) this.togglePanel(cx); }
    else if (ch === "o") { this.setTab("overview", cx); if (!this.panel.open) this.togglePanel(cx); }
    else if (ch === "v") { this.setTab("events", cx); if (!this.panel.open) this.togglePanel(cx); }
    else if (ch === "p" || k === "space" || ch === " ") this.togglePanel(cx);
    else if (ch === "s") this.shell(r);
    else if (ch === "R" || ch === "S" || ch === "X") {
      const id = { R: r?.kind === "nodes" ? "cordon" : "restart", S: "scale", X: "delete" }[ch];
      this.actions(r).find(([a]) => a === id)?.[2](cx);
    }
    else if (ch === "r") this.refresh(cx, { force: true });
    else if (ch === "a") this.setAllNs(!this.allNs, cx);
    else if (ch === "/") this.input.focus();
    else if (k === "escape") {
      if (this.showSettings) this.showSettings = false;
      else if (this.panel.open) this.setPanel(false, cx);
      else if (this.filter) this.setFilter("", true);
      else this.hide();
    }
    else return;
    stop();
  }

  // ---------------------------------------------------------------- render
  chip(t, id, label, on, onClick, color) {
    return div().id(id).px(8).py(3).rounded(6).cursor_pointer().text_size(12)
      .when(on, (el) => el.bg(t.selected).text_color(color ?? t.foreground).font_semibold())
      .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(lbl(label));
  }

  // Bordered button with an optional hotkey badge .
  btn(t, id, label, onClick, o = {}) {
    const on = Boolean(o.active);
    return div().id(id).flex_none().h(24).px(9).flex().items_center().gap(5).rounded(6).cursor_pointer()
      .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised).text_size(11.5).text_color(t.foreground)
      .hover((s) => s.bg(on ? t.selected : t.hover))
      .when(Boolean(o.tooltip), (el) => el.tooltip(o.tooltip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .when(Boolean(o.icon), (el) => el.child(glyph(t.muted, o.icon)))
      .when(label !== "", (el) => el.child(div().child(lbl(label))))
      .when(Boolean(o.hotkey), (el) => el.child(div().px(3).rounded(3).bg(t.background).text_size(10).text_color(t.dim).child(o.hotkey)));
  }

  // Segmented control: the selected item is solid, each item can carry its hotkey.
  seg(t, id, items) {
    return h_flex().id(id).flex_none().p(2).gap(2).rounded(7).bg(t.surface).border_1().border_color(t.border)
      .children(items.map(([key, label, on, onClick, hotkey, icon]) => h_flex().id(`${id}-${key}`).h(22).px(9).gap(6).items_center().rounded(5).text_size(11.5).cursor_pointer()
        .when(on, (e) => e.bg(t.solid).text_color(t.solid_foreground).font_semibold())
        .when(!on, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { onClick(cx); cx.notify(); })
        .when(Boolean(icon), (el) => el.child(glyph(on ? t.solid_foreground : t.dim, icon)))
        .child(label)
        .when(Boolean(hotkey), (el) => el.child(div().text_size(9.5).text_color(on ? t.solid_foreground : t.dim).child(hotkey)))));
  }

  // ⚙ opens a card under it: one row per context with a read-only switch.
  settingsPopup(t, ctxColor) {
    const trigger = this.btn(t, "settings", "", () => { this.showSettings = !this.showSettings; }, { active: Boolean(this.showSettings), tooltip: "Which contexts allow changes", icon: ICONS.settings });
    const row = (c) => {
      const ro = this.isReadOnly(c);
      return h_flex().id(`ro-${c}`).h(34).px(10).gap(10).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.setReadOnly(c, !ro); cx.notify(); })
        .child(div().w(8).h(8).flex_none().rounded(4).bg(ctxColor(c)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(c))
        .child(div().w(70).flex_none().text_size(11).text_color(ro ? t.ansi1 : t.ansi2).child(ro ? lbl(`${ICONS.lock} read-only`) : "writable"))
        .child(div().w(30).h(16).flex_none().rounded(8).p(2).flex().items_center()
          .when(ro, (el) => el.justify_start().bg(t.surface).border_1().border_color(t.border))
          .when(!ro, (el) => el.justify_end().bg(t.ansi2))
          .child(div().w(10).h(10).rounded(5).bg(ro ? t.dim : t.background)));
    };
    return Popup.new("settings-popup", trigger).anchor("top_right")
      .when(Boolean(this.showSettings), (el) => el.content(v_flex().id("settings-card").mt(6).w(380).p(6).gap(2).rounded(10)
        .bg(t.popover ?? t.surface).border_1().border_color(t.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(v_flex().px(10).pt(6).pb(8).gap(2)
          .child(div().font_semibold().text_size(12.5).text_color(t.foreground).child("Changes allowed"))
          .child(div().text_size(11).text_color(t.dim).child("Restart, scale and delete only run on writable contexts. Contexts with “prod” start read-only.")))
        .child(div().h(1).mx(4).mb(4).bg(t.border))
        .children(this.contexts.map(row))
        .when(!this.contexts.length, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child("No contexts in kubeconfig")))));
  }

  windowButtons(t) {
    if (!props()?.overlay) return div();
    return h_flex().gap(4).items_center()
      .child(this.btn(t, "as-split", `${ICONS.split} Split`, () => this.detach("split"), { tooltip: "Dock beside the focused pane" }))
      .child(this.btn(t, "as-tab", `${ICONS.tab} Tab`, () => this.detach("tab"), { tooltip: "Open as a tab" }))
      .child(this.closeButton(t));
  }

  closeButton(t) {
    return div().id("close").w(24).h(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.hide()).child(glyph(null, ICONS.close));
  }

  // A read-only editor whose presses select text instead of dragging the window.
  textArea(id, state) {
    return div().id(id).flex_1().min_h(0).flex().flex_col()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Editor.new(state).flex_1().min_h(0));
  }

  hints(t, list) {
    return list.map(([k, w]) => h_flex().gap(4).child(div().text_color(t.muted).child(k)).child(w));
  }

  // The filter with its completions in a dropdown pinned under it (Tab takes the first).
  filterBox(t, mono) {
    const sug = this.suggestions();
    const box = this.inputBox(t, "filter", this.input, this.typing === "list");
    return Popup.new("filter-suggest", box).anchor("top_left").flex_1().min_w(160)
      .when(sug.length > 0, (el) => el.content(v_flex().id("suggest").mt(4).min_w(260).max_w(520).p(4).rounded(8)
        .bg(t.popover ?? t.surface).border_1().border_color(t.border).text_size(12)
        .children(sug.map((w, i) => h_flex().id(`sug-${i}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(i === 0, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.complete(w, cx))
          .child(div().flex_1().min_w(0).truncate().font_family(mono).text_color(i === 0 ? t.foreground : t.muted).child(w))
          .when(i === 0, (el) => el.child(div().text_size(11).text_color(t.dim).child("tab")))))));
  }

  inputBox(t, id, state, active, min = 160) {
    return div().id(id).flex_1().min_w(min).h(28).px(10).flex().items_center().rounded(7).border_1()
      .border_color(active ? t.accent : t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => { state.focus(); cx.stop_propagation(); })
      .child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground));
  }

  renderList(t, mono) {
    const kind = this.kindDef(), rows = this.rows();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const tone = { ok: t.ansi2, warn: t.ansi3, bad: t.ansi1, dim: t.dim, plain: t.foreground };
    const busy = [...this.selected].some((c) => this.loading.has(this.keyOf(kind, c)));
    const errors = [...this.selected].map((c) => { const d = this.data[this.keyOf(kind, c)]; return [c, d?.error ?? d?.warn]; }).filter(([, e]) => e);
    const ctxColor = (c) => [t.ansi6, t.ansi5, t.ansi4, t.ansi3, t.ansi2, t.ansi1][Math.max(0, this.contexts.indexOf(c)) % 6];
    const cell = (w, text, color) => div().w(w).flex_none().pr(10).truncate().text_color(color ?? t.dim).child(text || "");
    return [
      h_flex().flex_none().flex_wrap().px(12).pt(10).pb(6).gap(6).items_center()
        .child(glyph(t.accent, ICONS.k8s))
        .child(div().font_semibold().pr(4).child("Kubernetes"))
        .children(this.contexts.map((c) => {
          const on = this.selected.has(c);
          return h_flex().id(`ctx-${c}`).h(24).px(9).gap(6).items_center().rounded(12).cursor_pointer().text_size(12)
            .border_1().border_color(on ? ctxColor(c) : t.border).text_color(on ? t.foreground : t.dim)
            .when(on, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.toggleContext(c, cx))
            .child(div().w(7).h(7).rounded(4).bg(on ? ctxColor(c) : t.border)).child(c);
        }))
        .child(div().flex_1())
        .when(busy, (el) => el.child(div().text_size(12).text_color(t.dim).frames(SPIN, 90).child("⠋")))
        .child(this.btn(t, "refresh", "Refresh", (cx) => this.refresh(cx, { force: true }), { hotkey: "r", icon: ICONS.refresh }))
        .child(this.settingsPopup(t, ctxColor))
        .child(this.windowButtons(t)),

      h_flex().flex_none().flex_wrap().px(12).pb(8).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.seg(t, "kind", KINDS.map((k, i) => [k.id, k.label, k.id === this.kind, (cx) => this.setKind(k.id, cx), String(i + 1), ICONS[k.id]])))
        .child(div().w(6))
        .child(this.seg(t, "ns", [
          ["default", "default ns", !this.allNs, (cx) => this.setAllNs(false, cx)],
          ["all", "all ns", this.allNs, (cx) => this.setAllNs(true, cx), "a"],
        ]))
        .child(div().w(6))
        .child(this.filterBox(t, mono))
        .child(div().pl(8).text_size(12).text_color(t.dim).child(`${rows.length}`)),
      h_resizable("k8s-split").flex_1().min_h(0).child(resizable_panel().child(v_flex().size_full().min_h(0).child(
      h_flex().h(26).flex_none().px(12).items_center().text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
        .child(cell(18, "")).child(cell(96, "CONTEXT")).when(!kind.cluster, (el) => el.child(cell(150, "NAMESPACE")))
        .child(div().flex_1().min_w(180).pr(10).child("NAME"))
        .children(kind.cols.map(([n, w]) => cell(w, n))).child(cell(50, "AGE"))).child(
      div().id("list-area").flex_1().min_h(0).relative().font_family(mono).text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(v_virtual_list("k8s-rows", rows.length, 24, (i) => rowKey(rows[i]), (range) =>
          rows.slice(range.start, range.end).map((r, j) => {
            const i = range.start + j, sel = i === this.at;
            return h_flex().h(24).px(12).items_center().when(sel, (el) => el.bg(t.selected)).when(!sel && i % 2, (el) => el.bg(t.surface))
              .child(cell(18, "●", tone[r.tone] ?? t.dim))
              .child(cell(96, r.ctx, ctxColor(r.ctx)))
              .when(!kind.cluster, (el) => el.child(cell(150, r.ns, t.muted)))
              .child(div().flex_1().min_w(180).pr(10).truncate().text_color(t.foreground).when(sel, (el) => el.font_semibold()).child(r.name))
              .children(r.cols.map((v, ci) => cell(kind.cols[ci][1], v,
                ci === 0 || (r.kind === "pods" && ci === 1) ? tone[r.tone] : r.kind === "pods" && ci === 2 && r.restarts > 0 ? t.ansi3 : t.muted)))
              .child(cell(50, r.age, t.dim));
          })).track_scroll(this.scroll).size_full()
          .on_item_click((key, cx) => {
            const rows = this.rows(), idx = rows.findIndex((r) => rowKey(r) === key);
            if (idx >= 0) {
              // One click: select it and show the panel. The same row again: hide the
              // panel. Twice quickly: its logs (the panel is left as it was).
              const same = idx === this.at, double = same && this.lastClick && Date.now() - this.lastClick < 400;
              this.lastClick = double ? 0 : Date.now();
              if (double) { this.panel.open = this.panelBefore; this.open(rows[idx], cx); }
              else {
                this.panelBefore = this.panel.open;
                this.select(idx);
                this.setPanel(same ? !this.panel.open : true, cx);
              }
            }
            this.handle.focus(); cx.notify();
          }))
        .child(Scrollbar.vertical("k8s-rows").viewport_from_layout().absolute().inset_0())
        .when(!rows.length, (el) => el.child(div().absolute().top(10).left(12).text_color(t.dim)
          .child(!this.selected.size ? "Pick a context above" : busy ? "Loading…" : this.filter ? "No match" : "Nothing here"))))))
        .child(resizable_panel().size(560).visible(this.panel.open).child(this.panel.open ? this.renderPanel(t, mono) : div())),
      h_flex().flex_none().h(26).px(12).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .when(errors.length > 0, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.ansi1).child(errors.map(([c, e]) => `${c}: ${e}`).join("   "))))
        .when(!errors.length && Boolean(this.note), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.ansi3).child(lbl(this.note))))
        .when(!errors.length && !this.note, (el) => el.child(div().flex_1()))
        .children(this.hints(t, [["/", "filter"], ["1-5", "kind"], ["a", "all ns"], ["↵", "logs"], ["space", "panel"], ["o/v/y", "tabs"], ["s", "shell"], ["R", "restart"], ["S", "scale"], ["X", "delete pod"], ["esc", "back"]])),
    ];
  }

  renderLogs(t, mono) {
    const L = this.log;
    const { lines, matches, q, key: linesKey } = visibleLines(L);
    const pods = Object.entries(L.pods);
    const showPod = pods.length > 1 || L.kind !== "pods";
    const width = this.size?.width ?? 1200;
    const prefixW = (L.ts ? 100 : 0) + (showPod ? 64 : 0) + 30;
    const cols = Math.max(20, Math.floor((width - prefixW) / CHAR_W));
    const lay = this.lay = layout(L, lines, linesKey, cols, L.wrap, this.logH);
    const active = L.match >= 0 ? matches[L.match] : -1;
    const lvColor = { err: t.ansi1, warn: t.ansi3, debug: t.dim, info: t.foreground };
    const short = (p) => p.split("-").pop();

    // The pieces of a line are cached on it (see lineParts); only the divs are made here.
    const themeKey = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6, t.dim, t.foreground].join();
    const po = { t, themeKey, q, cols, wrap: L.wrap, colors: lvColor };
    const row = (l, i) => {
      const words = lineParts(l, po).map(([p, c, hl]) => div().flex_none().text_color(c)
        .when(hl, (el) => el.bg(i === active ? t.accent : t.ansi3 + "55").when(i === active, (e) => e.text_color(t.accent_foreground)))
        .child(p));
      return h_flex().w_full().h(lay.heights[i]).overflow_hidden().items_start().pl(10).pr(12).gap(8).border_l(2)
        .border_color(l.level === "err" ? t.ansi1 : l.level === "warn" ? t.ansi3 + "aa" : "#00000000")
        .when(l.level === "err", (el) => el.bg(t.ansi1 + "14"))
        .when(Boolean(L.picked?.has(l)), (el) => el.bg(t.selection ?? t.selected))
        .when(L.ts, (el) => el.child(div().w(92).flex_none().text_color(t.dim).child(l.time)))
        .when(showPod, (el) => el.child(div().w(56).flex_none().truncate().text_color(L.pods[l.pod]?.color ?? t.muted).child(short(l.pod))))
        .child(L.wrap ? h_flex().flex_1().min_w(0).flex_wrap().children(words) : h_flex().flex_1().min_w(0).overflow_hidden().children(words));
    };

    const titleKind = { pods: "pod", deploy: "deploy", svc: "svc" }[L.kind];
    return [
      h_flex().flex_none().px(12).pt(10).pb(6).gap(8).items_center()
        .child(this.btn(t, "back", `${ICONS.back} Back`, (cx) => this.back(cx), { hotkey: "esc" }))
        .child(div().font_semibold().child(`${titleKind}/${L.name}`))
        .child(div().text_size(12).text_color(t.dim).child(`${L.ctx} · ${L.ns}`))
        .child(div().flex_1())
        .when(!L.loaded, (el) => el.child(div().text_size(12).text_color(t.dim).frames(SPIN, 90).child("⠋")))
        .child(div().text_size(12).text_color(L.follow && !L.previous ? t.ansi2 : t.dim).child(lbl(L.previous ? "previous container" : L.follow ? `${ICONS.live} live` : `${ICONS.pause} paused`)))
        .child(this.windowButtons(t)),
      h_flex().flex_none().flex_wrap().px(12).pb(6).gap(4).items_center()
        .child(this.seg(t, "since", SINCE.map((s, i) => [s, s === "tail" ? `tail ${TAIL}` : s, L.since === s, (cx) => this.setSince(s, cx), String(i + 1)])))
        .child(div().w(10))
        .child(this.chip(t, "follow", L.follow ? `${ICONS.pause} pause` : `${ICONS.follow} follow`, false, (cx) => this.toggleFollow(cx)))
        .when(L.kind === "pods", (el) => el.child(this.chip(t, "prev", "previous", L.previous, (cx) => { L.previous = !L.previous; this.reload(cx); })))
        .child(this.chip(t, "ts", "time", L.ts, () => this.setLogOpt("ts", !L.ts)))
        .child(this.chip(t, "wrap", "wrap", L.wrap, () => this.setLogOpt("wrap", !L.wrap)))
        .child(this.chip(t, "level", LEVELS[L.level], L.level !== "all", () => this.setLogOpt("level", nextLevel(L.level)), L.level === "err" ? t.ansi1 : t.ansi3))
        .child(this.chip(t, "clear", "clear", false, () => { L.lines = []; L.version++; })),
      h_flex().flex_none().px(12).pb(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(this.inputBox(t, "log-search", this.search, this.typing === "search", 200))
        .child(this.chip(t, "filter-only", "only matches", L.filterOnly, () => { L.filterOnly = !L.filterOnly; L.match = -1; }))
        .child(div().w(70).text_size(12).text_color(t.dim).child(q && !L.filterOnly ? (matches.length ? `${L.match >= 0 ? L.match + 1 : "–"}/${matches.length}` : "0") : `${lines.length}`))
        .child(this.chip(t, "prev-match", ICONS.up, false, () => this.step(-1)))
        .child(this.chip(t, "next-match", ICONS.down, false, () => this.step(1)))
        .child(div().w(8))
        .when(Boolean(L.picked?.size), (el) => el
          .child(div().text_size(12).text_color(t.accent).child(`${L.picked.size} picked`))
          .child(this.chip(t, "unpick", ICONS.close, false, () => { L.picked = new Set(); })))
        .child(this.chip(t, "copy", L.picked?.size ? "Copy" : "Copy all", false, (cx) => this.copyLines(cx)))
        .child(this.chip(t, "ask", `${ICONS.ask} Ask agent`, this.asking, () => { this.asking = !this.asking; if (this.asking) this.askInput.focus(); else this.handle.focus(); })),
      this.asking ? h_flex().flex_none().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(12).text_color(t.muted).child(`Ask about ${L.picked?.size ? `${L.picked.size} picked lines` : `${lines.length} shown lines`}`))
        .child(this.inputBox(t, "ask-input", this.askInput, this.typing === "ask", 240))
        .child(this.chip(t, "ask-new", "New session ↵", false, (cx) => this.sendAsk(cx, "new")))
        .child(this.chip(t, "ask-current", "Current session", false, (cx) => this.sendAsk(cx, "current"))) : div(),
      pods.length > 1 ? h_flex().flex_none().flex_wrap().px(12).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .children(pods.map(([p, info]) => {
          const off = L.hidden.has(p);
          return h_flex().id(`pod-${p}`).h(22).px(8).gap(6).items_center().rounded(11).cursor_pointer().text_size(11)
            .border_1().border_color(off ? t.border : info.color).text_color(off ? t.dim : t.foreground)
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { if (off) L.hidden.delete(p); else L.hidden.add(p); cx.notify(); })
            .child(div().w(7).h(7).rounded(4).bg(off ? t.border : info.color)).child(p).child(div().text_color(t.dim).child(String(info.n)));
        })) : div(),
      // Scrolled by hand (not a virtual list) so a drag can tell which line is
      // under the pointer and following knows when it is at the end.
      div().id("log-area").flex_1().min_h(0).relative().overflow_hidden().font_family(mono).text_size(12)
        .on_size_change((size, cx) => { if (Math.abs(size.height - this.logH) > 1) { this.logH = size.height; cx.notify(); } })
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressLine(e, lines); this.handle.focus(); cx.notify(); })
        .on_mouse_move((e, cx) => {
          if (this.thumb) {
            const lay = this.lay, span = Math.max(1, this.logH - this.thumb.h);
            this.logTop = Math.max(0, Math.min(lay.maxTop, this.thumb.top + (e.position.y - this.thumb.y) * (lay.maxTop / span)));
            this.stick = this.logTop >= lay.maxTop - 2;
            cx.notify();
          } else if (this.dragLine(e, lines)) cx.notify();
        })
        .on_mouse_up("left", (_e, cx) => { this.releaseLine(); cx.notify(); })
        .on_scroll_wheel((e, cx) => {
          const lay = this.lay;
          if (!lay) return;
          this.logTop = Math.max(0, Math.min(lay.maxTop, this.logTop - (e.delta?.y ?? 0)));
          // Back at the end: follow again.
          this.stick = this.logTop >= lay.maxTop - 2;
          cx.notify();
        })
        .children((() => {
          if (this.stick) this.logTop = lay.maxTop;
          this.logTop = Math.max(0, Math.min(lay.maxTop, this.logTop));
          const out = [];
          for (let i = Math.max(0, indexAt(lay, this.logTop)); i < lay.n && lay.tops[i] < this.logTop + this.logH; i++)
            out.push(row(lines[i], i).absolute().left(0).right(0).top(lay.tops[i] - this.logTop));
          if (lay.total > this.logH) {
            const h = Math.max(24, (this.logH * this.logH) / lay.total), top = lay.maxTop ? (this.logTop / lay.maxTop) * (this.logH - h) : 0;
            out.push(div().id("log-thumb").absolute().right(2).w(6).rounded(3).top(top).h(h).bg(t.border).hover((s) => s.bg(t.muted))
              .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.thumb = { y: e.position.y, top: this.logTop, h }; }));
          }
          return out;
        })())
        .when(!lines.length, (el) => el.child(div().absolute().top(10).left(12).text_color(t.dim)
          .child(!L.loaded ? "Loading logs…" : L.lines.length ? "No line matches" : "No logs in this range")))
        .when(!this.stick && L.follow, (el) => el.child(div().id("to-bottom").absolute().bottom(10).right(20).px(10).py(4).rounded(12)
          .bg(t.solid).text_color(t.solid_foreground).text_size(12).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.stick = true; cx.notify(); }).child(lbl(`${ICONS.down} latest (G)`)))),
      h_flex().flex_none().h(26).px(12).gap(14).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().text_color(L.error ? t.ansi1 : t.dim).child(L.error ?? `${L.lines.length} lines`))
        .children(this.hints(t, [["/", "search"], ["n/N", "match"], ["f", "only"], ["e", "level"], ["1-7", "since"], ["space", "pause"], ["t", "time"], ["w", "wrap"], ["c", "copy"], ["a", "ask"], ["esc", "back"]])),
    ];
  }

  renderText(t) {
    const x = this.text;
    return [
      h_flex().flex_none().px(12).pt(10).pb(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.btn(t, "back", `${ICONS.back} Back`, (cx) => this.back(cx), { hotkey: "esc" }))
        .child(div().font_semibold().child(x.title))
        .child(div().text_size(12).text_color(t.dim).child(x.sub))
        .child(div().flex_1())
        .child(this.windowButtons(t)),
      x.editor ? this.textArea("text-view", x.editor)
        : div().flex_1().p(12).text_color(x.error ? t.ansi1 : t.dim).child(x.error ?? "Loading…"),
    ];
  }

  render(cx) {
    const t = theme(), mono = settings().font_family ?? "JetBrains Mono";
    if (this.view === "logs" && !this.log) this.view = "list";
    if (this.view === "text" && !this.text) this.view = "list";
    const body = this.view === "logs" ? this.renderLogs(t, mono) : this.view === "text" ? this.renderText(t) : this.renderList(t, mono);
    return v_flex().id("k8s").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs((this.size?.width ?? 0) - size.width) > 4) { this.size = size; cx.notify(); } })
      .track_focus(this.handle).on_key_down((e, cx) => {
        if (this.typing) {
          if (e.key === "escape") {
            if (this.typing === "scale") this.confirm = null;
            else if (this.typing === "ask") this.asking = false;
            else if (this.typing === "list" && this.panel.open) this.panel.open = false;
            else if (this.typing === "list" && !this.filter) this.hide();
            this.leaveInput(cx); cx.stop_propagation();
          }
          else if (e.key === "tab" && this.typing === "list") { const s = this.suggestions(); if (s.length) { this.complete(s[0], cx); cx.stop_propagation(); } }
          else if ((e.key === "down" || e.key === "up") && this.typing === "list") { this.move(e.key === "down" ? 1 : -1, cx); cx.stop_propagation(); }
          return;
        }
        this.key(e, cx);
      })
      .on_mouse_down("left", () => { if (!this.typing) this.handle.focus(); })
      .on_mouse_up("left", () => { if (this.drag || this.thumb) this.releaseLine(); })
      .children(body);
  }
}
