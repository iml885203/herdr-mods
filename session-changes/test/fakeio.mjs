import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const HOME = "/home";
export const editLine = (path, ts, cwd = "/r") =>
  JSON.stringify({ type: "assistant", timestamp: ts, cwd, message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] } }) + "\n";

export const padLine = (bytes) => JSON.stringify({ type: "user", message: { content: "x".repeat(bytes) } }) + "\n";

export const bashLine = (command, ts, cwd = "/r") =>
  JSON.stringify({ type: "assistant", timestamp: ts, cwd, message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } }) + "\n";

export function realIo() {
  const exec = (cmd, args, options = {}) => new Promise((resolve) => {
    execFile(cmd, args, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
  return { exec, home: () => HOME, readTextFile: (path) => readFile(path, "utf8") };
}

function chunkOf(bytes, skip, count, lead) {
  const slice = Buffer.concat([bytes.subarray(skip * 65536, (skip + count) * 65536), Buffer.from("X")]);
  const records = slice.toString("latin1").split("\n");
  let dropped = 0;
  while (dropped < lead && records.length > 1) dropped += records.shift().length + 1;
  const last = records.pop();
  const hits = records.filter((r) => r.includes('"tool_use"')).map((r) => Buffer.from(r, "latin1").toString("utf8"));
  const consumed = records.reduce((n, r) => n + r.length + 1, 0);
  return `${hits.map((h) => `${h}\n`).join("")}\x01CONSUMED ${consumed}\n`;
}

export function fakeIo({ sessionId = "sid", transcript = editLine("/r/a.cs", "2026-11-04T10:00:00.000Z"), repos = ["/r"] } = {}) {
  const main = `${HOME}/.claude/projects/p/${sessionId}.jsonl`;
  const world = {
    files: { [main]: Buffer.from(transcript) },
    subagents: [],
    repos,
    head: "h1",
    upstream: "u1",
    ahead: 0,
    diffFails: false,
    stat: "s1",
    baselineFails: 0,
    statusFails: false,
    readFails: null,
    claude: { code: 0, stdout: '{"headline":"Add rate","points":["p"]}', stderr: "" },
    claudeGate: null,
    claudeRunning: 0,
    claudePeak: 0,
    prompts: new Map(),
    hold: null,
    calls: [],
  };
  const append = (text, file = main) => { world.files[file] = Buffer.concat([world.files[file] ?? Buffer.alloc(0), Buffer.from(text)]); };
  const count = (cmd, needle) => world.calls.filter((c) => c.cmd === cmd && (!needle || c.args.join(" ").includes(needle))).length;
  const repoOf = (path) => world.repos.find((r) => path === r || path.startsWith(`${r}/`));

  async function git(args, cwd) {
    const sub = args.join(" ");
    if (!repoOf(cwd)) return { code: 128, stdout: "", stderr: "not a git repository" };
    if (sub.includes("rev-list -1")) {
      if (world.baselineFails > 0) { world.baselineFails--; return { code: 128, stdout: "", stderr: "fatal: broken" }; }
      return { code: 0, stdout: "base1\n", stderr: "" };
    }
    if (sub.includes("--verify")) return { code: 0, stdout: "h\n", stderr: "" };
    if (world.diffFails && sub.includes("--raw")) return { code: 128, stdout: "", stderr: "fatal: bad object" };
    if (world.statusFails && sub.includes("--porcelain")) return { code: 128, stdout: "", stderr: "fatal: index locked" };
    const out = [
      ["--porcelain", " M a.cs\0"], ["--raw", `:100644 100644 aaa bbb M\0a.cs\0${world.numstat ?? "1\t0"}\ta.cs\0`],
      ["rev-parse HEAD @{u} --abbrev-ref", `${world.head}\n${world.upstream}\nmain\n`], ["--count", `${world.ahead}\n`], ["--format=%x01%ct", world.log ?? ""], ["-U0", "+++ b/a.cs\n+walletCurrencyName\n"],
    ].find(([needle]) => sub.includes(needle));
    return { code: 0, stdout: out ? out[1] : "", stderr: "" };
  }

  function shell(script, args) {
    if (script.includes("dd ")) {
      const [, , , file, skip, count, lead] = args;
      return { code: 0, stdout: chunkOf(world.files[file], Number(skip), Number(count), Number(lead)), stderr: "" };
    }
    if (script.includes("NR == 1")) {
      const rest = world.files[args[4]].subarray(Number(args[3]) - 1);
      const end = rest.indexOf(10);
      return { code: 0, stdout: `${(end < 0 ? rest.length : end) + 1}\n`, stderr: "" };
    }
    if (script.includes("diff \"$b\"")) return { code: 0, stdout: "+++ b/a.cs\n+walletCurrencyName\n", stderr: "" };
    if (script.includes("head -c")) {
      const [, , , nonce, limit, ...paths] = args;
      const text = (path) => world.fresh?.[path];
      return { code: 0, stdout: paths.map((path) => `\x01${nonce}${text(path) === undefined ? "-\n" : `+\n${text(path).slice(0, Number(limit))}`}`).join(""), stderr: "" };
    }
    if (script.includes("subagents")) return { code: 0, stdout: world.subagents.map((f) => `${f}\n`).join(""), stderr: "" };
    if (script.includes('"$2".jsonl')) return { code: 0, stdout: `${main}\n`, stderr: "" };
    if (script.includes(".git")) return { code: 0, stdout: args.slice(3).map((d) => (repoOf(d) ? `${d}\0${d}\0${d}\0${repoOf(d)}\0` : `${d}\0\0\0\0`)).join(""), stderr: "" };
    if (script.includes("stat -f")) return { code: 0, stdout: `${world.head}|${world.stat}`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }

  async function exec(cmd, args, options = {}) {
    world.calls.push({ cmd, args, options });
    if (world.hold) await world.hold(cmd, args);
    await new Promise((resolve) => setImmediate(resolve));
    switch (cmd) {
      case "wc": return { code: 0, stdout: args.slice(1).filter((f) => f in world.files).map((f) => `${world.files[f].length} ${f}\n`).join(""), stderr: "" };
      case "sh":
        if (world.readFails !== null && args[1].includes("dd ") && world.readFails-- <= 0) throw new Error("read failed");
        if (args[1].includes("claude")) {
          world.claudeRunning++;
          world.claudePeak = Math.max(world.claudePeak, world.claudeRunning);
          try {
            if (world.claudeGate) await world.claudeGate;
            return typeof world.claude === "function" ? world.claude(world.prompts.get(args[3]) ?? "", args) : world.claude;
          } finally { world.claudeRunning--; }
        }
        return shell(args[1], args);
      case "stat": return { code: 0, stdout: world.stat, stderr: "" };
      case "claude": return world.claude;
      case "mktemp": return { code: 0, stdout: "/scratch\n", stderr: "" };
      case "git": return git(args, options.cwd);
      default: return { code: 0, stdout: "", stderr: "" };
    }
  }

  const written = [];
  const io = { exec, home: () => HOME, appHome: () => `${HOME}/.config/herdr-app`, readTextFile: async () => null, writeTextFile: async (path, text) => { written.push({ path, text }); world.prompts.set(path, text); } };
  return { io, world, append, count, main, written };
}

export async function until(check) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!check()) throw new Error("condition never became true");
}
