# Agent guide

Reel Studio turns a raw talking-head video into a finished Reel. `CONTRIBUTING.md` has the product rules, setup and the checks to run. Read `docs/architecture.md` before changing how the parts talk to each other: the AI edits `project.json`, and the engine renders it.

## Skills

`.claude/skills` holds the skills below; `.agents/skills` links to the same folder for other agents. Read the matching `SKILL.md` before the task.

| Task | Skill |
| --- | --- |
| Any prose: docs, UI copy, code comments, commit messages | `unslop` |
| README, CONTRIBUTING or other docs | `technical-writing` |
| Editing AGENTS.md or a skill, or briefing another agent | `prompt-writing` |
| Reviewing your diff | `deslop` |
| Committing (it runs `deslop` first) | `commit-changes` |
| Branching, pushing and opening the PR for finished work | `ship-pr` |
| Watching an open PR through CI and review | `babysit` |
| PR title and body | `pr-writing` |
| Writing, changing or reviewing a test | `test-audit` |

## Branches, commits and PRs

- Branch from current `main` with a short topic name, such as `modal-focus-trap`.
- Write commit subjects and PR titles as Conventional Commits: `type(scope): subject`, such as `fix(engine): retry the project.json rename`. The scope is the area you touched, such as `engine`, `ai`, `ui`, `style` or `win`.
- Before you push, run every check under "Checks to run" in `CONTRIBUTING.md`, including the leak check.
- The maintainer merges. Leave files outside your task alone.

## Tests

Run `npm test` for the app and AI packages and `python -m pytest tests` in `engine`. A test earns its place only when it would fail if something a user or a saved `project.json` can observe broke. `test-audit` says which tests to write and which to delete.
