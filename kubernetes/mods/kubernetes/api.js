// The read path: one read-only `kubectl proxy` per context (proxy.sh), shared by
// every copy and reused across opens: auth (`aws eks get-token`) runs once instead
// of on every request, and each list/log poll is a local HTTP call, not a process.
// The proxy exits after 10 idle minutes (no heartbeat from here).

import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import { memoStart, makeAlive, dropIfDead } from "./proxymemo.js";

export const DIR = () => `${appHome()}/data/kubernetes`;
export const ensureDir = () => fs.mkdir(DIR(), { recursive: true }).catch(() => {});

const TABLE = "application/json;as=Table;v=v1;g=meta.k8s.io";
const proxies = new Map(), beats = new Map(), namespaces = new Map();
const safe = (ctx) => ctx.replace(/[^\w.-]/g, "_");
// A context's proxy lives on its hashed port, or the next free one if another context took it.
// `port-<port>` in DIR() names the context a proxy there serves, so two contexts that hash
// alike never share a proxy (and show one cluster's rows under the other's name).
const PORTS = 500, TRIES = 10;
function portFor(ctx, k = 0) { let h = 7; for (const ch of ctx) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 28400 + ((h + k) % PORTS); }
const ownerFile = (port) => `${DIR()}/port-${port}`;
async function ownerOf(port) { try { return (await fs.readFile(ownerFile(port), "utf8")).trim(); } catch { return ""; } } // fs can throw, not reject
const alive = makeAlive((url) => fetch(url));
function beat(ctx) {
  const now = Date.now();
  if (now - (beats.get(ctx) ?? 0) < 60000) return;
  beats.set(ctx, now);
  fs.writeFile(`${DIR()}/hb-${safe(ctx)}`, String(now)).catch(() => {});
}
function proxy(ctx) {
  return memoStart(proxies, ctx, () => (async () => {
    let port = null;
    for (let k = 0; k < TRIES && port === null; k++) {
      const p = portFor(ctx, k);
      if (!(await alive(`http://127.0.0.1:${p}`))) port = p;                     // free: start ours here
      else if (await ownerOf(p) === ctx) return `http://127.0.0.1:${p}`;        // ours, already running
    }                                                                           // else another context's: try the next
    if (port === null) throw new Error(`no free port for the kubectl proxy of ${ctx}`);
    const base = `http://127.0.0.1:${port}`;
    await ensureDir();
    await fs.writeFile(ownerFile(port), ctx).catch(() => {});
    const hb = `${DIR()}/hb-${safe(ctx)}`;
    await fs.writeFile(hb, String(Date.now())).catch(() => {});
    beats.set(ctx, Date.now());
    // Start it detached, then wait (in that one shell) until it answers.
    const r = await exec("sh", ["-c", 'nohup sh "$0" "$1" "$2" "$3" >/dev/null 2>&1 & for i in $(seq 60); do curl -sf -o /dev/null "http://127.0.0.1:$2/version" && exit 0; sleep 0.1; done; exit 1',
      `${appHome()}/mods/kubernetes/proxy.sh`, ctx, String(port), hb]);
    if (r.code !== 0) throw new Error("kubectl proxy did not start (check `kubectl --context " + ctx + " get ns`)");
    return base;
  })());
}
export async function api(ctx, path, accept) {
  for (let attempt = 0; ; attempt++) {
    const pr = proxy(ctx), base = await pr;
    beat(ctx);
    let r;
    try { r = await fetch(base + path, accept ? { headers: { Accept: accept } } : undefined); }
    catch (e) { await dropIfDead(proxies, ctx, pr, base, alive); if (attempt) throw e; continue; } // proxy went idle: start it again
    if (r.ok) return r;
    const text = await r.text();
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch {}
    throw new Error(`${r.status}: ${msg.trim().slice(0, 300)}`);
  }
}
// The API server's own table view (what `kubectl get` prints), as one object per row.
export async function table(ctx, path) {
  const t = await (await api(ctx, `${path}?includeObject=None`, TABLE)).json();
  const names = (t.columnDefinitions ?? []).map((c) => c.name);
  return (t.rows ?? []).map((row) => Object.fromEntries(names.map((n, i) => [n, row.cells[i]])));
}
export async function namespacesOf(ctx) {
  const hit = namespaces.get(ctx);
  if (hit && Date.now() - hit.at < 60000) return hit.list;
  const list = (await table(ctx, "/api/v1/namespaces")).map((c) => c.Name);
  namespaces.set(ctx, { at: Date.now(), list });
  return list;
}
// A namespace that answered 404 is gone: the cached list must not offer it again.
export function dropNamespace(ctx, ns) {
  const hit = namespaces.get(ctx);
  if (hit) hit.list = hit.list.filter((n) => n !== ns);
}
