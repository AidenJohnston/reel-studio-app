# Reel Studio 0.2.0: what goes in, what waits, and why

This file is for whoever merges and ships 0.2.0. It says which open pull requests are in the release, how each one got there, and what is still open. It is updated as the branch moves. The release PR links here.

## What 0.2.0 is

0.2.0 is the new editing UI from `ui/capcut-timeline`: the timeline, SubtitlesTab, CutTab, NotesLog and the version diff. On top of that it carries every open pull request that still makes sense once the redesign is in.

Sam set the scope on Nov 14: every open PR goes in. A PR written against main's old screens gets its behaviour ported onto the redesign. A PR stays out only when another PR replaces it or it cannot work, and this file gives the evidence.

## How the branch is built

1. `release/0.2.0` starts at `ui/capcut-timeline` (9dc6a8f0). That branch was 1307 commits ahead of main and 11 behind.
2. Main's 11 newer commits are merged in (10cfa4bc). Three files conflicted, all GitHub config: `.github/VOUCHED.td`, `.github/labels.json` and `.github/workflows/labels.yml`. Main's #181 had folded size, type, area and trust labelling into `labels.yml` and deleted `pr-size.yml` and `pr-vouch.yml`. Main's versions won, and the redesign's copies of those two workflows were removed, because keeping them would label every PR twice with different size thresholds. The redesign's `DO NOT MERGE` label and its two trusted authors were kept.
3. PRs that merged with no conflicts went in as they are: #186, #188, #122, #148, #141. #188 keeps `ui/capcut-timeline` as its base. Its head 812da975 is already in this branch, so it stays open as the review record of the hill climb's round 0. Retargeting it would show an empty diff.
4. A CI trigger was added so pushes to `release/**` and `port/**` run the full matrix (adf5f035). Before this, CI had never run on `ui/capcut-timeline`: it had no push trigger and no PR until #188.
5. The rest are ported in four groups, each on its own branch, then merged here in dependency order. Each group's conflict resolutions are logged in its merge commits. The groups are listed below.

## Already in the redesign (36 PRs, close after merge)

These PRs' commits are all in `ui/capcut-timeline` already. The check: `git rev-list --no-merges release/0.2.0..<PR head>` is empty, or `git cherry` shows every commit as already applied. The only commits these PRs have beyond the redesign are merges of main into the PR branch.

#18 #19 #22 #29 #30 #31 #32 #33 #35 #37 #46 #50 #52 #53 #55 #56 #58 #59 #60 #63 #64 #67 #69 #71 #72 #73 #75 #76 #77 #83 #84 #85 #86 #87 #92 #115

Recommendation: close each with a comment pointing at the release PR once it merges. Nobody has closed them yet.

## Replaced by other PRs

- **#175** (Aiden's merge train of 22 PRs onto main). Its PRs are ported one by one here instead, in the order it used. Its twelve fixes for PRs that clash without a textual conflict are carried into the ports that need them.
- **#4** (full-screen preview) is replaced by #133, its rebased version.
- The r1104 drafts #116 to #147 are rebased versions of PRs already in the redesign. Only what they added after review is ported.

## Port groups

| Group | Branch | PRs |
|---|---|---|
| Notes and AI core | `port/0.2.0/notes-core` | #137 #138 #139 #140 (atomic notes, one writer per project), #144, #143, #135, #117, #129, #145, #127, #128, #153, #34 |
| Render engine | `port/0.2.0/engine` | #124, #116, #146, #156, #151, #149, #154, #155, #172, #173, #178, #180 |
| UI | `port/0.2.0/ui` | #3, #133 (for #4), #17, #126, #130, #131, #132, #118, #147, #134, #142, #152, #174, #185 |
| CI, updater, packaging (landed) | `port/0.2.0/ship` | CI green on all three OSes, #120, #121, #179, #123, #125, #136, #168, #169, #177 |
| Second wave, after notes core and engine land | to be named | #157, #150, #184, #170, #171, #182, #183 |

The second wave waits because those PRs are built on the new note flow from #140 (#182 contains #140; #170 and #184 contain #157; #175 says #157 and #150 were written against the note flow #140 replaces).

## Needs Sam

1. **Private material in a public repo.** The Leak check fails on two things that are on `ui/capcut-timeline`, which is already public:
   - `.claude/skills/test-audit/`, a copy of Sam's private skill. Recommendation: remove `.claude/skills/` from the product repo. Agent config isn't product.
   - The first-run sample media in `app/src/renderer/src/assets/sample/` (`raw.mp4`, `ai.mp4`, `cut.mp3`, `ready.mp3`). Question: who appears in `raw.mp4` and `ai.mp4`, and is that footage cleared for public use?
   The files stay as they are on this branch until Sam decides, so the release PR's Leak check is expected to fail. The check runs main's rules on every PR (`pull_request_target`); those rules were not changed and nothing routes around them.
2. **Which branch ships.** To be filled in with the recommendation in the release PR.
3. **AI context budget.** 0.2.0 sends more fixed context than main: 634,443 characters and 42 tools, against main's 447,274 and 26, measured in CI run 43592033947. `ai/context-budget.json` is re-pinned to the measured numbers. A PR into main that grows the budget needs the `ai-context-increase` label, so the release PR needs that label from Sam.
4. **Engine version.** The app is 0.2.0, and the engine stays at 0.1.2. The engine's version is part of each render's fingerprint, so bumping it makes saved projects render again instead of reusing their last render. Recommendation: bump the engine to 0.2.0. The redesign's engine renders differently (for example #186 runs the final scale on one thread), and stopping old renders from being reused is what the fingerprint is for.
5. **#177's leak-check hooks.** #177 lets `.claude/settings.json` through the check, because that file carries the repo's agent hook, and it scans PR titles and bodies. Both changes are #177's own; nothing else in the check's rules changed.

## Status

Updated as each group lands.

- Base: `release/0.2.0` at adf5f035. Baseline runs for the redesign alone: 43591769985 (`ui/capcut-timeline`) and 43592236522 (`port/baseline-9dc6a8f0`).
- CI, updater and packaging landed (merge 1e0e4a0d). CI at the port's head passes on Node (ubuntu, macOS, Windows), Engine and Animations (run 43594737341). Installers built and passed their bundled-engine check on Windows and macOS (run 43594423556). #120, #121, #179, #123 and #125 are ported. #168, #169 and #177 are merged. #136 was already in. Version is 0.2.0 in the root, app and ai packages. Every CI failure fixed there was already on the redesign except two: the context budget, which came from main's #160, and the HDR draft filter-chain test, which #186 changed.
