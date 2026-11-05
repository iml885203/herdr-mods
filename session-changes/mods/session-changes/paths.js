export const dirOf = (path) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";
export const baseName = (path) => path.split("/").pop() ?? path;
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function expandHome(path, home) {
  const match = /^(~|\$HOME|\$\{HOME\})(\/.*)?$/.exec(path);
  if (!match) return path;
  return home ? `${home}${match[2] ?? ""}` : null;
}

export function resolvePath(base, path, home = "") {
  if (!path) return null;
  const expanded = expandHome(path, home);
  if (expanded === null) return null;
  const out = [];
  for (const part of (expanded.startsWith("/") ? expanded : `${base}/${expanded}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}
