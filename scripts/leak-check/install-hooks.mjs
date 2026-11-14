// Point this clone's git at .githooks, so the leak check runs on every commit (docs/leak-check.md).
//
// npm runs this as the root `prepare` script, so the `npm install` that CONTRIBUTING.md asks for sets it up: a
// contributor can't forget a separate step. It writes one visible setting to this clone's .git/config, says so,
// and leaves an existing core.hooksPath alone. It never fails the install: a source archive without git, or a git
// error, only prints a line. Undo: git config --unset core.hooksPath
import { spawnSync } from "node:child_process";

const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
const HOOKS = ".githooks";

const inside = git("rev-parse", "--is-inside-work-tree");
if (inside.status !== 0 || inside.stdout.trim() !== "true") process.exit(0);

const local = git("config", "--local", "--get", "core.hooksPath").stdout.trim();
if (local === HOOKS) process.exit(0);
if (local) {
  console.warn(`leak check: this clone's core.hooksPath is "${local}", so the leak-check hooks in ${HOOKS} are not active. To use them: git config core.hooksPath ${HOOKS}`);
  process.exit(0);
}

const inherited = git("config", "--get", "core.hooksPath").stdout.trim();
if (git("config", "--local", "core.hooksPath", HOOKS).status !== 0) {
  console.warn(`leak check: could not set core.hooksPath; run: git config core.hooksPath ${HOOKS}`);
  process.exit(0);
}
console.log(
  `leak check: git now runs the hooks in ${HOOKS} for this clone.` +
    (inherited ? ` Your global core.hooksPath ("${inherited}") no longer runs here.` : "") +
    " Undo: git config --unset core.hooksPath",
);
