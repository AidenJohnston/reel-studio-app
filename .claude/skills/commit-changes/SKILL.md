---
name: commit-changes
description: Clean up, review, validate, and commit a repository's intended changes. Use when asked to commit, make a commit, write a commit message and commit, or finish local changes as a Git commit. Always invoke $deslop across every staged file before drafting the message or running git commit.
---

# Commit changes

Create one intentional Git commit without disturbing unrelated work.

## Workflow

1. Confirm the repository and intended scope from the request and current working tree. Inspect `git status --short`, the unstaged diff, and the staged diff. Preserve unrelated edits and existing staged changes; ask only when the intended boundary cannot be inferred safely.
2. Load and invoke `$deslop`. Treat it as a required gate even when the diff already looks clean. Review every file and changed hunk in the intended staged scope; do not sample. Apply its behavior-preserving direct fixes and small quality improvements, and retain any structural handoff it produces.
3. After `$deslop` finishes, inspect status and both diffs again. Stage only the intended paths or hunks. Never use blanket staging when unrelated changes are present. Review `git diff --cached --check` and account for every path in the complete `git diff --cached` before committing.
4. Run the narrowest relevant validation available for the staged work. Do not silently expand scope to repair unrelated failures. Report any skipped or failing validation accurately.
5. Only now draft the commit message from the final staged diff. State the commit's purpose in one plain sentence before writing the subject. If the diff has no coherent one-sentence purpose, revisit the commit boundary.
6. Commit non-interactively with the prepared message. Do not amend, bypass hooks, sign, push, or open a pull request unless explicitly asked.
7. Verify the commit with `git status --short` and `git show --stat --oneline --decorate --no-renames HEAD`. Report the commit hash, subject, validation, and any remaining working-tree changes.

## Commit message writing

Write for a reviewer who has not watched the work happen. Make the product or
engineering outcome clear without asking them to reconstruct it from a list of
files, packages, or subsystems.

### Subject

- Use Conventional Commits: `type(scope): subject` with a lowercase type (`feat`, `fix`, `docs`, `refactor`, `chore`, `build`, `ci`, `test`). Pick the scope the way AGENTS.md says.
- Keep the header ≤ 72 characters: imperative mood, lowercase after the colon, no trailing period. Name the specific outcome.
- Prefer concrete verbs such as `add`, `fix`, `prevent`, `migrate`, or `remove`. Avoid broad verbs such as `ship`, `update`, or `integrate` when they hide what changed.
- Keep implementation trivia out unless it is the point of the commit.

### Body

- Omit the body when the subject fully explains a focused change.
- Otherwise default to outcome-based bullets: one reviewer-relevant outcome per bullet. Group files and implementation steps that serve the same outcome; do not give every touched system its own bullet.
- Give each bullet one clear job: say what changed and, when it is not obvious, why it matters.
- Use as many bullets as clarity requires and no more. Never target a count or pad the message.
- Prefer plain sentences over noun piles, long lists, repeated conjunctions, and dense clause chains.
- Keep technical terms that clarify behavior, architecture, risk, or compatibility. Drop details that only prove how much work happened.
- Mention cleanup from `$deslop`, validation, or unresolved follow-up only when it changes how reviewers should understand or handle the commit.

Before committing, read the complete message once as prose. Revise it if the
subject is vague, the body repeats the subject, equally weights minor and major
work, or reads like an inventory.

For example, replace a sentence such as "Integrate the queue, CLI package,
dashboard surfaces, and release CI" with outcome-based bullets such as:

- Run submissions through the new queue with retry-safe status updates.
- Package the CLI for the supported installation path.
- Add the checks required to release those changes safely.

Inspect touched code for `TODO`, `FIXME`, `TBD`, placeholder prose, or requests
for follow-up before drafting. Mention an unresolved item in the message only
when it materially limits the commit or affects the next reviewer.

## Guardrails

- `$deslop` must run across the complete intended staged snapshot before writing any proposed or final commit message and before `git commit`. Every staged path must be covered, including generated files, lockfiles, tests, documentation, and configuration. If later edits materially change the diff, run `$deslop` again before redrafting and committing.
- Never commit secrets, generated credentials, local environment files, or suspicious large binaries without explicit confirmation.
- Never discard, reset, stash, or rewrite other people's changes to obtain a clean tree.
- Stop before committing if the staged diff is empty, conflicted, unexpectedly broad, or cannot be attributed safely to the requested work.
- If hooks change files or reject the commit, inspect the result, re-run the required cleanup and review cycle when needed, then retry only when safe.
