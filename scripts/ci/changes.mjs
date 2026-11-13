#!/usr/bin/env node
// Which gated CI jobs a change needs. A path matching no rule runs every job.
//   node scripts/ci/changes.mjs --github            in CI: diff the PR's merge commit, write outputs to $GITHUB_OUTPUT
//   node scripts/ci/changes.mjs --print [files...]  print the decision for these files, or for this branch vs origin/main
//   node scripts/ci/changes.mjs --run               run the needed checks locally (npm run check:changed)
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const INERT = [
  /^docs\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.github\/(pull_request_template\.md|labels\.json|CODEOWNERS)$/,
  /^\.github\/workflows\/(labels|pr-size|pr-labels)\.yml$/,
];

const RUNS_EVERYTHING = [/^\.github\/workflows\/ci\.yml$/, /^scripts\/ci\//, /^\.gitattributes$/];

export const JOBS = {
  // Covered by the always-on Node job; listed so they don't count as unknown.
  node: [/^(app|ai|packaging)\//, /^package(-lock)?\.json$/],
  engine: [/^engine\//, /^packaging\/(requirements[^/]*\.txt|hash_requirements\.py)$/],
  animations: [/^templates\//],
  none: [
    /^scripts\/leak-check\//,
    /^\.github\/workflows\/leak-check\.yml$/,
    // The leak check's hooks: tested by the Node job, which always runs.
    /^\.githooks\//,
    /^\.claude\/settings\.json$/,
    /^\.codex\/hooks\.json$/,
  ],
};
const JOB_NAMES = ["engine", "animations"];

export function decide(files) {
  const needed = new Set();
  const why = {};
  const mark = (job, file) => {
    needed.add(job);
    (why[job] ??= []).push(file);
  };
  for (const file of files) {
    if (INERT.some((re) => re.test(file))) continue;
    if (RUNS_EVERYTHING.some((re) => re.test(file))) {
      JOB_NAMES.forEach((job) => mark(job, file));
      continue;
    }
    const matched = Object.entries(JOBS).filter(([, rules]) => rules.some((re) => re.test(file)));
    if (matched.length === 0) {
      JOB_NAMES.forEach((job) => mark(job, `${file} (unknown path)`));
      continue;
    }
    for (const [job] of matched) if (JOB_NAMES.includes(job)) mark(job, file);
  }
  return { jobs: Object.fromEntries(JOB_NAMES.map((job) => [job, needed.has(job)])), why };
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const everything = (reason) => ({ jobs: Object.fromEntries(JOB_NAMES.map((job) => [job, true])), why: { all: [reason] } });

function changedInCI() {
  // --no-renames lists both sides of a move, so a file moved out of engine/ still counts.
  return git("diff", "--no-renames", "--name-only", "HEAD^1", "HEAD");
}

function changedLocally() {
  const base = git("merge-base", "origin/main", "HEAD")[0];
  const files = new Set([
    ...git("diff", "--no-renames", "--name-only", base, "HEAD"),
    ...git("diff", "--no-renames", "--name-only", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]);
  return [...files];
}

function safely(list) {
  try {
    return decide(list());
  } catch (error) {
    return everything(`could not list the changed files (${error.message.split("\n")[0]})`);
  }
}

function report({ jobs, why }) {
  for (const job of JOB_NAMES) console.log(`${job}: ${jobs[job] ? "run" : "skip"}${why[job] ? `  (${why[job].slice(0, 3).join(", ")}${why[job].length > 3 ? ", ..." : ""})` : ""}`);
  if (why.all) console.log(`every job: ${why.all[0]}`);
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n== ${label}: ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  return result.status === 0;
}

function runLocally(decision) {
  report(decision);
  const results = [];
  results.push(["build, typecheck and Node tests", run("build ai", "npm", ["run", "build", "-w", "ai"]) && run("typecheck", "npm", ["run", "typecheck"]) && run("tests", "npm", ["test"]) && run("build app", "npm", ["run", "build", "-w", "app"])]);
  if (decision.jobs.engine) {
    const python = join("engine", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
    if (!existsSync(python)) results.push(["engine tests", null]);
    else results.push(["engine tests", run("engine", python, ["-m", "pytest", "engine/tests", "-q"])]);
  }
  if (decision.jobs.animations) {
    const dir = join("templates", "animations");
    if (!existsSync(join(dir, "node_modules"))) results.push(["animation rendering", null]);
    else results.push(["animation rendering", run("animations", "npm", ["test"], { cwd: dir })]);
  }
  console.log("\nCI also runs the Node job on the other two systems.\nSummary:");
  for (const [name, ok] of results) console.log(`  ${ok === null ? "NOT RUN (set it up first, see CONTRIBUTING.md)" : ok ? "passed" : "FAILED"}  ${name}`);
  process.exit(results.every(([, ok]) => ok === true) ? 0 : 1);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "--github") {
  const decision = safely(changedInCI);
  report(decision);
  const out = process.env.GITHUB_OUTPUT;
  if (out) for (const job of JOB_NAMES) appendFileSync(out, `${job}=${decision.jobs[job]}\n`);
} else if (mode === "--print") {
  report(rest.length ? decide(rest) : safely(changedLocally));
} else if (mode === "--run") {
  runLocally(safely(changedLocally));
} else {
  console.error("usage: changes.mjs --github | --print [files...] | --run");
  process.exit(2);
}
