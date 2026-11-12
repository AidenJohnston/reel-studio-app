# The Plan document

How a daily creator works with an AI editor, kept as data in project.json `plan` (`ai/src/plan.ts`; schema in
`engine/reelengine/schema/project.schema.json`): the script, its beats, the b-roll plan as a word-to-visual table,
the music choice and the cover idea. The creator and the AI agree on it before the first edit, and the edit follows
it. Without a `plan` nothing changes: the first edit picks its own b-roll as it always has.

## What it holds

- **Script.** `draft` is the AI's draft (the Script screen's `writeScript`: its `script`, plus `hook` and
  `onScreenText`), `rewrite` the creator's own version (they always rewrite it). Both are kept, so a UI can show a
  redline. `locked` means locked to shoot: neither changes until it is unlocked. Locking splits the script to shoot
  (`rewrite`, else `draft`) into beats, one per line, keeping the visual and sound of each line that did not change.
- **Beats.** The script plan, one row per beat: line, visual, sound.
- **B-roll rows.** `id` (`p1`, `p2`, ...), `words` (the script words it goes over) and, once there is a transcript,
  `anchor` (the same words as word ids), `visual` (one line; a card's text), `source` (`own-file`, `library`,
  `fetched`, `card`, `animation`, `screen-recording`), `asset` (the file, once known), `treatment` (how it is shown;
  the source's default otherwise), `status` (`proposed`, `approved`, `rejected`), `hold` (seconds it should stay
  up: a hint for choosing the words), `note`, and `broll` (the project b-roll item it built).
- **Music** and **cover**: one line each.

## The flow

1. **The AI proposes** (`proposePlan`, the `plan:propose` job): one short run that reads the transcript and the
   library and calls `propose_plan` once. It changes only `plan`. Its rows are `proposed`; rows the creator already
   approved or rejected stay as they are.
2. **The creator decides** row by row (`plan:change`): approve, reject, edit, add. A row the creator adds is approved.
3. **The first edit builds only approved rows.** Before the AI starts, each approved row with its words and its file
   becomes a b-roll item (id = the row id). The AI cannot add or remove b-roll in that edit (`add_broll` and
   `remove_broll` are not offered, and refuse if called). It can only supply what an approved row still needs (the
   words in the transcript, the file, the look) with `update_plan_row`, and propose a missing visual as a new row,
   which waits for approval.
   - **Nothing approved yet:** the edit gets no b-roll, and its reply asks the creator to approve the rows they want.
     That is the default because it is the one that never puts an unapproved picture in a video. `buildProposed: true`
     is the explicit setting that builds proposed rows as if approved.
4. **Later, approving a row** that has its words and file puts it in the video's b-roll at once (the next render
   shows it). Rejecting a row takes its b-roll out.
5. **Notes keep the rows in step.** A note may still add, change or remove b-roll, but in a planned project nothing
   is in the video without a row: a picture a note adds becomes an approved row ("Added for a note."), a changed one
   carries its words, file and look back to its row, and a removed one makes its row rejected.

## Determinism

The plan reaches the video only through project.json `broll`, which `syncPlan` derives from the rows: in row order,
an item updated in place or appended, anchors found by the same phrase search every time (kept words first). The
same project.json and transcript always give the same b-roll, and syncing again changes nothing
(`ai/test/plan.test.ts`). The engine's edit signature counts only `plan.script` (captions may follow the locked
script), so approving a row that builds nothing does not make a new version.

## Markdown

`toMarkdown` and `fromMarkdown` carry the plan as text, for pasting to and from a chat:

```markdown
# Plan

## Script

Locked to shoot.

### Draft

Nobody tells you the hardest part of baking bread.

### Rewrite

Nobody warns you about the hardest part of bread.

## Beats

| # | Line | Visual | Sound |
|---|---|---|---|
| 1 | Nobody warns you about the hardest part of bread. | close on the face | soft piano |

## B-roll

| id | words | visual | source | status |
|---|---|---|---|---|
| p1 | fancy flour | their own bag of flour | own file | approved |

## Music

warm acoustic

## Cover

the brick loaf, text BREAD
```

The tables have no column for anchors, files, treatments, holds and notes. Imported onto the same plan, a row keeps
them (a row whose words changed is anchored again), and a row left out of the table is rejected, never deleted.
A table written elsewhere is read by its column names: rows numbered `1`, `2` become `p1`, `p2`, and rows without an
id get the next free ones. A locked script cannot be changed by an import.

## Surface

- App IPC (`app/src/main/plan-ipc.ts`; `window.api.plan` in the page): `plan:get`, `plan:change` (script, lock, row
  status, row, details, import; run as a held edit), `plan:markdown`, `plan:propose`.
- AI tools, offered only to the runs that name them: `propose_plan` (the proposal run) and `update_plan_row`
  (the planned first edit).

Not built yet: the UI, and a plan before there is a video (the app makes a project only from a dropped video).
