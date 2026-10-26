---
name: ship-pr
description: Takes finished work from a dirty tree to an open pull request. Branches, commits via commit-changes, pushes, and opens the PR with a body a reviewer can act on. Use for "open a PR", "ship this", "push this up". Never force-pushes and never merges. For the commit alone, commit-changes is enough.
---

# Ship a pull request

`commit-changes` ends at the commit. This picks up there and ends at an open PR.

Everything below is reversible until the push. The push is the first step a
reviewer can see, so the checks happen before it.

## Before starting

- A clean tree with an already-pushed HEAD and an open PR needs no new commit. Report the existing URL and continue to `babysit`. A clean tree with unpushed commits, or a pushed branch with no PR, continues from step 4 or 5.
- If HEAD is the repository's default branch, create a topic branch before committing or pushing, even for a trivial change.
- The diff mixes unrelated work. Say which files belong to which change and ask
  which one is being shipped. A PR that does two things gets reviewed as neither.
- There is no upstream remote. Nothing to push to.

## Sequence

1. **Read the state.** `git status --porcelain`, `git diff --stat`, and
   `git log --oneline -5`. Name what changed before deciding anything.

2. **Branch from current `main`.** Run `git fetch origin`. If HEAD is `main`, create the topic branch from `origin/main` using the repository's naming convention (a short topic name here, such as `modal-focus-trap`). In a fork, `main` means this repository's `main`: fetch, branch and rebase from the `upstream` remote wherever these steps say `origin`, and push to the fork.

3. **Commit.** Invoke `$commit-changes`. It runs `$deslop` as a required gate and
   writes the message. Do not write the commit message here; that skill owns it.

4. **Sync and validate, then push.** Bring in `main` again: `git fetch origin` and `git rebase origin/main` while the branch has never been pushed, or `git merge origin/main` once it has. Then run the repository's checks, here the list under "Checks to run" in `CONTRIBUTING.md`. If one fails because of your change, fix it, commit the fix through `$commit-changes`, and rerun every check on the new HEAD. Push only once they all pass: `git push -u origin <branch>` from the topic branch, never from `main`. Never `--force` and never
   `--force-with-lease`. If the push is rejected, report the rejection and next step.
   Rewriting a pushed branch is a decision the author makes, not the agent.

5. **Open or reuse the PR.** First `gh pr list -R <owner/repo> --head <branch> --state open --json number,url,headRepositoryOwner,baseRefName`. Confirm the head repository and intended base, not just the branch name. Reuse the matching PR and continue to step 6; do not open a duplicate. If none matches, follow explicit repo title rules or recent titles from `gh pr list -R <owner/repo> --state all --limit 10`, then `gh pr create -R AidenJohnston/reel-studio-app --base main` with the body prepared through `pr-writing`. Create a draft when incomplete; otherwise open for review. Do not change an existing draft's state.

6. **Report the URL.** Continue with `babysit` when the user wants the PR watched through CI and review. The maintainer merges.

## PR body

Use [pr-writing](../pr-writing/SKILL.md) for the title, description and evidence. Read the repository template and current body, explain the final behavior, and verify the published presentation. Preserve human edits, attachments and bot-managed sections. Use a body file with `gh` so shell quoting cannot alter the prose.

## What this never does

- **Never merges or enables auto-merge.** The maintainer merges.
- **Never force-pushes.** A rejected push is reported, not resolved.
- **Never edits a PR someone else opened** without being told to.
- **Never marks a draft ready** on its own. Draft to ready is a judgment about
  whether the work is done.
- **Never commits secrets.** `commit-changes` gates on `$deslop`, but check the
  diff for keys, tokens, `.env` files, and account identifiers before pushing.
  A pushed secret is public even after a revert.

## Responding to review

When review comments arrive, read them all before changing anything. Then:

- Group them. Several comments often name one underlying problem, and fixing that
  once is better than five local patches.
- Fix and push as normal commits. Do not amend or rebase a branch under review;
  it destroys the reviewer's diff-since-last-look.
- Reply to each thread saying what changed, or why it did not. A comment left
  unanswered reads as ignored.
- Disagree when the review is wrong. Say what the reviewer may not know. Silent
  compliance with a wrong suggestion is worse than the original code.
- Do not let review feedback expand the PR past the original goal. A good
  suggestion outside scope becomes a follow-up issue, not a commit here.

## Autonomy boundary

Running this without asking is fine when the user said to ship, open a PR, or push.

Stop and ask if the requested scope or authorization does not cover a change to auth, payments, migrations, deletion or production config, or if the diff contains work outside the agreed goal. Do not ask again for work the user already authorized.

When a check fails, report it and fix failures caused by the requested change before pushing. An unrelated failure, missing access or user-owned decision gets a blocker report with the next step. Never hide a failure or broaden the PR just to make CI green.

Hand off to `babysit` when the user wants the PR watched; it owns the review loop, not the merge.
