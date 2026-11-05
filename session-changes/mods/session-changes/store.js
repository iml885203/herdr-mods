import { createGit } from "./git.js";
import { TranscriptReader } from "./reader.js";
import { createTranscripts } from "./transcripts.js";
import { createTouches, foldEvents, groupTouches } from "./transcript.js";
import { buildRepo, buildSession, ownedFiles, sessionTotals } from "./model.js";
import { parseProbeStats } from "./gitparse.js";
import { createSummaryStore } from "./summarystore.js";
import { SUMMARY_MODEL } from "./summarizer.js";
import { SummaryController } from "./summaries.js";
import { hashOf } from "./hash.js";
import { DEFAULT_LANGUAGE, isLanguage } from "./languages.js";
import { saveLanguage } from "./settings.js";
import { baseName, dirOf } from "./paths.js";

const PROBE_QUIET_MS = 15000;
const SESSION_END_SLACK_MS = 60000;
const BYTES_PER_TICK = 28_000_000;
const NO_STORAGE = { getItem: () => null, setItem: () => null, removeItem: () => null };
function pageStorage() {
  try { return localStorage; } catch { return NO_STORAGE; }
}

const eventDirs = (events) => events.flatMap((e) => [...e.files.map(dirOf), ...e.dirs, ...e.hints.map(dirOf)]);

// What the cross-repo identifiers were read from: HEAD and the set of owned paths. Edits inside the same files do not read them again.
const identsKey = (state) => `${state.snap.head}|${hashOf(ownedFiles(state.repo.files).map((f) => f.path).sort().join("\0"))}`;

export class Store {
  constructor(io, transcripts = createTranscripts(io.exec, io.home()), { chunk, bytesPerTick = BYTES_PER_TICK, storage = pageStorage(), autoSummary = true, model = SUMMARY_MODEL, language = DEFAULT_LANGUAGE, now = Date.now } = {}) {
    this.language = language;
    this.settingsError = null;
    this.io = io;
    this.autoSummary = autoSummary;
    this.model = model;
    this.rev = 0;
    this.waiters = [];
    this.disposed = false;
    this.chunk = chunk;
    this.bytesPerTick = bytesPerTick;
    this.transcripts = transcripts;
    this.git = createGit(io);
    this.summaryStore = createSummaryStore(storage);
    this.epoch = 0;
    this.promptSink = null;
    const store = this;
    this.host = {
      now, exec: io.exec, git: this.git, summaryStore: this.summaryStore, model, autoSummary,
      get prompts() { return store.prompts; }, language: () => store.language, bump: () => store.bump(),
      current: (controller) => store.run.summaries === controller, disposed: () => store.disposed,
    };
    this.run = this.newRun(null);
  }

  newRun(session) {
    const { io, chunk } = this;
    const run = {
      session, transcript: null, reader: new TranscriptReader(io.exec, { home: io.home(), ...(chunk ? { chunk } : {}) }), touches: createTouches(),
      roots: new Map(), misses: new Set(), repos: new Map(),
      views: [], relations: {}, totals: sessionTotals([]),
      error: null, skipped: [], progress: 0, pending: false, loaded: false, busy: false, again: false, lastProbe: 0, grew: false,
    };
    run.summaries = new SummaryController(run, this.host);
    return run;
  }

  // The folder and writer for the prompt files, made once.
  get prompts() {
    this.promptSink ??= { dir: `${this.io.appHome()}/session-changes-tmp`, write: (path, text) => this.io.writeTextFile(path, text, null) };
    return this.promptSink;
  }

  get session() { return this.run.session; }
  get views() { return this.run.views; }
  get relations() { return this.run.relations; }
  get totals() { return this.run.totals; }
  get error() { return this.run.error; }
  get pending() { return this.run.pending; }
  get progress() { return this.run.progress; }
  get loaded() { return this.run.loaded; }

  bump() {
    this.rev++;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(true);
  }

  changed(since) {
    if (this.disposed) return Promise.resolve(false);
    if (this.rev !== since) return Promise.resolve(true);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async dispose() {
    this.disposed = true;
    this.run.summaries.cancel();
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(false);
    await this.git.dispose();
  }

  start(session) {
    this.run.summaries.cancel();
    this.epoch++;
    this.run = this.newRun(session);
  }

  async resolveRoots(run) {
    const { touches } = run;
    const dirs = new Set([...touches.dirs.keys(), ...[...touches.files.keys()].map(dirOf), ...[...touches.hints.keys()].map(dirOf)]);
    const todo = [...dirs].filter((dir) => !run.roots.has(dir) && !run.misses.has(dir));
    if (!todo.length) return;
    for (const [dir, place] of await this.git.rootsOf(todo)) {
      if (place) run.roots.set(dir, place);
      else run.misses.add(dir);
    }
  }

  async refreshRepo(run, root, touch, force) {
    const state = run.repos.get(root) ?? { root, version: 0 };
    run.repos.set(root, state);
    if (state.since === undefined || touch.firstTs < state.since) {
      state.baseline = await this.git.baselineOf(root, touch.firstTs);
      state.since = touch.firstTs;
      state.sig = null;
    }
    state.lastTs = touch.lastTs;
    const probe = await this.git.probeOf(root, [...touch.files]);
    const sig = `${probe}|${touch.firstTs}|${touch.lastTs}|${touch.files.size}`;
    if (!force && sig === state.sig && state.repo) return false;
    const snap = await this.git.snapshotOf(root, state.baseline, state.since, touch.lastTs + SESSION_END_SLACK_MS, state.snap);
    const repo = buildRepo({ root, branch: snap.branch, ahead: snap.ahead, commits: snap.commits, edited: touch.files, files: snap.files });
    state.submodules ??= await this.git.submodulesIn(root);
    Object.assign(state, { snap, repo, sig, probe, stats: parseProbeStats(probe, root), error: null, version: state.version + 1 });
    return true;
  }

  async refreshAll(run, force, now) {
    const groups = groupTouches(run.touches, (dir) => run.roots.get(dir) ?? null);
    let failed = false;
    const results = await Promise.all([...groups].map(([root, touch]) => this.refreshRepo(run, root, touch, force).catch((e) => {
      const state = run.repos.get(root);
      if (state) Object.assign(state, { error: String(e?.message ?? e), sig: null });
      failed = true;
      return false;
    })));
    if (run !== this.run) return;
    const identsChanged = await this.readIdents(run);
    if (run !== this.run) return;
    run.lastProbe = failed ? 0 : now;
    if (identsChanged || results.some(Boolean) || !run.loaded) this.rebuild(run);
    run.loaded = true;
  }

  async readIdents(run) {
    const owners = [...run.repos.values()].filter((s) => s.repo?.owned > 0);
    const due = owners.length < 2 ? [] : owners.filter((s) => s.identsAt !== identsKey(s));
    await Promise.all(due.map(async (s) => {
      const key = identsKey(s);
      s.idents = await this.git.identsOf(s.root, s.baseline, ownedFiles(s.repo.files));
      s.identsAt = key;
    }));
    return due.length > 0;
  }

  async step(run, force) {
    run.transcript ??= await this.transcripts.find(run.session.sessionId);
    if (run !== this.run) return;
    if (!run.transcript) { run.error = "Transcript not found"; return; }
    const refreshGlob = force || run.grew;
    run.grew = false;
    const files = [run.transcript.file, ...(await this.transcripts.subagents(run.session.sessionId, { refresh: refreshGlob }))];
    if (run !== this.run) return;
    const sizeBefore = run.reader.total();
    const polled = await run.reader.poll(files, this.bytesPerTick);
    if (run !== this.run) return;
    run.grew = polled.reset || polled.events.length > 0 || run.reader.total() !== sizeBefore;
    if (polled.reset) { run.touches = createTouches(); run.skipped = []; }
    run.progress = run.reader.progress();
    run.pending = polled.pending;
    run.skipped.push(...polled.skipped);
    foldEvents(run.touches, polled.events);
    if (force || polled.reset) { run.roots.clear(); run.misses.clear(); }
    for (const dir of eventDirs(polled.events)) run.misses.delete(dir);
    await this.resolveRoots(run);
    if (run !== this.run) return;
    const now = Date.now();
    const quiet = !force && polled.events.length === 0 && run.loaded && now - run.lastProbe < PROBE_QUIET_MS;
    if (!quiet) await this.refreshAll(run, force, now);
    if (run !== this.run) return;
    run.error = polled.error ? String(polled.error.message ?? polled.error) : null;
    run.summaries.schedule();
  }

  async tick(force = false) {
    const run = this.run;
    if (!run.session || this.disposed) return null;
    if (run.busy) { if (force) run.again = true; return null; }
    const before = this.stamp(run);
    run.busy = true;
    try {
      await this.step(run, force);
    } catch (e) {
      run.error = String(e?.message ?? e);
    } finally {
      run.busy = false;
    }
    if (run !== this.run) return null;
    if (run.again) { run.again = false; return this.tick(true); }
    return { changed: this.stamp(run) !== before, pending: run.pending, grew: run.grew };
  }

  rebuild(run) {
    Object.assign(run, buildSession([...run.repos.values()]));
  }

  stamp(run) {
    const versions = [...run.repos.values()].map((s) => `${s.version}${s.error ? "!" : ""}`).join(",");
    return `${versions}|${run.error}|${run.pending}|${Math.round(run.progress * 100)}|${run.loaded}|${this.rev}`;
  }

  warnings() {
    const { repos, skipped } = this.run;
    const lines = [...repos.values()].filter((s) => s.error).map((s) => `${baseName(s.root)}: ${s.error}`);
    if (skipped.length) lines.push(`transcript: skipped ${skipped.length} oversize line${skipped.length > 1 ? "s" : ""} (${(Math.max(...skipped.map((x) => x.bytes)) / 1e6).toFixed(1)} MB at most)`);
    if (this.settingsError) lines.push(this.settingsError);
    return lines;
  }

  stateOf(root) {
    return this.run.repos.get(root);
  }

  summaryRows() { return this.run.summaries.rows(); }
  isSummarizing(root) { return this.run.summaries.isSummarizing(root); }
  regenerate(root) { this.run.summaries.regenerate(root); }
  overviewState() { return this.run.summaries.overviewState(); }

  setLanguage(id) {
    if (!isLanguage(id) || id === this.language || this.disposed) return;
    this.language = id;
    this.bump();
    this.settingsError = null;
    saveLanguage(this.io, id).catch((e) => { if (id !== this.language) return; this.settingsError = `could not save the summary language: ${e?.message ?? e}`; this.bump(); });
    this.run.summaries.schedule();
  }
}
