// The side panel's data and drawing: one resource's overview (facts, usage,
// containers, pods, rules ...), its events, and its YAML. Data comes through
// the read-only proxy (`api` from main.js); nothing here changes the cluster.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// ------------------------------------------------------------------ units
export function cpuMilli(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  if (s.endsWith("n")) return parseFloat(s) / 1e6;
  if (s.endsWith("u")) return parseFloat(s) / 1e3;
  if (s.endsWith("m")) return parseFloat(s);
  return parseFloat(s) * 1000;
}
const MEM = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12, k: 1e3, m: 1e-3 };
export function memBytes(v) {
  if (v === undefined || v === null || v === "") return null;
  const m = /^([0-9.e+-]+)([A-Za-z]*)$/.exec(String(v));
  return m ? parseFloat(m[1]) * (MEM[m[2]] ?? 1) : null;
}
export const fmtCpu = (m) => (m === null || m === undefined ? "–" : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)}` : `${Math.round(m)}m`);
export const fmtMem = (b) => (b === null || b === undefined ? "–" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}Gi` : `${Math.round(b / 1024 ** 2)}Mi`);
export function ago(ts) {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (!isFinite(s)) return "";
  if (s < 90) return `${Math.max(0, Math.round(s))}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const selectorOf = (m) => Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join(",");

// ------------------------------------------------------------------ yaml
const PLAIN = /^[A-Za-z0-9_./@-][A-Za-z0-9_ ./@:=-]*$/;
function scalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "string") return String(v);
  if (v === "" || !PLAIN.test(v) || /^(true|false|null|yes|no|on|off|[0-9.+-]+)$/i.test(v) || v.includes(": ") || v.endsWith(":")) return JSON.stringify(v);
  return v;
}
export function toYaml(v, ind = "") {
  if (Array.isArray(v)) {
    if (!v.length) return " []";
    return v.map((x) => {
      if (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length) {
        const body = toYaml(x, ind + "  ").replace(/^\n/, "");
        return `\n${ind}- ${body.slice(ind.length + 2)}`;
      }
      return `\n${ind}-${toYaml(x, ind + "  ")}`;
    }).join("");
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return " {}";
    return keys.map((k) => `\n${ind}${scalar(k)}:${toYaml(v[k], ind + "  ")}`).join("");
  }
  if (typeof v === "string" && v.includes("\n")) return ` |\n${v.replace(/\n$/, "").split("\n").map((l) => ind + l).join("\n")}`;
  return ` ${scalar(v)}`;
}
export function yamlOf(obj) {
  // Shallow copies of the parts that change; the rest is shared, not cloned.
  const o = { ...(obj ?? {}) };
  if (o.metadata) {
    const { managedFields, ...md } = o.metadata;
    if (md.annotations?.["kubectl.kubernetes.io/last-applied-configuration"]) {
      const { ["kubectl.kubernetes.io/last-applied-configuration"]: _, ...ann } = md.annotations;
      md.annotations = ann;
    }
    o.metadata = md;
  }
  return toYaml(o).replace(/^\n/, "") + "\n";
}

// ------------------------------------------------------------------ data
const PATHS = {
  pods: (ns, n) => `/api/v1/namespaces/${ns}/pods/${n}`,
  deploy: (ns, n) => `/apis/apps/v1/namespaces/${ns}/deployments/${n}`,
  nodes: (_ns, n) => `/api/v1/nodes/${n}`,
  svc: (ns, n) => `/api/v1/namespaces/${ns}/services/${n}`,
  ing: (ns, n) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${n}`,
};
const json = async (api, ctx, path) => (await api(ctx, path)).json();
const quiet = (p) => p.catch(() => null);

// Events change slowly and only the Events tab and the tab's warning count show
// them, so a refresh reads them at most this often unless that tab is shown.
const EVENTS_AGE = 45000;
const EVENTS_RETRY = 30000; // after a failed events read

// Everything the panel shows for one row; metrics are optional (no metrics-server: no usage).
// A first load (no `prev`) reads everything. A refresh of the same row (`prev` and
// the shown `tab`) reads only what that tab shows and keeps the rest of `prev`:
// overview: the object, pods and metrics; yaml: the object; events: the events.
// Events are also re-read when `prev`'s are older than EVENTS_AGE.
export async function loadDetail(api, r, { tab, prev } = {}) {
  const { ctx, ns, name, kind } = r;
  const now = Date.now();
  const need = !prev ? { obj: true, usage: true, events: true } : {
    obj: tab !== "events",
    usage: tab === "overview",
    // After a failed read (e.g. no RBAC on events) wait before retrying, even on the Events tab.
    events: now - (prev.eventsFailAt ?? 0) > EVENTS_RETRY && (tab === "events" || now - (prev.eventsAt ?? 0) > EVENTS_AGE),
  };
  const obj = need.obj ? await json(api, ctx, PATHS[kind](ns, name)) : prev.obj;
  const d = prev ? { ...prev, obj, at: now } : { obj, pods: [], podUsage: {}, nodeUsage: null, events: [], eventsAt: 0, at: now };
  let podSel = null;
  // The list row's selector (from the API's table) also covers matchExpressions.
  if (kind === "deploy") podSel = r.selector || selectorOf(obj.spec?.selector?.matchLabels);
  if (kind === "svc") podSel = r.selector || selectorOf(obj.spec?.selector);
  const jobs = [];
  if (need.usage) {
    // Built apart and swapped in whole, so a failed read leaves the shown data alone.
    const pods = [], podUsage = {};
    let nodeUsage = null;
    if (kind === "pods") {
      jobs.push(quiet(json(api, ctx, `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods/${name}`)).then((m) => { if (m) podUsage[name] = usage(m); }));
    } else if (podSel) {
      jobs.push(json(api, ctx, `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(podSel)}`).then((l) => { pods.push(...(l.items ?? [])); }));
      jobs.push(quiet(json(api, ctx, `/apis/metrics.k8s.io/v1beta1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(podSel)}`))
        .then((l) => { for (const m of l?.items ?? []) podUsage[m.metadata.name] = usage(m); }));
    } else if (kind === "nodes") {
      jobs.push(json(api, ctx, `/api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${name},status.phase!=Succeeded,status.phase!=Failed`)}`).then((l) => { pods.push(...(l.items ?? [])); }));
      jobs.push(quiet(json(api, ctx, `/apis/metrics.k8s.io/v1beta1/nodes/${name}`)).then((m) => {
        if (m) nodeUsage = { cpu: cpuMilli(m.usage?.cpu), mem: memBytes(m.usage?.memory) };
      }));
    }
    jobs.push(Promise.all(jobs.slice()).then(() => { d.pods = pods; d.podUsage = podUsage; d.nodeUsage = nodeUsage; }));
  }
  if (need.events) {
    // A failed read keeps the events already shown and leaves eventsAt alone; retried after EVENTS_RETRY.
    const events = (path, keep) => quiet(json(api, ctx, path)).then((l) => {
      if (!l) { d.eventsNote = EVENTS_FAIL; d.eventsFailAt = now; return; }
      d.events = (l.items ?? []).filter(keep).sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
      d.eventsAt = now; d.eventsNote = null;
    });
    if (kind === "deploy") {
      // A deployment's story is mostly in its ReplicaSets' and pods' events (name-xxxx).
      jobs.push(deployEvents(api, ctx, ns, name, podSel).then(({ items, note }) => {
        d.eventsNote = note ?? null;
        if (!items) { d.eventsFailAt = now; return; } // everything failed: keep the previous events, retry later
        d.events = items.sort((a, b) => eventTime(b).localeCompare(eventTime(a)));
        d.eventsAt = now;
      }));
    } else {
      const scope = kind === "nodes" ? "" : `/namespaces/${ns}`;
      jobs.push(events(`/api/v1${scope}/events?fieldSelector=${encodeURIComponent(`involvedObject.name=${name}`)}`, () => true));
    }
  }
  await Promise.all(jobs);
  return d;
}
// A deployment's events: its own, its ReplicaSets' and its pods'. Asked of the server by
// involvedObject.name (a namespace-wide list with a limit can miss them in a busy
// namespace), one request per name, a few at a time. Falls back to a namespace-wide list.
// Returns { items, note }: items is null when every read failed (the caller keeps the
// previous events); note is a short error text when some or all reads failed.
const EVENTS_FAIL = "Could not read events (showing the last ones read)";
const EVENT_NAMES = 40, EVENT_PARALLEL = 6;
export async function deployEvents(api, ctx, ns, name, podSel) {
  const sel = podSel ? `?labelSelector=${encodeURIComponent(podSel)}` : "";
  const [rs, pods] = await Promise.all([
    quiet(json(api, ctx, `/apis/apps/v1/namespaces/${ns}/replicasets${sel}`)),
    quiet(json(api, ctx, `/api/v1/namespaces/${ns}/pods${sel}`)),
  ]);
  const mine = (o) => (o.metadata?.ownerReferences ?? []).some((r) => r.kind === "Deployment" && r.name === name) || o.metadata?.name?.startsWith(name + "-");
  const names = [name, ...(rs?.items ?? []).filter(mine).map((o) => o.metadata.name), ...(pods?.items ?? []).map((o) => o.metadata.name)];
  const uniq = [...new Set(names)].slice(0, EVENT_NAMES);
  if (!rs && !pods) {
    const l = await quiet(json(api, ctx, `/api/v1/namespaces/${ns}/events?limit=500`));
    if (!l) return { items: null, note: EVENTS_FAIL };
    return { items: (l.items ?? []).filter((e) => e.involvedObject?.name === name || e.involvedObject?.name?.startsWith(name + "-")) };
  }
  const out = new Map();
  let next = 0, failed = 0;
  const worker = async () => {
    while (next < uniq.length) {
      const n = uniq[next++];
      const l = await quiet(json(api, ctx, `/api/v1/namespaces/${ns}/events?fieldSelector=${encodeURIComponent(`involvedObject.name=${n}`)}`));
      if (!l) failed++;
      for (const e of l?.items ?? []) out.set(e.metadata?.uid ?? `${n}/${e.metadata?.name}`, e);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EVENT_PARALLEL, uniq.length) }, worker));
  if (uniq.length && failed === uniq.length) return { items: null, note: EVENTS_FAIL };
  return { items: [...out.values()], ...(failed ? { note: `${failed} of ${uniq.length} event reads failed` } : {}) };
}
function usage(m) {
  const ctr = {};
  let cpu = 0, mem = 0;
  for (const c of m.containers ?? []) {
    const u = { cpu: cpuMilli(c.usage?.cpu) ?? 0, mem: memBytes(c.usage?.memory) ?? 0 };
    ctr[c.name] = u; cpu += u.cpu; mem += u.mem;
  }
  return { cpu, mem, ctr };
}
const eventTime = (e) => e.lastTimestamp || e.eventTime || e.metadata?.creationTimestamp || "";
function resources(containers) {
  let rc = 0, rm = 0, lc = 0, lm = 0, lcSet = true, lmSet = true;
  for (const c of containers ?? []) {
    rc += cpuMilli(c.resources?.requests?.cpu) ?? 0; rm += memBytes(c.resources?.requests?.memory) ?? 0;
    const a = cpuMilli(c.resources?.limits?.cpu), b = memBytes(c.resources?.limits?.memory);
    if (a === null) lcSet = false; else lc += a;
    if (b === null) lmSet = false; else lm += b;
  }
  return { rc, rm, lc: lcSet ? lc : null, lm: lmSet ? lm : null };
}
export function podState(p) {
  const st = p.status ?? {};
  const cs = st.containerStatuses ?? [];
  const ready = cs.filter((c) => c.ready).length;
  const restarts = cs.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  const why = p.metadata?.deletionTimestamp ? "Terminating" : st.reason || cs.map((c) => c.state?.waiting?.reason || c.state?.terminated?.reason).find(Boolean) || st.phase;
  const ok = (st.phase === "Running" && ready === cs.length && !st.reason && !p.metadata?.deletionTimestamp) || st.phase === "Succeeded";
  return { ready, total: cs.length, restarts, why, tone: ok ? "ok" : /Pending|ContainerCreating|PodInitializing|Terminating/.test(why ?? "") ? "warn" : "bad" };
}

// ------------------------------------------------------------------ drawing
export function draw(view, t, mono, r, d) {
  const tone = { ok: t.ansi2, warn: t.ansi3, bad: t.ansi1, dim: t.dim };
  const section = (title, children, hint) => v_flex().gap(4).pt(12)
    .child(h_flex().gap(8).items_center().child(div().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
      .when(Boolean(hint), (el) => el.child(div().text_size(11).text_color(t.dim).child(hint))))
    .children(children);
  const fact = (label, value, color, monoV) => h_flex().gap(10).items_start().min_h(20)
    .child(div().w(116).flex_none().text_color(t.dim).child(label))
    .child(div().flex_1().min_w(0).text_color(color ?? t.foreground).when(Boolean(monoV), (el) => el.font_family(mono).text_size(12)).child(value === undefined || value === null || value === "" ? "–" : String(value)));
  const bar = (used, total, color) => {
    const pct = total ? Math.max(0, Math.min(1, used / total)) : 0;
    const c = pct > 0.9 ? t.ansi1 : pct > 0.75 ? t.ansi3 : color ?? t.ansi4;
    return div().w(120).h(6).flex_none().rounded(3).bg(t.border).child(div().h(6).rounded(3).bg(c).w(Math.max(total ? 2 : 0, 120 * pct)));
  };
  const meter = (label, used, req, lim, fmt, cap) => h_flex().gap(10).items_center().min_h(22)
    .child(div().w(116).flex_none().text_color(t.dim).child(label))
    .child(bar(used ?? 0, cap ?? lim ?? req ?? 0))
    .child(div().font_family(mono).text_size(12).child(`${fmt(used)}`))
    .child(div().text_size(11).text_color(t.dim).child(
      cap ? `of ${fmt(cap)}${req ? ` · requested ${fmt(req)}` : ""}` : `req ${req ? fmt(req) : "–"} · limit ${lim ? fmt(lim) : "none"}`));
  const chips = (obj) => h_flex().flex_wrap().gap(4).children(Object.entries(obj ?? {}).map(([k, v]) =>
    div().px(6).py(1).rounded(4).bg(t.raised).text_size(11).font_family(mono).text_color(t.muted).child(`${k}=${v}`)));
  const md = d.obj.metadata ?? {}, spec = d.obj.spec ?? {}, status = d.obj.status ?? {};
  const out = [];

  // Fits the panel's narrowest width (~360px): fixed columns never shrink, the name takes the rest.
  const COL = { dot: 8, ready: 36, status: 58, rst: 20, cpu: 36, mem: 44, age: 28 };
  const col = (w) => div().w(w).flex_none();
  const podRows = (pods, showNode) => pods.slice(0, 60).map((p) => {
    const s = podState(p), u = d.podUsage[p.metadata.name];
    return h_flex().id(`dp-${p.metadata.namespace}/${p.metadata.name}`).h(26).px(4).gap(4).items_center().rounded(6).cursor_pointer().hover((el) => el.bg(t.hover))
      .on_click((_e, cx) => view.openPod(r.ctx, p.metadata.namespace, p.metadata.name, cx))
      .child(col(COL.dot).text_color(tone[s.tone]).child("●"))
      .child(div().flex_1().min_w(70).truncate().font_family(mono).text_size(12).child(showNode ? `${p.metadata.namespace}/${p.metadata.name}` : p.metadata.name))
      .child(col(COL.ready).text_size(12).text_color(tone[s.tone]).child(`${s.ready}/${s.total}`))
      .child(col(COL.status).truncate().text_size(12).text_color(tone[s.tone]).child(s.why ?? ""))
      .child(col(COL.rst).text_size(12).text_color(s.restarts ? t.ansi3 : t.dim).child(String(s.restarts)))
      .child(col(COL.cpu).text_size(12).font_family(mono).text_color(t.muted).child(u ? fmtCpu(u.cpu) : "–"))
      .child(col(COL.mem).text_size(12).font_family(mono).text_color(t.muted).child(u ? fmtMem(u.mem) : "–"))
      .child(col(COL.age).text_size(12).text_color(t.dim).child(ago(p.metadata.creationTimestamp)));
  });
  const podHeader = () => h_flex().px(4).gap(4).text_size(10).text_color(t.dim)
    .child(col(COL.dot)).child(div().flex_1().min_w(70).child("NAME")).child(col(COL.ready).truncate().child("READY")).child(col(COL.status).child("STATUS"))
    .child(col(COL.rst).child("RST")).child(col(COL.cpu).child("CPU")).child(col(COL.mem).child("MEM")).child(col(COL.age).child("AGE"));

  if (r.kind === "pods") {
    const s = podState(d.obj), u = d.podUsage[md.name], res = resources(spec.containers);
    const owner = (md.ownerReferences ?? [])[0];
    out.push(section("Overview", [
      fact("Status", `${s.why ?? ""}  ·  ${s.ready}/${s.total} ready`, tone[s.tone]),
      fact("Restarts", s.restarts, s.restarts ? t.ansi3 : undefined),
      fact("Node", spec.nodeName, undefined, true),
      fact("Pod IP", status.podIP, undefined, true),
      fact("Controlled by", owner ? `${owner.kind}/${owner.name}` : ""),
      fact("Service account", spec.serviceAccountName),
      fact("QoS class", status.qosClass),
      fact("Started", status.startTime ? `${ago(status.startTime)} ago` : ""),
    ]));
    out.push(section("Usage", u ? [
      meter("CPU", u.cpu, res.rc, res.lc, fmtCpu), meter("Memory", u.mem, res.rm, res.lm, fmtMem),
    ] : [div().text_color(t.dim).child("No metrics (metrics-server) for this pod")]));
    out.push(section("Containers", (spec.containers ?? []).map((c) => {
      const cs = (status.containerStatuses ?? []).find((x) => x.name === c.name) ?? {};
      const state = cs.state?.running ? `running ${ago(cs.state.running.startedAt)}` : cs.state?.waiting ? `waiting: ${cs.state.waiting.reason}` : cs.state?.terminated ? `terminated: ${cs.state.terminated.reason}` : "";
      const last = cs.lastState?.terminated;
      const cu = u?.ctr?.[c.name];
      return v_flex().gap(2).p(8).rounded(8).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_color(cs.ready ? t.ansi2 : t.ansi3).child("●"))
          .child(div().font_semibold().child(c.name))
          .child(div().text_size(12).text_color(t.dim).child(state))
          .child(div().flex_1())
          .child(div().text_size(12).text_color(cs.restartCount ? t.ansi3 : t.dim).child(`${cs.restartCount ?? 0} restarts`)))
        .child(div().font_family(mono).text_size(11).text_color(t.muted).truncate().child(c.image))
        .when(Boolean(last), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(`last exit: ${last.reason} (code ${last.exitCode}) ${ago(last.finishedAt)} ago`)))
        .child(div().text_size(11).text_color(t.dim).child(
          `cpu ${cu ? fmtCpu(cu.cpu) : "–"} (req ${c.resources?.requests?.cpu ?? "–"} / lim ${c.resources?.limits?.cpu ?? "–"})   mem ${cu ? fmtMem(cu.mem) : "–"} (req ${c.resources?.requests?.memory ?? "–"} / lim ${c.resources?.limits?.memory ?? "–"})`))
        .when(Boolean(c.ports?.length), (el) => el.child(div().text_size(11).text_color(t.dim).child(`ports ${c.ports.map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}${p.name ? ` (${p.name})` : ""}`).join(", ")}`)))
        .when(Boolean(c.readinessProbe || c.livenessProbe), (el) => el.child(div().text_size(11).text_color(t.dim).child(
          [["ready", c.readinessProbe], ["live", c.livenessProbe], ["startup", c.startupProbe]].filter(([, p]) => p)
            .map(([k, p]) => `${k}: ${p.httpGet ? `GET :${p.httpGet.port}${p.httpGet.path ?? ""}` : p.tcpSocket ? `tcp :${p.tcpSocket.port}` : p.exec ? "exec" : p.grpc ? "grpc" : "?"}`).join("   "))));
    })));
    out.push(section("Conditions", (status.conditions ?? []).map((c) => fact(c.type, `${c.status}${c.reason ? ` · ${c.reason}` : ""}`, c.status === "True" ? t.ansi2 : t.ansi3))));
  }

  if (r.kind === "deploy") {
    const want = spec.replicas ?? 0, ready = status.readyReplicas ?? 0;
    const cond = Object.fromEntries((status.conditions ?? []).map((c) => [c.type, c]));
    const total = Object.values(d.podUsage).reduce((a, u) => ({ cpu: a.cpu + u.cpu, mem: a.mem + u.mem }), { cpu: 0, mem: 0 });
    const res = resources(spec.template?.spec?.containers), n = d.pods.length || 1;
    out.push(section("Overview", [
      fact("Replicas", `${ready}/${want} ready · ${status.updatedReplicas ?? 0} up-to-date · ${status.availableReplicas ?? 0} available`, !want ? t.dim : ready >= want ? t.ansi2 : ready ? t.ansi3 : t.ansi1),
      fact("Strategy", spec.strategy?.type === "RollingUpdate" ? `RollingUpdate (surge ${spec.strategy.rollingUpdate?.maxSurge ?? "25%"}, unavailable ${spec.strategy.rollingUpdate?.maxUnavailable ?? "25%"})` : spec.strategy?.type),
      fact("Revision", md.annotations?.["deployment.kubernetes.io/revision"]),
      fact("Rollout", cond.Progressing ? `${cond.Progressing.reason}` : "", cond.Progressing?.status === "True" ? t.ansi2 : t.ansi3),
      fact("Paused", spec.paused ? "yes" : "", spec.paused ? t.ansi3 : undefined),
      fact("Selector", selectorOf(spec.selector?.matchLabels), undefined, true),
      fact("Images", (spec.template?.spec?.containers ?? []).map((c) => c.image).join("\n"), undefined, true),
    ]));
    out.push(section("Usage", d.pods.length && Object.keys(d.podUsage).length ? [
      meter("CPU (all pods)", total.cpu, res.rc * n, res.lc === null ? null : res.lc * n, fmtCpu),
      meter("Memory", total.mem, res.rm * n, res.lm === null ? null : res.lm * n, fmtMem),
    ] : [div().text_color(t.dim).child("No metrics")], `${d.pods.length} pods`));
    out.push(section("Pods", [podHeader(), ...podRows(d.pods)], "click to open"));
  }

  if (r.kind === "nodes") {
    const lab = md.labels ?? {}, info = status.nodeInfo ?? {};
    const ready = (status.conditions ?? []).find((c) => c.type === "Ready");
    const alloc = status.allocatable ?? {};
    let reqCpu = 0, reqMem = 0;
    for (const p of d.pods) { const x = resources(p.spec?.containers); reqCpu += x.rc; reqMem += x.rm; }
    const roles = Object.keys(lab).filter((k) => k.startsWith("node-role.kubernetes.io/")).map((k) => k.split("/")[1]);
    out.push(section("Overview", [
      fact("Health", ready?.status === "True" ? "Ready" : `NotReady${ready?.reason ? ` · ${ready.reason}` : ""}`, ready?.status === "True" ? t.ansi2 : t.ansi1),
      fact("Scheduling", spec.unschedulable ? "Cordoned (no new pods)" : "Schedulable", spec.unschedulable ? t.ansi3 : undefined),
      fact("Instance", lab["node.kubernetes.io/instance-type"]),
      fact("Zone", lab["topology.kubernetes.io/zone"]),
      fact("Pool", lab["eks.amazonaws.com/nodegroup"] ?? lab["karpenter.sh/nodepool"]),
      fact("Roles", roles.join(", ")),
      fact("Internal IP", (status.addresses ?? []).find((a) => a.type === "InternalIP")?.address, undefined, true),
      fact("Kubelet", info.kubeletVersion, undefined, true),
      fact("OS", `${info.osImage ?? ""} (${info.architecture ?? ""})`),
      fact("Runtime", info.containerRuntimeVersion, undefined, true),
    ]));
    out.push(section("Usage", [
      meter("CPU", d.nodeUsage?.cpu ?? null, reqCpu, null, fmtCpu, cpuMilli(alloc.cpu)),
      meter("Memory", d.nodeUsage?.mem ?? null, reqMem, null, fmtMem, memBytes(alloc.memory)),
      fact("Pods", `${d.pods.length} of ${alloc.pods ?? "?"}`),
    ], d.nodeUsage ? "" : "no metrics"));
    if (spec.taints?.length) out.push(section("Taints", spec.taints.map((x) => fact(x.effect, `${x.key}${x.value ? `=${x.value}` : ""}`, undefined, true))));
    out.push(section("Conditions", (status.conditions ?? []).map((c) => fact(c.type, `${c.status}${c.reason ? ` · ${c.reason}` : ""}`,
      (c.type === "Ready") === (c.status === "True") ? t.ansi2 : t.ansi1))));
    out.push(section("Pods", [podHeader(), ...podRows(d.pods, true)], `${d.pods.length}`));
  }

  if (r.kind === "svc") {
    out.push(section("Overview", [
      fact("Type", spec.type),
      fact("Cluster IP", spec.clusterIP, undefined, true),
      fact("External", (status.loadBalancer?.ingress ?? []).map((i) => i.hostname || i.ip).join("\n") || (spec.externalIPs ?? []).join(", "), undefined, true),
      fact("Selects", selectorOf(spec.selector), undefined, true),
      fact("Affinity", spec.sessionAffinity === "ClientIP" ? "Sticky (ClientIP)" : "None"),
    ]));
    out.push(section("Ports", (spec.ports ?? []).map((p) => fact(p.name || String(p.port), `${p.port} → ${p.targetPort}${p.nodePort ? ` (node ${p.nodePort})` : ""} / ${p.protocol ?? "TCP"}`, undefined, true))));
    out.push(section("Endpoints", d.pods.length ? [podHeader(), ...podRows(d.pods)] : [div().text_color(t.ansi3).child(spec.selector ? "No pods match the selector" : "No selector")], `${d.pods.length} pods`));
  }

  if (r.kind === "ing") {
    out.push(section("Overview", [
      fact("Class", spec.ingressClassName ?? md.annotations?.["kubernetes.io/ingress.class"]),
      fact("Address", (status.loadBalancer?.ingress ?? []).map((i) => i.hostname || i.ip).join("\n"), undefined, true),
    ]));
    out.push(section("Rules", (spec.rules ?? []).flatMap((rule) => (rule.http?.paths ?? []).map((p) =>
      h_flex().gap(8).min_h(20).font_family(mono).text_size(12)
        .child(div().flex_1().min_w(0).truncate().child(`${rule.host ?? "*"}${p.path ?? "/"}`))
        .child(div().text_color(t.dim).child("→"))
        .child(div().text_color(t.ansi6).child(`${p.backend?.service?.name ?? "?"}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? ""}`))))));
    if (spec.tls?.length) out.push(section("TLS", spec.tls.map((x) => fact(x.secretName ?? "(default)", (x.hosts ?? []).join(", ") || "every host", undefined, true))));
  }

  out.push(section("Labels", [chips(md.labels)]));
  if (md.annotations && Object.keys(md.annotations).length) {
    const ann = Object.fromEntries(Object.entries(md.annotations).filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration").map(([k, v]) => [k, String(v).slice(0, 120)]));
    out.push(section("Annotations", [chips(ann)]));
  }
  out.push(section("Created", [div().text_color(t.muted).child(`${md.creationTimestamp ?? ""}  (${ago(md.creationTimestamp)} ago)`)]));
  return out;
}

export function drawEvents(t, d) {
  const note = d.eventsNote ? [div().px(4).py(2).text_size(12).text_color(t.ansi3).child(d.eventsNote)] : [];
  if (!d.events.length) return [...note, div().p(4).text_color(t.dim).child("No events (the API server keeps them about an hour)")];
  return [...note, ...d.events.slice(0, 200).map((e, i) => v_flex().id(`ev-${i}`).gap(2).py(6).border_b(1).border_color(t.border)
    .child(h_flex().gap(8).items_center().text_size(12)
      .child(div().text_color(e.type === "Warning" ? t.ansi1 : t.ansi2).font_semibold().child(e.reason ?? ""))
      .child(div().text_color(t.dim).child(`${e.involvedObject?.kind ?? ""}/${e.involvedObject?.name ?? ""}`))
      .child(div().flex_1())
      .when((e.count ?? 1) > 1, (el) => el.child(div().text_color(t.ansi3).child(`×${e.count}`)))
      .child(div().text_color(t.dim).child(`${ago(eventTime(e))} ago`)))
    .child(div().text_size(12).text_color(t.foreground).child(e.message ?? "")))];
}
