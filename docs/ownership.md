# One writer per project

Every writer of a project holds `<project>/work/.owner.lock` while it writes: an app job, a manual edit, the app's own
commands outside a job, the engine run by hand and the AI dev CLI. The code is app/src/main/owner.ts (the app),
engine/reelengine/owner.py (the engine) and ai/src/owner.ts (the AI package); this page is the protocol they share.

## The lock

The lock holds its writer's identity as JSON:

- `app`: `Reel Studio` for this app; anything else (`reelengine`, `reelstudio-ai`) is a tool run by hand.
- `pid` and `started`: the writer's process and the clock time it started, in ms. A pid reused by another process has
  another start time.
- `token`: what a command that joins the writer passes as `--owner`.
- `engines` (the AI dev CLI): each engine process it started, with its start time.

## States and transitions

| From | Event | To |
| --- | --- | --- |
| absent | a writer claims: it writes its identity to a temporary file, then hard-links that file to the lock | held |
| absent | the same, on a disk with no hard links (FAT, exFAT): exclusive create, then the identity | held, unreadable for an instant |
| held | a command runs with `--owner T` | unchanged; it runs only while the lock's token is `T` |
| held | the writer ends | absent; it removes the lock only while the token there is still its own, and the app first waits for the commands that joined it |
| held by this app, or by a previous run of it | the app claims the project | held by the new claim (the single-instance lock means no other app runs; startup has stopped what the last run left) |
| held by a tool run by hand that is alive | anyone claims | refused (`PROJECT_IN_USE`, `PROJECT_OPEN`) |
| held by a tool run by hand that has exited | the app claims | refused until every engine it recorded and every engine or ffmpeg naming the folder has exited; then the app removes the lock and claims |
| held by a tool run by hand that has exited | a tool run by hand claims | refused, naming the lock: only the app reclaims |
| unreadable | anyone | refused, and never removed automatically: an empty lock may be one being written |

A writer is alive while its pid runs with a start time within 10 s of `started`. When the system won't say, it counts
as alive.

## At startup

1. The engines the last run recorded are stopped, and every project with a leftover lock is scanned for an engine or
   ffmpeg naming it (orphans.ts). One that is found keeps that video closed until it exits.
2. Leftover locks are removed under the reclaim rules above. One a live tool run by hand holds, an unreadable one, and
   one whose former writer's engines still run stay.
3. Recovery claims each project before it cleans it (store.ts recoverInterrupted). A project it can't claim is left
   for the next start or job.

## The app's own commands outside a job

The edit drawer's pace and match previews and the cover picker's scan write caches and stills in the project, so they
are writers (app/src/main/jobs.ts withOwner). Beside a job or a manual edit they join its claim, which then lets go
only once they have ended. With neither, the app claims the project while any of them runs, and a job asked for
meanwhile waits (a queued note starts once they end). They read project.json as it is and never finish a pending trial
transaction (variation.py), which could replace what a note they joined publishes.

## Inside one claim

`<project>/.project-owner.lock` (engine/reelengine/project.py `owner_lock`) is not a claim. It is an OS lock that
serialises project.json writes inside one claim: the engine commands a job runs share the job's token, and this lock
keeps two of them from writing project.json, or finishing a trial, at the same moment. The system frees it when its
process exits.

## What runs without the lock

Commands that change nothing in the project, `attach`, which only adds its own uniquely named file, and `proxy`,
which writes only work/proxy/ under its own per-take lock and outlives the job that starts it (engine/reelengine/cli.py
NOT_PROJECT_WRITES).
