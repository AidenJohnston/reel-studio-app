#!/usr/bin/env node
// Watch PRs and exit on the first change a caretaker must act on.
//
// Why it exits instead of streaming: a caretaker runs this with Bash
// `run_in_background`, which wakes the session only when the command ends. Monitor
// stops every watch after 30 minutes and wakes the model to re-arm it, which costs
// a full-context turn each time even when nothing changed. Here an idle PR costs no turns.
//
// Usage: pr-watch.mjs [--rebaseline] [--interval-sec N] [--max-hours N] [--state-dir DIR] owner/repo#1,2 [owner/repo#3]
// Exit 0: changes found, every PR closed, or --max-hours elapsed (output says which).
// Exit 2: GitHub unreachable for the whole failure window; coverage is lost.
// Exit 64: bad arguments.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

export class UsageError extends Error {}

export function parseTargets(specs) {
  if (specs.length === 0) throw new UsageError("name at least one target as owner/repo#1,2");
  const targets = [];
  for (const spec of specs) {
    const m = /^([\w.-]+)\/([\w.-]+)#(\d+(?:,\d+)*)$/.exec(spec);
    if (!m) throw new UsageError(`target "${spec}" is not owner/repo#1,2`);
    for (const n of m[3].split(",")) targets.push({ owner: m[1], repo: m[2], number: Number(n) });
  }
  return targets;
}

export const keyOf = (t) => `${t.owner}/${t.repo}#${t.number}`;

// Reduce one GraphQL pullRequest node to the fields whose change is actionable.
// Pending checks and passing checks while others still run are deliberately absent:
// they would wake the caretaker once per check instead of once per outcome.
export function fingerprint(node) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const contexts = rollup?.contexts?.nodes ?? [];
  const failing = new Set();
  let pending = 0;
  for (const c of contexts) {
    if (c.__typename === "CheckRun") {
      if (c.status !== "COMPLETED") pending += 1;
      else if (FAILED_CONCLUSIONS.has(c.conclusion)) failing.add(c.name);
    } else if (c.__typename === "StatusContext") {
      if (PENDING_STATES.has(c.state)) pending += 1;
      else if (FAILED_STATES.has(c.state)) failing.add(c.context);
    }
  }
  // Only the first 100 checks are listed. The rollup's overall state covers all of
  // them, so a pending or failing check past that page still counts.
  if (PENDING_STATES.has(rollup?.state)) pending += 1;
  if (FAILED_STATES.has(rollup?.state) && failing.size === 0) failing.add("(a check past the first 100)");
  const threads = node.reviewThreads?.nodes ?? [];
  return {
    state: node.state,
    isDraft: node.isDraft,
    head: node.headRefOid,
    base: node.baseRefName,
    // GitHub computes mergeability lazily and reports UNKNOWN meanwhile; that is no information.
    merge: node.mergeStateStatus === "UNKNOWN" ? null : node.mergeStateStatus,
    reviews: node.reviews.totalCount,
    comments: node.comments.totalCount,
    threads: node.reviewThreads.totalCount,
    threadComments: threads.reduce((sum, t) => sum + t.comments.totalCount, 0),
    unresolved: threads.filter((t) => !t.isResolved).length,
    failing: [...failing].sort(),
    checksComplete: pending === 0,
    // Replies and resolutions on threads past the first 100 are not seen; main() says so.
    threadsUnlisted: Math.max(0, node.reviewThreads.totalCount - threads.length),
  };
}

// Compare a baseline with the current fingerprint. Returns the actionable changes
// and the value to store as the next baseline.
export function compare(prev, cur) {
  const next = { ...cur, merge: cur.merge ?? prev?.merge ?? null };
  if (!prev) return { changes: [], next };
  const changes = [];
  if (prev.state !== cur.state) changes.push(cur.state === "MERGED" ? "merged" : cur.state === "CLOSED" ? "closed" : `state ${prev.state} -> ${cur.state}`);
  if (prev.isDraft !== cur.isDraft) changes.push(cur.isDraft ? "converted to draft" : "marked ready for review");
  if (prev.head !== cur.head) changes.push(`head ${prev.head.slice(0, 8)} -> ${cur.head.slice(0, 8)}`);
  if (prev.base !== cur.base) changes.push(`base ${prev.base} -> ${cur.base}`);
  // A null baseline means the PR was first seen while GitHub still reported UNKNOWN.
  if (cur.merge !== null && prev.merge !== cur.merge) changes.push(prev.merge === null ? `merge state ${cur.merge}` : `merge state ${prev.merge} -> ${cur.merge}`);
  for (const [field, label] of [["reviews", "review"], ["comments", "PR comment"], ["threads", "review thread"], ["threadComments", "thread comment"]]) {
    const added = cur[field] - prev[field];
    if (added > 0) changes.push(`${added} new ${label}${added === 1 ? "" : "s"}`);
  }
  if (prev.unresolved !== cur.unresolved) changes.push(`unresolved threads ${prev.unresolved} -> ${cur.unresolved}`);
  const newlyFailing = cur.failing.filter((name) => !prev.failing.includes(name));
  if (newlyFailing.length) changes.push(`check failed: ${newlyFailing.join(", ")}`);
  if (!prev.checksComplete && cur.checksComplete) changes.push(cur.failing.length ? `checks finished, failing: ${cur.failing.join(", ")}` : "checks finished, none failing");
  // A rerun that started and passed between two polls never shows as pending.
  const recovered = prev.failing.filter((name) => !cur.failing.includes(name));
  if (prev.head === cur.head && prev.checksComplete && cur.checksComplete && recovered.length) changes.push(`check now passing: ${recovered.join(", ")}`);
  return { changes, next };
}

export function buildQuery(targets) {
  const fields = `number state isDraft headRefOid baseRefName mergeStateStatus
    reviews { totalCount } comments { totalCount }
    reviewThreads(first: 100) { totalCount nodes { isResolved comments { totalCount } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
      __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }`;
  const repos = new Map();
  for (const t of targets) {
    const k = `${t.owner}/${t.repo}`;
    if (!repos.has(k)) repos.set(k, { owner: t.owner, repo: t.repo, numbers: [] });
    repos.get(k).numbers.push(t.number);
  }
  const aliases = [];
  let body = "";
  [...repos.values()].forEach((r, i) => {
    body += `r${i}: repository(owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.repo)}) { `;
    for (const n of r.numbers) {
      body += `p${n}: pullRequest(number: ${n}) { ${fields} } `;
      aliases.push({ key: `${r.owner}/${r.repo}#${n}`, repoAlias: `r${i}`, prAlias: `p${n}` });
    }
    body += "} ";
  });
  return { query: `query { ${body}}`, aliases };
}

// Default state lives per working directory, so a caretaker's restarts share one
// baseline while two caretakers watching the same PR keep separate ones.
export const defaultStateDir = (cwd) => join(homedir(), ".cache", "babysit-pr-watch", createHash("sha256").update(cwd).digest("hex").slice(0, 16));

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`state file ${file} is unreadable (${err.message}); delete it or pass --rebaseline`);
  }
}

function writeState(file, state) {
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${file}.tmp`, file);
}

function graphql(query) {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", "graphql", "-f", `query=${query}`], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      // gh exits 1 whenever the response carries GraphQL errors, but still prints it.
      let out;
      try {
        out = JSON.parse(stdout);
      } catch {
        return reject(new Error((stderr || err?.message || "unparseable gh output").trim().slice(0, 300)));
      }
      // A missing PR is a NOT_FOUND error beside partial data; that is a target
      // mistake for the caller to report, not an outage worth retrying.
      const fatal = (out.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
      if (fatal.length || !out.data) return reject(new Error((fatal.length ? fatal : out.errors ?? []).map((e) => e.message).join("; ").slice(0, 300) || "no data"));
      resolve(out.data);
    });
  });
}

export function parseArgs(argv) {
  const opts = { rebaseline: false, intervalSec: 180, maxHours: 23, stateDir: null, specs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--rebaseline") opts.rebaseline = true;
    else if (a === "--interval-sec") opts.intervalSec = Number(value());
    else if (a === "--max-hours") opts.maxHours = Number(value());
    else if (a === "--state-dir") opts.stateDir = value();
    else if (a.startsWith("--")) throw new UsageError(`unknown option ${a}`);
    else opts.specs.push(a);
  }
  if (!(Number.isFinite(opts.intervalSec) && opts.intervalSec >= 30 && opts.intervalSec <= 3600)) throw new UsageError("--interval-sec must be between 30 and 3600");
  if (!(Number.isFinite(opts.maxHours) && opts.maxHours > 0 && opts.maxHours <= 168)) throw new UsageError("--max-hours must be above 0 and at most 168");
  opts.targets = parseTargets(opts.specs);
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.log(`pr-watch: ${err.message}`);
    process.exit(64);
  }
  const dir = opts.stateDir ?? defaultStateDir(process.cwd());
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "state.json");
  const state = opts.rebaseline ? {} : readState(stateFile);
  const { query, aliases } = buildQuery(opts.targets);
  const deadline = Date.now() + opts.maxHours * 3_600_000;
  // A GitHub outage shorter than this stays silent; longer means coverage is lost.
  const failureWindowMs = 30 * 60_000;
  let failingSince = null;
  let backoffMs = 60_000;
  let seeded = false;

  for (;;) {
    let data;
    try {
      data = await graphql(query);
      failingSince = null;
      backoffMs = 60_000;
    } catch (err) {
      failingSince ??= Date.now();
      if (Date.now() - failingSince >= failureWindowMs) {
        console.log(`COVERAGE_LOST: GitHub queries failed for ${Math.round((Date.now() - failingSince) / 60_000)} min: ${err.message}`);
        process.exit(2);
      }
      if (Date.now() >= deadline) {
        console.log(`NO_CHANGE: ${opts.maxHours} h elapsed, the last GitHub query failing (${err.message}). Run the same command again to keep watching.`);
        process.exit(0);
      }
      await sleep(Math.min(backoffMs, Math.max(1000, deadline - Date.now())));
      backoffMs = Math.min(backoffMs * 2, 10 * 60_000);
      continue;
    }

    const report = [];
    const missing = [];
    const notes = [];
    let open = 0;
    for (const a of aliases) {
      const node = data[a.repoAlias]?.[a.prAlias];
      if (!node) {
        missing.push(a.key);
        continue;
      }
      const { changes, next } = compare(state[a.key], fingerprint(node));
      state[a.key] = next;
      if (changes.length) report.push(`CHANGED ${a.key}: ${changes.join("; ")}`);
      if (next.threadsUnlisted) notes.push(`note: ${a.key} has ${next.threadsUnlisted} review thread(s) past the first 100; replies and resolutions there are not watched.`);
      if (next.state === "OPEN") open += 1;
    }

    // Print before saving the baseline: a crash in between repeats a report on the
    // next run instead of losing it.
    if (report.length || missing.length) {
      if (report.length) console.log(`pr-watch: ${report.length} PR(s) changed at ${new Date().toISOString()}`);
      for (const line of report) console.log(line);
      if (missing.length) console.log(`pr-watch: not found or not visible: ${missing.join(", ")}. Fix the targets.`);
      for (const line of notes) console.log(line);
      console.log("Act on these, then run the command again to keep watching.");
      writeState(stateFile, state);
      process.exit(0);
    }
    writeState(stateFile, state);
    if (open === 0) {
      console.log("ALL_DONE: every watched PR is merged or closed.");
      process.exit(0);
    }
    if (!seeded) {
      seeded = true;
      console.log(`pr-watch: watching ${aliases.length} PR(s), state ${stateFile}`);
    }
    if (Date.now() >= deadline) {
      console.log(`NO_CHANGE: nothing actionable in ${opts.maxHours} h. Run the same command again to keep watching.`);
      for (const line of notes) console.log(line);
      process.exit(0);
    }
    const jitter = 0.85 + Math.random() * 0.3;
    await sleep(Math.min(opts.intervalSec * 1000 * jitter, Math.max(0, deadline - Date.now())));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
