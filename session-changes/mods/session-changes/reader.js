import { chunkPlan, parseChunk, parseWc } from "./chunks.js";
import { parseToolUses } from "./transcript.js";

const READ_CHUNK = [
  '{ dd if="$1" bs=65536 skip="$2" count="$3" 2>/dev/null; printf X; } |',
  'LC_ALL=C awk -v lead="$4" \'NR > 1 && hit { print prev }',
  '{ n = length($0) + 1; if (skipped < lead) { skipped += n; prev = ""; hit = 0; next }',
  'prev = $0; hit = index($0, "\\"tool_use\\"") > 0; t += n; last = n }',
  'END { print "\\001CONSUMED " (t - last) }\'',
].join(" ");
const LINE_BYTES = 'LC_ALL=C tail -c +"$1" "$2" | LC_ALL=C awk \'NR == 1 { print length($0) + 1; exit }\'';
const WORKERS = 4;
const CHUNK = 6_000_000;

export class TranscriptReader {
  constructor(exec, { chunk = CHUNK, home = "" } = {}) {
    this.exec = exec;
    this.chunkSize = chunk;
    this.home = home;
    this.offsets = new Map();
    this.sizes = new Map();
    this.shrunk = false;
  }

  offsetOf(file) {
    return this.offsets.get(file) ?? 0;
  }

  behind(file) {
    return this.offsetOf(file) < (this.sizes.get(file) ?? 0);
  }

  total() {
    return [...this.sizes.values()].reduce((n, size) => n + size, 0);
  }

  progress() {
    const total = this.total();
    const done = [...this.offsets.values()].reduce((n, offset) => n + offset, 0);
    return total ? Math.min(1, done / total) : 1;
  }

  async measure(files) {
    const result = await this.exec("wc", ["-c", ...files]).catch(() => ({ stdout: "" }));
    const sizes = parseWc(result.stdout);
    for (const file of files) {
      const size = sizes.get(file);
      if (size === undefined) continue;
      if (size < this.offsetOf(file)) this.shrunk = true;
      this.sizes.set(file, size);
    }
  }

  async chunk(file, skipped) {
    const offset = this.offsetOf(file);
    const { skip, count, lead } = chunkPlan(offset, this.chunkSize);
    const result = await this.exec("sh", ["-c", READ_CHUNK, "sh", file, String(skip), String(count), String(lead)]);
    const { text, consumed } = parseChunk(result.stdout);
    if (consumed > 0) {
      this.offsets.set(file, offset + consumed);
      return text;
    }
    if (offset + this.chunkSize < (this.sizes.get(file) ?? 0)) await this.skipLine(file, offset, skipped);
    return "";
  }

  async skipLine(file, offset, skipped) {
    const result = await this.exec("sh", ["-c", LINE_BYTES, "sh", String(offset + 1), file]);
    const bytes = Number(result.stdout.trim());
    if (bytes > 0 && offset + bytes <= (this.sizes.get(file) ?? 0)) {
      this.offsets.set(file, offset + bytes);
      skipped.push({ file, bytes });
    }
  }

  async readFile(file, budget, events, skipped) {
    while (budget.left > 0 && this.behind(file)) {
      const before = this.offsetOf(file);
      events.push(...parseToolUses(await this.chunk(file, skipped), this.home));
      const advanced = this.offsetOf(file) - before;
      budget.left -= advanced;
      if (advanced === 0) break;
    }
  }

  async readAll(files, budget, events, skipped) {
    let next = 0;
    const worker = async () => {
      while (next < files.length) await this.readFile(files[next++], budget, events, skipped);
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(WORKERS, files.length) }, worker));
    const failed = settled.find((s) => s.status === "rejected");
    if (failed) throw failed.reason;
  }

  async poll(files, maxBytes = Infinity) {
    await this.measure(files);
    const reset = this.shrunk;
    if (reset) { this.offsets.clear(); this.shrunk = false; }
    const events = [];
    const skipped = [];
    const budget = { left: maxBytes };
    const pending = () => budget.left <= 0 && files.some((file) => this.behind(file));
    try {
      await this.readAll(files, budget, events, skipped);
      return { events, skipped, reset, error: null, pending: pending() };
    } catch (error) {
      return { events, skipped, reset, error, pending: false };
    }
  }
}
