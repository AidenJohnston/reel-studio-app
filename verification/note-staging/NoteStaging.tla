--------------------------- MODULE NoteStaging ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Mutation, Writer, MaxCrashes, PreviewOnly
ASSUME Mutation \in {"none", "project-first", "no-hash", "no-lock",
                     "cache-alias", "cache-overwrite", "cache-copy-live",
                     "no-lock-writer-first", "preview-publish", "preview-grant",
                     "rewrite-version", "recovery-drains-one", "no-manifest",
                     "append-after-commit", "no-credits-restore", "restore-newer-credits"}
ASSUME Writer \in {"none", "manual", "legacy-cover", "external-credits"}
ASSUME MaxCrashes \in 0..2
ASSUME PreviewOnly \in BOOLEAN

Assets == {"asset", "thumb"}
CacheKeys == {"existing", "new"}
VersionFiles == {"export", "snapshot", "metadata", "notes",
                 "cache-existing", "cache-new"}
PreparedFiles == {"snapshot", "metadata", "commit", "merged-credits", "manifest"}
StageFiles == Assets \cup VersionFiles \cup
              {"project", "input", "cache", "work-new", "credits", "temp", "promotion-temp", "commit", "merged-credits", "manifest", "restore"}
EmptyStage == [f \in StageFiles |-> 0]
EmptyVersion == {}
OldVersion == VersionFiles
VARIABLE s
vars == <<s>>

Live(d) == <<d.project, d.assets, d.credits, d.oldVersion, d.version,
             d.liveCache, d.appendTemp>>
Disk(d) == <<Live(d), d.stage, d.stageDir, d.creditsTemp, d.prepared>>
InitialDisk ==
  [project |-> "old", assets |-> {}, credits |-> "old",
   oldVersion |-> OldVersion, version |-> EmptyVersion,
   liveCache |-> [k \in CacheKeys |-> IF k = "existing" THEN 2 ELSE 0], appendTemp |-> 0, creditsTemp |-> 0,
   stage |-> EmptyStage, stageDir |-> FALSE,
   prepared |-> [f \in PreparedFiles |-> 0]]
Committed(d) == d.project \in {"committed", "new"}
StagePresent == {f \in StageFiles : s.disk.stage[f] > 0}
PublishPCs ==
  {"hash", "cache-snapshot", "prepare", "staging-sync", "prune", "assets-check", "assets",
   "credits-check", "credits-write", "credits-rename", "version-check",
   "version-rename", "project-write", "project-check", "project-rename",
   "set-published", "project-sync", "style", "append-write", "append-rename",
   "promote-select", "promote-copy", "promote-rename", "release"}
Checks == {"begin-read", "begin-return", "work-check", "publish-lock",
           "cache-snapshot", "assets-check", "credits-check", "version-check", "project-check", "preview-check"}

Init ==
  s = [disk |-> InitialDisk, pc |-> "begin-lock", owner |-> "free",
       base |-> "unset", writerPC |-> "idle", writerRead |-> "unset",
       writerTemp |-> 0, abort |-> FALSE, fault |-> "none",
       mode |-> "running", crashes |-> 0, recoveryPC |-> "idle",
       recoveryRuns |-> 0, firstRecovery |-> <<>>,
       recoveryBad |-> FALSE, removeSet |-> {},
       published |-> FALSE, staleCommit |-> FALSE,
       overlap |-> FALSE, rewritten |-> FALSE, cacheWrite |-> FALSE,
       lateWrite |-> FALSE, cleaning |-> FALSE, previewGrant |-> FALSE,
       cacheTodo |-> CacheKeys, cacheKey |-> "existing", previewCopy |-> 0,
       rollbackAssets |-> {}, rollbackVersion |-> {}, restorePhase |-> 0,
       externalCreditsWritten |-> FALSE]

\* Each write/copy can be interrupted after an arbitrary proper prefix (1),
\* or after all bytes (2). This is not a claim that writeFile/copyFile is atomic.
StageWrite(pc, file, next) ==
  /\ s.pc = pc
  /\ s.disk.stage[file] < 2
  /\ s' = [s EXCEPT !.disk.stage[file] = @ + 1,
                     !.pc = IF s.disk.stage[file] = 1 THEN next ELSE pc]
MovePC(pc, next) ==
  /\ s.pc = pc
  /\ s' = [s EXCEPT !.pc = next]

BeginLock ==
  /\ s.pc = "begin-lock" /\ s.owner = "free"
  /\ s' = [s EXCEPT !.owner = "note", !.pc = "begin-read"]
BeginRead ==
  /\ s.pc = "begin-read" /\ ~s.abort
  /\ s' = [s EXCEPT !.base = s.disk.project, !.pc = "begin-mkdir"]
BeginMkdir ==
  /\ s.pc = "begin-mkdir"
  /\ s' = [s EXCEPT !.disk.stageDir = TRUE, !.pc = "begin-project"]
BeginReturn ==
  /\ s.pc = "begin-return" /\ ~s.abort
  /\ s' = [s EXCEPT !.owner = "free", !.pc = "grant"]
WorkCheck ==
  /\ s.pc = "work-check" /\ ~s.abort
  /\ s' = [s EXCEPT !.pc = "work-cache"]
WorkCache ==
  /\ s.pc = "work-cache"
  /\ s' = [s EXCEPT !.pc = "work-new",
                     !.disk.liveCache["existing"] = IF Mutation = "cache-alias" THEN 1 ELSE @,
                     !.cacheWrite = Mutation = "cache-alias"]
GrantPreview ==
  /\ s.pc = "grant"
  /\ s' = [s EXCEPT !.previewGrant = TRUE, !.pc = "work-check"]

PublishLock ==
  /\ s.pc = "publish-lock" /\ ~s.abort /\ s.owner = "free"
  /\ (Mutation = "no-lock-writer-first" => s.writerPC # "idle")
  /\ s' = [s EXCEPT !.owner = "note", !.pc = "hash",
                     !.overlap = @ \/ (s.writerPC \in {"read", "write", "rename"})]
CheckBase ==
  /\ s.pc = "hash"
  /\ s' = [s EXCEPT !.pc = IF Mutation = "no-hash" \/ s.base = s.disk.project
                                THEN "cache-snapshot" ELSE "discard",
                     !.fault = IF Mutation # "no-hash" /\ s.base # s.disk.project
                                  THEN "stale" ELSE @]

\* Completed work caches move into the private version one entry at a time.
SnapshotCache ==
  /\ s.pc = "cache-snapshot" /\ ~s.abort
  /\ \E k \in CacheKeys :
       LET src == IF k = "existing" THEN "cache" ELSE "work-new"
           dst == "cache-" \o k
       IN /\ s.disk.stage[dst] = 0 /\ s.disk.stage[src] = 2
          /\ s' = [s EXCEPT !.disk.stage[src] = 0, !.disk.stage[dst] = 2]
SnapshotDone ==
  /\ s.pc = "cache-snapshot" /\ ~s.abort
  /\ \A k \in CacheKeys : s.disk.stage["cache-" \o k] = 2
  /\ s' = [s EXCEPT !.pc = "prepare"]

\* The absence check is protected by the publish lock. Copying to private
\* scratch is interruptible; only the final rename makes a complete key live.
PromoteSelect ==
  /\ s.pc = "promote-select"
  /\ IF s.cacheTodo = {}
        THEN s' = [s EXCEPT !.pc = "release"]
        ELSE \E k \in s.cacheTodo :
               s' = [s EXCEPT !.cacheKey = k, !.cacheTodo = @ \ {k},
                              !.pc = IF s.disk.liveCache[k] > 0 /\ Mutation # "cache-overwrite"
                                       THEN "promote-select" ELSE "promote-copy"]
PromoteCopy ==
  /\ s.pc = "promote-copy" /\ s.disk.stage["promotion-temp"] < 2
  /\ s' = [s EXCEPT !.disk.stage["promotion-temp"] = @ + 1,
                     !.disk.liveCache[s.cacheKey] = IF Mutation = "cache-copy-live"
                                                   THEN s.disk.stage["promotion-temp"] + 1 ELSE @,
                     !.cacheWrite = @ \/ Mutation = "cache-copy-live",
                     !.pc = IF s.disk.stage["promotion-temp"] = 1 THEN "promote-rename" ELSE @]
PromoteRename ==
  /\ s.pc = "promote-rename" /\ s.disk.stage["promotion-temp"] = 2
  /\ s' = [s EXCEPT !.disk.liveCache[s.cacheKey] = 2,
                     !.disk.stage["promotion-temp"] = 0,
                     !.cacheWrite = @ \/ ~Committed(s.disk) \/ s.disk.liveCache[s.cacheKey] # 0,
                     !.pc = "promote-select"]
PreviewCopy ==
  /\ s.pc = "preview-copy" /\ s.previewCopy < 2
  /\ s' = [s EXCEPT !.previewCopy = @ + 1,
                     !.pc = IF s.previewCopy = 1 THEN "preview-check" ELSE @]
RevokePreview ==
  /\ s.pc = "discard" /\ s.owner \in {"free", "note"}
  /\ s' = [s EXCEPT !.previewGrant = IF Mutation = "preview-grant" THEN @ ELSE FALSE,
                     !.owner = "note", !.pc = "repair",
                     !.cleaning = TRUE, !.recoveryPC = "inspect"]

\* Concurrent Promise.allSettled preparation. Each file has its own partial
\* write (1), complete bytes (2), fsync (3), and same-volume rename (4).
\* Read-only awaits and close stutter. The metadata class represents repeated
\* version-side files; no prepared file becomes live before every task settles.
PrepareWrite ==
  /\ s.pc = "prepare"
  /\ \E f \in PreparedFiles :
       /\ s.disk.prepared[f] < 2
       /\ s' = [s EXCEPT !.disk.prepared[f] = @ + 1]
PrepareSync ==
  /\ s.pc = "prepare"
  /\ \E f \in PreparedFiles :
       /\ s.disk.prepared[f] = 2
       /\ s' = [s EXCEPT !.disk.prepared[f] = 3]
PrepareRename ==
  /\ s.pc = "prepare"
  /\ \E f \in PreparedFiles :
       /\ s.disk.prepared[f] = 3
       /\ s' = [s EXCEPT !.disk.prepared[f] = 4,
                          !.disk.stage[f] = IF f = "manifest" /\ Mutation = "no-manifest"
                                             THEN 0 ELSE 2]
Prepared ==
  /\ s.pc = "prepare"
  /\ \A f \in PreparedFiles : s.disk.prepared[f] = 4
  /\ s' = [s EXCEPT !.pc = "staging-sync"]
Prune ==
  /\ s.pc = "prune"
  /\ s.disk.version = {}
  /\ s' = [s EXCEPT !.pc = "assets-check"]
CheckAbort(pc, next) ==
  /\ s.pc = pc /\ ~s.abort
  /\ s' = [s EXCEPT !.pc = next]
AssetRename ==
  /\ s.pc = "assets"
  /\ \E a \in Assets \ s.disk.assets :
       /\ s.disk.stage[a] = 2
       /\ s' = [s EXCEPT !.disk.assets = @ \cup {a}, !.disk.stage[a] = 0,
                          !.pc = IF s.disk.assets \cup {a} = Assets
                                    THEN "credits-check" ELSE "assets"]
CreditsRename ==
  /\ s.pc = "credits-rename" /\ s.disk.stage["merged-credits"] = 2
  /\ s' = [s EXCEPT !.disk.credits = "merged", !.disk.stage["merged-credits"] = 0,
                     !.pc = "version-check"]
VersionRename ==
  /\ s.pc = "version-rename"
  /\ \A f \in VersionFiles : s.disk.stage[f] = 2
  /\ s' = [s EXCEPT !.disk.version = VersionFiles,
                     !.disk.stage = [f \in StageFiles |->
                         IF f \in VersionFiles THEN 0 ELSE s.disk.stage[f]],
                     !.pc = IF Mutation = "project-first"
                               THEN "set-published" ELSE "project-check"]
ProjectRename ==
  /\ s.pc = "project-rename" /\ s.disk.stage["commit"] = 2
  /\ s' = [s EXCEPT !.disk.project = IF Mutation = "append-after-commit" THEN "committed" ELSE "new",
                     !.disk.stage["commit"] = 0,
                     !.staleCommit = s.base # s.disk.project,
                     !.pc = IF Mutation = "project-first"
                               THEN "version-rename" ELSE "set-published"]
SetPublished ==
  /\ s.pc = "set-published"
  /\ s' = [s EXCEPT !.published = TRUE, !.pc = "project-sync"]
AppendWrite ==
  /\ s.pc = "append-write" /\ s.disk.appendTemp < 2
  /\ s' = [s EXCEPT !.disk.appendTemp = @ + 1,
                     !.pc = IF s.disk.appendTemp = 1 THEN "append-rename" ELSE @]
AppendRename ==
  /\ s.pc = "append-rename" /\ s.disk.appendTemp = 2
  /\ s' = [s EXCEPT !.disk.project = "new", !.disk.appendTemp = 0, !.pc = "promote-select"]
Release ==
  /\ s.pc = "release"
  /\ s' = [s EXCEPT !.owner = "free", !.pc = "discard"]
\* Failures are tool/engine failures, not injected I/O faults. The await points
\* in publish after the work phase therefore have Stop and Crash, not ToolFailure.
Stop ==
  /\ ~s.abort /\ s.pc # "done"
  /\ s' = [s EXCEPT !.abort = TRUE, !.fault = "stop"]
ToolFailure ==
  /\ ~s.abort /\ s.pc \in {"work-check", "work-cache", "work-new", "work-asset",
                           "work-thumb", "work-credits", "render", "notes"}
  /\ s' = [s EXCEPT !.abort = TRUE, !.fault = "tool"]
AbortAtCheck ==
  /\ s.abort /\ s.pc \in Checks
  /\ s' = [s EXCEPT !.pc = "discard"]
\* Timeout requests cleanup. It cannot delete under a publisher that owns
\* withProjectLock; publish first observes abort at a check and repairs in-lock.
Timeout ==
  /\ s.abort /\ s.owner = "free" /\ ~s.cleaning
  /\ s.pc \in {"work-check", "work-cache", "work-new", "work-asset",
                "work-thumb", "work-credits", "render", "notes", "preview-copy", "preview-check", "publish-lock"}
  /\ s' = [s EXCEPT !.pc = "discard"]

LateStageWrite ==
  /\ s.abort /\ s.pc \in {"discard", "repair", "done"} /\ ~s.lateWrite
  /\ s' = [s EXCEPT !.disk.stage["cache"] = 1, !.disk.stageDir = TRUE,
                     !.lateWrite = TRUE]

\* A manual read-modify-write or another lock-using job has its own read,
\* partial temp, full temp, and rename. The UI job guard only reduces these
\* schedules; it is not required for the modeled mutual exclusion.
WriterAcquire ==
  /\ Writer \in {"manual", "legacy-cover"} /\ s.writerPC = "idle"
  /\ (Mutation = "no-lock-writer-first" => s.pc = "publish-lock")
  /\ s.owner = "free" \/ Mutation \in {"no-lock", "no-lock-writer-first"}
  /\ s' = [s EXCEPT !.writerPC = "read",
                     !.owner = IF Mutation \in {"no-lock", "no-lock-writer-first"} THEN @ ELSE "writer",
                     !.overlap = @ \/ (s.pc \in PublishPCs)]
WriterRead ==
  /\ s.writerPC = "read"
  /\ s' = [s EXCEPT !.writerRead = s.disk.project, !.writerPC = "write"]
WriterWrite ==
  /\ s.writerPC = "write" /\ s.writerTemp < 2
  /\ s' = [s EXCEPT !.writerTemp = @ + 1,
                     !.writerPC = IF s.writerTemp = 1 THEN "rename" ELSE @]
WriterRename ==
  /\ s.writerPC = "rename"
  /\ s' = [s EXCEPT
             !.disk.project = IF Writer = "manual" /\ ~Committed(s.disk)
                                THEN "manual" ELSE @,
             !.disk.oldVersion = IF Writer = "legacy-cover"
                                   THEN @ \ {"metadata"} ELSE @,
             !.rewritten = @ \/ Writer = "legacy-cover",
             !.overlap = @ \/ (s.pc \in PublishPCs),
             !.writerPC = "done", !.writerTemp = 0,
             !.owner = IF s.owner = "writer" THEN "free" ELSE @]
RewriteVersion ==
  /\ Mutation = "rewrite-version" /\ Committed(s.disk) /\ ~s.rewritten
  /\ s' = [s EXCEPT !.disk.version = @ \ {"metadata"}, !.rewritten = TRUE]

Crash ==
  /\ s.mode \in {"running", "recovery"} /\ s.crashes < MaxCrashes
  /\ s' = [s EXCEPT !.mode = "down", !.crashes = @ + 1,
                     !.owner = "free", !.pc = "dead", !.writerPC = "dead",
                     !.previewGrant = FALSE]
\* One completed external write after a crash, before recovery resumes.
\* The model does not admit an external writer between the hash read and rename.
ExternalCreditsWrite ==
  /\ Writer = "external-credits" /\ s.mode = "down"
  /\ ~s.externalCreditsWritten /\ s.recoveryRuns = 0
  /\ s' = [s EXCEPT !.disk.credits = "external", !.externalCreditsWritten = TRUE]
Restart ==
  /\ s.mode = "down"
  /\ s' = [s EXCEPT !.mode = "recovery", !.recoveryPC = "inspect",
                     !.owner = "recovery"]
RecoveryInspect ==
  /\ s.recoveryPC = "inspect"
  /\ s' = [s EXCEPT !.recoveryPC = IF s.disk.project = "new" THEN "replay-style"
                                  ELSE IF s.disk.stage["manifest"] = 2 THEN "assets" ELSE "staging",
                     !.rollbackAssets = Assets, !.restorePhase = 0]
RecoveryAsset ==
  /\ s.recoveryPC = "assets" /\ s.rollbackAssets # {}
  /\ \E f \in s.rollbackAssets :
       s' = [s EXCEPT !.disk.assets = @ \ {f}, !.rollbackAssets = @ \ {f}]
RecoveryCreditsStart ==
  /\ s.recoveryPC = "assets" /\ s.rollbackAssets = {}
  /\ s' = [s EXCEPT !.recoveryPC = IF s.disk.credits = "merged" \/ Mutation = "restore-newer-credits"
                                    THEN "restore-write" ELSE "rollback-version",
                     !.rollbackVersion = IF Committed(s.disk) THEN {} ELSE s.disk.version]
\* The original credits byte string is opaque. Restoration writes a private
\* temp, syncs it, renames it to restored-credits, then renames over live credits.
RecoveryCreditsWrite ==
  /\ s.recoveryPC = "restore-write" /\ s.restorePhase < 2
  /\ s' = [s EXCEPT !.restorePhase = @ + 1, !.disk.stage["restore"] = s.restorePhase + 1]
RecoveryCreditsSync ==
  /\ s.recoveryPC = "restore-write" /\ s.restorePhase = 2
  /\ s' = [s EXCEPT !.restorePhase = 3]
RecoveryCreditsPrepare ==
  /\ s.recoveryPC = "restore-write" /\ s.restorePhase = 3
  /\ s' = [s EXCEPT !.restorePhase = 4]
RecoveryCreditsRename ==
  /\ s.recoveryPC = "restore-write" /\ s.restorePhase = 4
  /\ s' = [s EXCEPT !.disk.credits = IF Mutation = "no-credits-restore" THEN @ ELSE "old",
                     !.disk.stage["restore"] = 0, !.recoveryPC = "rollback-version",
                     !.rollbackVersion = IF Committed(s.disk) THEN {} ELSE s.disk.version]
RecoveryVersion ==
  /\ s.recoveryPC = "rollback-version" /\ s.rollbackVersion # {}
  /\ \E f \in s.rollbackVersion :
       s' = [s EXCEPT !.disk.version = @ \ {f}, !.rollbackVersion = @ \ {f},
                      !.recoveryPC = IF Mutation = "recovery-drains-one" THEN "finish" ELSE @]
RecoveryVersionDone ==
  /\ s.recoveryPC = "rollback-version" /\ s.rollbackVersion = {}
  /\ s' = [s EXCEPT !.recoveryPC = "staging"]
RecoveryStyle ==
  /\ s.recoveryPC = "replay-style"
  /\ s' = [s EXCEPT !.recoveryPC = "staging"]
\* Private deletion order does not affect live bytes after repairs finish.
\* A fixed order removes equivalent permutations, including temporary files.
FileOrder == <<"asset", "thumb", "export", "snapshot", "metadata", "notes",
               "cache-existing", "cache-new", "project", "input", "cache",
               "work-new", "credits", "temp", "promotion-temp", "commit",
               "merged-credits", "manifest", "restore">>
FirstPresent == FileOrder[CHOOSE i \in 1..Len(FileOrder) :
                         FileOrder[i] \in StagePresent /\
                         \A j \in 1..(i-1) : FileOrder[j] \notin StagePresent]
RecoveryStaging ==
  /\ s.recoveryPC = "staging" /\ StagePresent # {}
  /\ s' = [s EXCEPT !.disk.stage[FirstPresent] = 0]
RecoveryPrepared ==
  /\ s.recoveryPC = "staging" /\ StagePresent = {}
  /\ \E f \in PreparedFiles :
       /\ s.disk.prepared[f] \in 1..3
       /\ s' = [s EXCEPT !.disk.prepared[f] = 0]
RecoveryRead ==
  /\ s.recoveryPC = "staging" /\ StagePresent = {}
  /\ \A f \in PreparedFiles : s.disk.prepared[f] \in {0, 4}
  /\ s' = [s EXCEPT !.disk.stageDir = FALSE,
                     !.disk.prepared = [f \in PreparedFiles |-> 0],
                     !.recoveryPC = IF s.mode = "running" THEN "finish" ELSE "versions",
                     !.removeSet = IF Committed(s.disk) THEN {} ELSE s.disk.version]
RecoveryRemove ==
  /\ s.recoveryPC = "versions" /\ s.removeSet # {}
  /\ \E f \in s.removeSet :
       s' = [s EXCEPT !.disk.version = @ \ {f}, !.removeSet = @ \ {f},
                      !.recoveryPC = IF Mutation = "recovery-drains-one" THEN "finish" ELSE @]
RecoveryFinish ==
  /\ (s.recoveryPC = "versions" /\ s.removeSet = {}) \/ s.recoveryPC = "finish"
  /\ IF s.mode = "running"
       THEN s' = [s EXCEPT !.pc = "done", !.owner = "free", !.recoveryPC = "idle"]
       ELSE s' = [s EXCEPT !.recoveryRuns = @ + 1,
                     !.firstRecovery = IF s.recoveryRuns = 0 THEN Disk(s.disk) ELSE @,
                     !.recoveryBad = s.recoveryRuns = 1 /\ s.firstRecovery # Disk(s.disk),
                     !.recoveryPC = IF s.recoveryRuns = 0 THEN "inspect" ELSE "done",
                     !.mode = IF s.recoveryRuns = 0 THEN "recovery" ELSE "finished",
                     !.owner = IF s.recoveryRuns = 0 THEN "recovery" ELSE "free"]
RecoveryStep == RecoveryInspect \/ RecoveryAsset \/ RecoveryCreditsStart
             \/ RecoveryCreditsWrite \/ RecoveryCreditsSync \/ RecoveryCreditsPrepare
             \/ RecoveryCreditsRename \/ RecoveryVersion \/ RecoveryVersionDone
             \/ RecoveryStyle \/ RecoveryStaging \/ RecoveryPrepared
             \/ RecoveryRead \/ RecoveryRemove \/ RecoveryFinish

NoteStep ==
  \/ BeginLock \/ BeginRead \/ BeginMkdir
  \/ StageWrite("begin-project", "project", "begin-input")
  \/ StageWrite("begin-input", "input", "begin-cache")
  \/ StageWrite("begin-cache", "cache", "begin-return")
  \/ BeginReturn \/ GrantPreview \/ WorkCheck \/ WorkCache
  \/ StageWrite("work-new", "work-new", "work-asset")
  \/ StageWrite("work-asset", "asset", "work-thumb")
  \/ StageWrite("work-thumb", "thumb", "work-credits")
  \/ StageWrite("work-credits", "credits", "render")
  \/ StageWrite("render", "export",
          IF PreviewOnly /\ Mutation # "preview-publish" THEN "preview-copy" ELSE "notes")
  \/ StageWrite("notes", "notes", "publish-lock")
  \/ PublishLock \/ CheckBase \/ SnapshotCache \/ SnapshotDone
  \/ PrepareWrite \/ PrepareSync \/ PrepareRename \/ Prepared
  \/ MovePC("staging-sync", "prune")
  \/ Prune \/ CheckAbort("assets-check", "assets") \/ AssetRename
  \/ CheckAbort("credits-check", "credits-rename") \/ CreditsRename
  \/ CheckAbort("version-check",
          IF Mutation = "project-first" THEN "project-check" ELSE "version-rename")
  \/ VersionRename
  \/ CheckAbort("project-check", "project-rename") \/ ProjectRename \/ SetPublished
  \/ MovePC("project-sync", "style")
  \/ MovePC("style", IF Mutation = "append-after-commit" THEN "append-write" ELSE "promote-select") \/ AppendWrite \/ AppendRename
  \/ PromoteSelect \/ PromoteCopy \/ PromoteRename \/ Release
  \/ PreviewCopy \/ CheckAbort("preview-check", "discard") \/ RevokePreview
  \/ Stop \/ ToolFailure \/ AbortAtCheck \/ Timeout
  \/ (s.pc = "repair" /\ RecoveryStep) \/ LateStageWrite \/ RewriteVersion

Next ==
  \/ (s.mode = "running" /\ (NoteStep \/ WriterAcquire \/ WriterRead
                                          \/ WriterWrite \/ WriterRename))
  \/ Crash \/ ExternalCreditsWrite \/ Restart
  \/ (s.mode = "recovery" /\ RecoveryStep)
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.disk.project \in {"old", "manual", "committed", "new"}
  /\ s.disk.credits \in {"old", "merged", "external"}
  /\ s.disk.assets \subseteq Assets
  /\ s.disk.oldVersion \subseteq VersionFiles
  /\ s.disk.version \subseteq VersionFiles
  /\ s.disk.stage \in [StageFiles -> 0..2]
  /\ s.disk.prepared \in [PreparedFiles -> 0..4]
  /\ s.disk.liveCache \in [CacheKeys -> 0..2]
  /\ s.disk.creditsTemp \in 0..2 /\ s.disk.appendTemp \in 0..2
  /\ s.recoveryRuns \in 0..2 /\ s.crashes \in 0..MaxCrashes
  /\ s.owner \in {"free", "note", "writer", "recovery"}
ReferencesExist ==
  Committed(s.disk) => s.disk.version = VersionFiles /\ s.disk.assets = Assets
PublishedImmutable == ~s.rewritten /\ s.disk.oldVersion = OldVersion
CachePublicationSafe ==
  /\ ~s.cacheWrite /\ s.disk.liveCache["existing"] = 2
  /\ s.disk.liveCache["new"] \in {0, 2}
  /\ (s.disk.liveCache["new"] # 0 => Committed(s.disk))
PreviewNeverPublishes == PreviewOnly => ~Committed(s.disk)
CleanupRevokesPreview ==
  (s.cleaning \/ s.pc \in {"repair", "done"} \/ s.mode # "running") => ~s.previewGrant
StaleNeverPublishes == ~s.staleCommit
PublishExclusive ==
  /\ ~s.overlap
  /\ ~(s.pc \in PublishPCs /\ s.writerPC \in {"read", "write", "rename"})
RecoveryIdempotent == ~s.recoveryBad
ExternalCreditsPreserved == s.externalCreditsWritten => s.disk.credits = "external"

\* These retain the literal requested equality, separately from ReferencesExist.
OldBytes == Live(s.disk) = Live(InitialDisk)
NewBytes ==
  /\ s.disk.project = "new" /\ s.disk.assets = Assets /\ s.disk.credits = "merged"
  /\ s.disk.version = VersionFiles /\ s.disk.oldVersion = OldVersion
  /\ s.disk.liveCache = [k \in CacheKeys |-> 2] /\ s.disk.appendTemp = 0
AtRest == s.mode \in {"down", "finished"} \/ s.pc = "done"
OldOrCompleteNew == AtRest => OldBytes \/ NewBytes
ProjectOldOrCompleteNew == AtRest => s.disk.project \in {"old", "manual", "new"}
\* Cache additions are optional postcommit work under revised property 3.
\* This projection covers edit bytes, distinct from literal whole-tree equality.
Edit(d) == <<d.project, d.assets, d.credits, d.oldVersion, d.version>>
RecoveredOldOrCompleteNew ==
  (s.mode = "finished" \/ s.pc = "done") =>
    Edit(s.disk) = Edit(InitialDisk) \/
    (s.disk.project = "new" /\ s.disk.assets = Assets /\ s.disk.credits = "merged" /\
     s.disk.oldVersion = OldVersion /\ s.disk.version = VersionFiles)

\* Reachability witnesses: TLC must refute each for a non-vacuous baseline run.
NeverExternalCredits == ~s.externalCreditsWritten
NeverPromoted == s.disk.liveCache["new"] = 0
NeverPreviewed == s.previewCopy < 2
NeverCommitted == ~Committed(s.disk)
NeverRecoveredTwice == s.recoveryRuns < 2
NeverRejectedStale == s.fault # "stale"
=============================================================================
