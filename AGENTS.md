# Working on Reel Studio

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md) first. They own setup, the
checks to run and the pull request rules. Everything else follows one rule: the AI edits `project.json` through a
fixed set of tools, and the engine renders it.

## Check every surface

The most common gap in a change is that it works on the path you tried and nowhere else. Before you call work done,
go through this list. In the pull request's Verification section, say which items applied and what you checked.

- **Mac and Windows.** Paths, file names with spaces or accents, and encoders differ. Drafts use the hardware
  encoder (VideoToolbox on Mac; NVENC, AMF or QSV on Windows) and retry in software when it fails. CI runs the Node
  checks on both, runs the engine tests only on Linux and doesn't run the Electron e2e tests, so name the systems
  you ran.
- **The screen and the AI.** Something a user can do on screen is usually something the editor should be able to
  do through a tool in `ai/src/tools.ts` (architecture section 6), and what the AI changes has to show on screen.
  Fixing one side isn't fixing the feature.
- **Every provider, and none.** Each provider in `ai/src/providers/` needs a decision, even if it's "not supported
  here". The app also works with no AI connected (architecture section 1); say what your change does then.
- **Every kind of render.** A change to how a video looks or sounds has to come out the same in a draft
  (`render --draft`), a window (`render --window a:b`), the frames the editor checks (`look_at_frames`) and the
  final export. A draft may be smaller and softer. It may not show different words, timing or placement.
- **Notes and My style.** Check the change through a note, not only on the first edit. A note's render becomes a
  new version (`docs/versions.md`), and a lasting preference saved to My style applies to every future video.
- **Contracts and old projects.** Anything that crosses between the app, `ai/` and the engine (the engine's
  JSON-lines output in architecture section 4, the types in `app/src/shared/`) changes on every side in the same
  pull request. `project.json` changes are additive (`docs/schema-changes.md`): open a project saved before your
  change and check it still renders.
- **Export and the phone.** A change to the finished video has to play from the export folder and through "Send to
  my phone", which plays it in the phone's browser (`app/src/main/phone-share.ts`).
- **Posting.** Posting stays hidden unless `REELSTUDIO_POSTING=1`, and with it off nothing about posting should
  show. A change to what the app sends (`app/src/shared/posting.ts`) needs the matching change in the posting
  server, which lives in a separate repository.
- **The way back out.** If you add a way in, add the way out and a way to see which state you're in. A job that
  starts can be stopped, a setting turned on can be turned off, and a saved style rule can be removed.
- **Words and errors.** Plain words on screen and no em dashes (CONTRIBUTING.md). Every failure says what to do
  next: no network, the AI signed out or at its plan's limit, the engine crashing, a full disk, a file that moved.
- **Rules that block something.** If the change blocks or limits something, such as a style rule the engine checks
  or an update that needs a purchase, list the other ways to reach the same result: another screen, the AI, running
  the engine directly, an older or imported project. Close each one, or say in the pull request why it stays open.
- **Docs.** Code comments cite sections of `docs/architecture.md`. Update the section when you change what it
  describes, and the README when a user would notice.
