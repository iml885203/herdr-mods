import { jiraKeys } from "./graph.js";
import { ownedFiles } from "./model.js";
import { summarizeOverview, summarizeRepo } from "./summarizer.js";
import { changeShapeOf, changeStats, summaryKeyOf } from "./changekey.js";
import { createScheduler } from "./scheduler.js";
import { overviewDue, overviewKey } from "./overview.js";

const PENDING_SUMMARY = { headline: "summarizing…", points: [], stale: true, pending: true };
const OVERVIEW_ROOT = "~overview";

// Everything about the summaries of one run (one session): which are being written, which failed, the overview, and what to start next.
// `host` is the Store's side: { now(), exec, git, summaryStore, model, prompts, autoSummary, language(), bump(), current(controller), disposed() }.
export class SummaryController {
  constructor(run, host) {
    this.run = run;
    this.host = host;
    this.scheduler = createScheduler();
    this.summarizing = new Set();
    this.errors = {};
    this.overviews = {};
    this.armed = false;
    this.keys = new Map();
  }

  cancel() {
    this.scheduler.cancel();
  }

  slot(root, language = this.host.language()) {
    return `${root}#${language}`;
  }

  isSummarizing(root) {
    return this.summarizing.has(this.slot(root));
  }

  stored(root, language) {
    return this.host.summaryStore.get(this.run.session.sessionId, this.slot(root, language));
  }

  // The key of a repo state in a language, worked out once per snapshot (state.version) rather than at every frame.
  keyOf(state, language = this.host.language()) {
    let known = this.keys.get(state.root);
    if (known?.version !== state.version) { known = { version: state.version, byLanguage: new Map() }; this.keys.set(state.root, known); }
    if (!known.byLanguage.has(language)) known.byLanguage.set(language, summaryKeyOf(state, language));
    return known.byLanguage.get(language);
  }

  rows() {
    const { run } = this;
    const rows = {};
    for (const repo of run.views) {
      const state = run.repos.get(repo.root);
      const slot = this.slot(repo.root);
      const key = this.keyOf(state);
      const stored = this.host.summaryStore.get(run.session.sessionId, slot);
      const failure = this.errors[slot];
      if (this.summarizing.has(slot)) rows[repo.root] = PENDING_SUMMARY;
      else if (failure?.key === key) rows[repo.root] = { headline: failure.message, points: [], stale: true, failed: true };
      else if (stored) rows[repo.root] = { ...stored, stale: stored.key !== key };
    }
    return rows;
  }

  candidates() {
    const { run } = this;
    return run.views.map((repo) => {
      const state = run.repos.get(repo.root);
      const owned = ownedFiles(repo.files);
      return {
        root: repo.root, probe: state.probe, lastTs: state.lastTs, key: this.keyOf(state), shape: changeShapeOf(state, owned), stats: changeStats(owned),
        previous: this.stored(repo.root),
      };
    });
  }

  schedule() {
    const { run, host } = this;
    if (!host.autoSummary || host.disposed() || run.pending || !run.loaded) return;
    if (!this.armed && run.views.length === 0) return;
    this.armed = true;
    this.begin(this.scheduler.tick(this.candidates(), host.now()).start);
    this.maybeOverview();
  }

  begin(starts) {
    for (const { root } of starts) this.runSummary(root);
  }

  async runSummary(root) {
    await this.generate(root);
    if (!this.host.current(this) || this.host.disposed()) return;
    this.begin(this.scheduler.done(root).start);
    this.maybeOverview();
  }

  regenerate(root) {
    if (this.host.disposed()) return;
    this.begin(this.scheduler.manual(root, this.candidates()).start);
  }

  async generate(root) {
    const { run, host } = this;
    const state = run.repos.get(root);
    const language = host.language();
    const slot = this.slot(root, language);
    if (!state?.repo || this.summarizing.has(slot)) return "";
    const key = this.keyOf(state, language);
    this.summarizing.add(slot);
    host.bump();
    const result = await summarizeRepo({ exec: host.exec, git: host.git, state, prompts: host.prompts, model: host.model, language });
    if (!host.current(this)) return "";
    this.summarizing.delete(slot);
    if (result.error) this.errors[slot] = { key, message: result.error };
    else {
      delete this.errors[slot];
      host.summaryStore.set(run.session.sessionId, slot, result.summary);
    }
    host.bump();
    return result.error ?? "";
  }

  overviewFor(language = this.host.language()) {
    return (this.overviews[language] ??= { text: null, key: null, failedKey: null, running: false, error: null, loaded: false });
  }

  overviewEntries() {
    return this.run.views.flatMap((repo) => {
      const stored = this.stored(repo.root);
      return stored ? [{ root: repo.root, key: stored.key, name: repo.label, layer: repo.layer, headline: stored.headline, points: stored.points }] : [];
    });
  }

  maybeOverview() {
    const { host } = this;
    if (!host.autoSummary || host.disposed() || !host.current(this)) return;
    const overview = this.overviewFor();
    if (!overview.loaded) {
      const cached = this.stored(OVERVIEW_ROOT);
      Object.assign(overview, { text: cached?.text ?? null, key: cached?.key ?? null, loaded: true });
    }
    const entries = this.overviewEntries();
    const due = overviewDue({ entries, current: overview.key, failedKey: overview.failedKey, running: overview.running, idle: this.scheduler.idle() });
    if (due) this.runOverview(entries, due.key);
  }

  overviewInput(entries) {
    const { run } = this;
    const labels = new Map(run.views.map((r) => [r.root, r.label]));
    const relations = run.views.flatMap((repo) => (run.relations[repo.root] ?? []).map((rel) => `${labels.get(repo.root)} ${rel.kind} → ${rel.targets.join(", ")}${rel.kind === "submodule" ? "" : ` (${rel.label})`}`));
    return { jira: jiraKeys(run.views.flatMap((r) => [...r.subjects, r.branch])), repos: entries, relations };
  }

  async runOverview(entries, key) {
    const { host } = this;
    const language = host.language();
    const overview = this.overviewFor(language);
    overview.running = true;
    host.bump();
    const result = await summarizeOverview({ exec: host.exec, prompts: host.prompts, model: host.model, input: this.overviewInput(entries), language });
    if (!host.current(this) || host.disposed()) return;
    overview.running = false;
    if (result.error) Object.assign(overview, { failedKey: key, error: result.error });
    else {
      Object.assign(overview, { text: result.overview, key, error: null });
      host.summaryStore.set(this.run.session.sessionId, this.slot(OVERVIEW_ROOT, language), { key, text: result.overview });
    }
    host.bump();
  }

  overviewState() {
    const overview = this.overviewFor();
    const text = this.run.views.length > 1 ? overview.text : null;
    const stale = text !== null && overviewKey(this.overviewEntries()) !== overview.key;
    return { text, stale, running: overview.running, error: overview.error };
  }
}
