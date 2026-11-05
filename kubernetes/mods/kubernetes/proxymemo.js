// The bookkeeping of api.js's per-context proxy, apart from herdr so Node can test it.

// One start per key: callers share the promise. A failed start is forgotten, but only
// if it is still the one in the map (a newer start must not be thrown away).
export function memoStart(map, key, start) {
  let p = map.get(key);
  if (p) return p;
  p = start();
  map.set(key, p);
  p.catch(() => { if (map.get(key) === p) map.delete(key); });
  return p;
}

// Is the proxy at `base` answering? `f` is the fetch to ask with.
export const makeAlive = (f) => async (base) => {
  try { const r = await f(`${base}/version`); return r.ok && Boolean((await r.json())?.gitVersion); } catch { return false; }
};

// After a failed request: forget the proxy `p` only when it is really dead, and only
// if `p` is still the current one. A slow answer or a failed request on a live proxy
// must not make the next caller start a second proxy.
export async function dropIfDead(map, key, p, base, alive) {
  if (map.get(key) !== p) return false;
  if (await alive(base)) return false;
  if (map.get(key) !== p) return false; // another caller already replaced it
  map.delete(key);
  return true;
}
