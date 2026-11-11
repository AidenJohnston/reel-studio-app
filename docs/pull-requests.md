# How a pull request moves

A pull request's state lives in GitHub itself (draft or ready, review requests, reviews, assignees, checks and the
merge box), not in labels. So each person's GitHub inbox shows exactly what is theirs to do.

## The states

| State | How GitHub shows it | Whose move |
|---|---|---|
| Still being worked on | **Draft** | the author |
| Ready for review | **Ready** + a **review request** | the reviewer |
| Changes needed | a **Request changes** review | the author: fix, then re-request review |
| Needs a decision | **assigned** to the person who decides + a comment starting `Decision needed:` with a yes/no or pick-one question | the assignee |
| Conflicts or failing checks | the merge box and the checks | the author |

Labels describe the change, never its state: `size:*`, `type:*`, `area:*` and `priority:*` (set automatically,
except priority). There are no "waiting for CI", "has conflicts" or "ready" labels.

**Ready means:**
- rebased on `main`;
- the required checks are green on the head commit;
- the template is filled in;
- one idea per PR.

A ready PR that goes red or conflicts and isn't fixed within a day goes back to draft.

## Who is asked

- **A review request means "review this".** It lands in the reviewer's "Review requested" list.
- **An assignee is the one person whose decision or action is blocking the PR.** It is not the author:
  "Authored by me" already covers that.
- **Hand a PR on** with `gh pr ready N`, then either `gh pr edit N --add-reviewer <login>` or
  `gh pr edit N --add-assignee <login>` plus the `Decision needed:` comment.

Write that comment for a stranger: this repo is public.

## Branch names

`<owner>/<type>/<topic>`, for example `sam/feat/caption-presets`:
- **Owner:** the person the work is for. An agent uses its person's name, and its own model goes on the PR's
  `Agent:` line, not in the branch.
- **Type:** a Conventional Commits type (`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
  `chore`, `revert`).
- **Topic:** a few kebab-case words.
- **Stacks** number the topic (`note-atomic-1-contain`, `-2-owner`), and the body's first line says
  `Stack: 2 of 3, after #137`.

**Rebase in place.** To update a PR, rebase its own branch and `git push --force-with-lease`. Never open a new branch
or PR for a rebase: the old one stays open as a duplicate.

## Titles

The PR title becomes the squashed commit on `main`: `type(scope): subject`, in plain words, saying what changes for
the user where it can. The **PR title** check (`.github/workflows/pr-title.yml`) enforces the format.

## Rules for agents

An agent does everything up to the click:
1. It opens every PR as a **draft**.
2. It marks the PR **ready** when the "Ready means" list holds.
3. It requests the reviewer or assigns the decider.
4. It stops.

It may file a **Request changes** review for its person when a check fails or a bug reproduces. It never runs
`gh pr merge` in any form (`--auto` included), never adds a PR to a merge queue, never turns on auto-merge and
never approves. Merging is a person's click.

## Daily queues

Bookmark these GitHub searches, each with `repo:getcurate/reel-studio is:open` in front:

| Queue | Search |
|---|---|
| Review these | `is:pr draft:false review-requested:@me` |
| Decide or act | `assignee:@me` |
| Mine, sent back | `is:pr author:@me draft:false review:changes_requested` |
| Mine, red | `is:pr author:@me draft:false status:failure` |
| Reviewed and green: merge | `is:pr draft:false status:success review:approved no:assignee sort:created-asc` |
| Mine, green, no review asked | `is:pr author:@me draft:false status:success review:none no:assignee` |
| Issues to triage | `is:issue no:assignee sort:created-asc` |

Conflicting PRs have no search keyword. List them with:
`gh pr list --json number,mergeable,isDraft --jq '.[] | select(.mergeable == "CONFLICTING" and (.isDraft | not)) | .number'`.
