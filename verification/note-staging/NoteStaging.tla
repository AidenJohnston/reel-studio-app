--------------------------- MODULE NoteStaging ---------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS Mutation, Writer, MaxCrashes
ASSUME Mutation \in {"none", "project-first", "no-hash", "no-lock",
                     "cache-alias", "rewrite-version", "recovery-drains-one"}
ASSUME Writer \in {"none", "manual", "legacy-cover"}
ASSUME MaxCrashes \in 0..2

Assets == {"asset", "thumb"}
VersionFiles == {"export", "snapshot", "metadata", "notes"}
StageFiles == Assets \cup VersionFiles \cup
              {"project", "input", "cache", "credits", "temp"}
EmptyStage == [f \in StageFiles |-> 0]
EmptyVersion == {}
OldVersion == VersionFiles
VARIABLE s
vars == <<s>>

Live(d) == <<d.project, d.assets, d.credits, d.oldVersion, d.version,
             d.liveCache, d.appendTemp>>
Disk(d) == <<Live(d), d.stage, d.stageDir, d.creditsTemp>>
InitialDisk ==
  [project |-> "old", assets |-> {}, credits |-> FALSE,
   oldVersion |-> OldVersion, version |-> EmptyVersion,
   liveCache |-> 0, appendTemp |-> 0, creditsTemp |-> 0,
   stage |-> EmptyStage, stageDir |-> FALSE]
Committed(d) == d.project \in {"committed", "new"}
StagePresent == {f \in StageFiles : s.disk.stage[f] > 0}
PublishPCs ==
  {"hash", "snapshot", "metadata", "prune", "assets-check", "assets",
   "credits-check", "credits-write", "credits-rename", "version-check",
   "version-rename", "project-write", "project-check", "project-rename",
   "set-published", "style", "append-write", "append-rename", "release"}
Checks == {"begin-read", "begin-return", "work-check", "publish-lock",
           "assets-check", "credits-check", "version-check", "project-check"}

Init ==
  s = [disk |-> InitialDisk, pc |-> "begin-lock", owner |-> "free",
       base |-> "unset", writerPC |-> "idle", writerRead |-> "unset",
       writerTemp |-> 0, abort |-> FALSE, fault |-> "none",
       mode |-> "running", crashes |-> 0, recoveryPC |-> "idle",
       recoveryRuns |-> 0, firstRecovery |-> <<>>,
       recoveryBad |-> FALSE, removeSet |-> {},
       published |-> FALSE, staleCommit |-> FALSE,
       overlap |-> FALSE, rewritten |-> FALSE, cacheWrite |-> FALSE,
       lateWrite |-> FALSE, cleaning |-> FALSE]

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
  /\ s' = [s EXCEPT !.owner = "free", !.pc = "work-check"]
WorkCheck ==
  /\ s.pc = "work-check" /\ ~s.abort
  /\ s' = [s EXCEPT !.pc = "work-cache"]
WorkCache ==
  /\ s.pc = "work-cache"
  /\ s' = [s EXCEPT !.pc = "work-asset",
                     !.disk.liveCache = IF Mutation = "cache-alias" THEN 1 ELSE @,
                     !.cacheWrite = Mutation = "cache-alias"]
PublishLock ==
  /\ s.pc = "publish-lock" /\ ~s.abort /\ s.owner = "free"
  /\ s' = [s EXCEPT !.owner = "note", !.pc = "hash",
                     !.overlap = @ \/ (s.writerPC \in {"read", "write", "rename"})]
CheckBase ==
  /\ s.pc = "hash"
  /\ s' = [s EXCEPT !.pc = IF Mutation = "no-hash" \/ s.base = s.disk.project
                                THEN "snapshot" ELSE "discard",
                     !.fault = IF Mutation # "no-hash" /\ s.base # s.disk.project
                                  THEN "stale" ELSE @]

\* writeFileAtomic prepares a private temp, then renames it. Its intermediate
\* temp contents use stage.temp; fsync/close do not change this process-crash model.
PrepareAtomic(pc, target, next) ==
  /\ s.pc = pc
  /\ IF s.disk.stage["temp"] < 2
        THEN s' = [s EXCEPT !.disk.stage["temp"] = @ + 1]
        ELSE s' = [s EXCEPT !.disk.stage["temp"] = 0,
                            !.disk.stage[target] = 2, !.pc = next]
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
CreditsWrite ==
  /\ s.pc = "credits-write" /\ s.disk.creditsTemp < 2
  /\ s' = [s EXCEPT !.disk.creditsTemp = @ + 1,
                     !.pc = IF s.disk.creditsTemp = 1 THEN "credits-rename" ELSE @]
CreditsRename ==
  /\ s.pc = "credits-rename" /\ s.disk.creditsTemp = 2
  /\ s' = [s EXCEPT !.disk.credits = TRUE, !.disk.creditsTemp = 0,
                     !.pc = "version-check"]
VersionRename ==
  /\ s.pc = "version-rename"
  /\ \A f \in VersionFiles : s.disk.stage[f] = 2
  /\ s' = [s EXCEPT !.disk.version = VersionFiles,
                     !.disk.stage = [f \in StageFiles |->
                         IF f \in VersionFiles THEN 0 ELSE s.disk.stage[f]],
                     !.pc = IF Mutation = "project-first"
                               THEN "set-published" ELSE "project-write"]
ProjectRename ==
  /\ s.pc = "project-rename" /\ s.disk.stage["temp"] = 2
  /\ s' = [s EXCEPT !.disk.project = "committed", !.disk.stage["temp"] = 0,
                     !.staleCommit = s.base # s.disk.project,
                     !.pc = IF Mutation = "project-first"
                               THEN "version-rename" ELSE "set-published"]
SetPublished ==
  /\ s.pc = "set-published"
  /\ s' = [s EXCEPT !.published = TRUE, !.pc = "style"]
AppendWrite ==
  /\ s.pc = "append-write" /\ s.disk.appendTemp < 2
  /\ s' = [s EXCEPT !.disk.appendTemp = @ + 1,
                     !.pc = IF s.disk.appendTemp = 1 THEN "append-rename" ELSE @]
AppendRename ==
  /\ s.pc = "append-rename" /\ s.disk.appendTemp = 2
  /\ s' = [s EXCEPT !.disk.project = "new", !.disk.appendTemp = 0, !.pc = "release"]
Release ==
  /\ s.pc = "release"
  /\ s' = [s EXCEPT !.owner = "free", !.pc = "discard"]
DiscardOne ==
  /\ s.pc = "discard" /\ StagePresent # {}
  /\ \E f \in StagePresent : s' = [s EXCEPT !.disk.stage[f] = 0]
DiscardDone ==
  /\ s.pc = "discard" /\ StagePresent = {}
  /\ s' = [s EXCEPT !.disk.stageDir = FALSE, !.pc = "done",
                     !.owner = IF s.owner = "note" THEN "free" ELSE @]

\* Failures are tool/engine failures, not injected I/O faults. The await points
\* in publish after the work phase therefore have Stop and Crash, not ToolFailure.
Stop ==
  /\ ~s.abort /\ s.pc # "done"
  /\ s' = [s EXCEPT !.abort = TRUE, !.fault = "stop"]
ToolFailure ==
  /\ ~s.abort /\ s.pc \in {"work-check", "work-cache", "work-asset",
                           "work-thumb", "work-credits", "render", "notes"}
  /\ s' = [s EXCEPT !.abort = TRUE, !.fault = "tool"]
AbortAtCheck ==
  /\ s.abort /\ s.pc \in Checks
  /\ s' = [s EXCEPT !.pc = "discard"]
\* Ten-second timeout permits discard before pending tools settle. A late
\* worker gets one representative write into staging after discard.
Timeout ==
  /\ s.abort /\ ~s.published /\ ~Committed(s.disk) /\ ~s.cleaning
  /\ s.pc \notin {"begin-lock", "begin-read", "begin-mkdir", "begin-project",
                  "begin-input", "begin-cache", "begin-return", "done"}
  /\ s' = [s EXCEPT !.cleaning = TRUE]
TimeoutRemove ==
  /\ s.cleaning /\ StagePresent # {}
  /\ \E f \in StagePresent : s' = [s EXCEPT !.disk.stage[f] = 0]
TimeoutRemoveDir ==
  /\ s.cleaning /\ StagePresent = {} /\ s.disk.stageDir
  /\ s' = [s EXCEPT !.disk.stageDir = FALSE]
MissingStaged ==
  /\ s.cleaning
  /\ (s.pc = "project-rename" /\ s.disk.stage["temp"] # 2)
     \/ (s.pc = "version-rename" /\ \E f \in VersionFiles : s.disk.stage[f] # 2)
     \/ (s.pc = "assets" /\ \E f \in Assets \ s.disk.assets : s.disk.stage[f] # 2)
  /\ s' = [s EXCEPT !.pc = "discard"]

LateStageWrite ==
  /\ s.abort /\ s.pc \in {"discard", "done"} /\ ~s.lateWrite
  /\ s' = [s EXCEPT !.disk.stage["cache"] = 1, !.disk.stageDir = TRUE,
                     !.lateWrite = TRUE]

\* A manual read-modify-write or another lock-using job has its own read,
\* partial temp, full temp, and rename. The UI job guard only reduces these
\* schedules; it is not required for the modeled mutual exclusion.
WriterAcquire ==
  /\ Writer # "none" /\ s.writerPC = "idle"
  /\ s.owner = "free" \/ Mutation = "no-lock"
  /\ s' = [s EXCEPT !.writerPC = "read",
                     !.owner = IF Mutation = "no-lock" THEN @ ELSE "writer",
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
                     !.owner = "free", !.pc = "dead", !.writerPC = "dead"]
Restart ==
  /\ s.mode = "down"
  /\ s' = [s EXCEPT !.mode = "recovery", !.recoveryPC = "staging",
                     !.owner = "recovery"]
RecoveryStaging ==
  /\ s.recoveryPC = "staging" /\ StagePresent # {}
  /\ \E f \in StagePresent : s' = [s EXCEPT !.disk.stage[f] = 0]
RecoveryRead ==
  /\ s.recoveryPC = "staging" /\ StagePresent = {}
  /\ s' = [s EXCEPT !.disk.stageDir = FALSE, !.recoveryPC = "versions",
                     !.removeSet = IF Committed(s.disk) THEN {} ELSE s.disk.version]
RecoveryRemove ==
  /\ s.recoveryPC = "versions" /\ s.removeSet # {}
  /\ \E f \in s.removeSet :
       s' = [s EXCEPT !.disk.version = @ \ {f}, !.removeSet = @ \ {f},
                      !.recoveryPC = IF Mutation = "recovery-drains-one"
                                       THEN "finish" ELSE @]
RecoveryFinish ==
  /\ (s.recoveryPC = "versions" /\ s.removeSet = {}) \/ s.recoveryPC = "finish"
  /\ s' = [s EXCEPT !.recoveryRuns = @ + 1,
                     !.firstRecovery = IF s.recoveryRuns = 0 THEN Disk(s.disk) ELSE @,
                     !.recoveryBad = s.recoveryRuns = 1 /\ s.firstRecovery # Disk(s.disk),
                     !.recoveryPC = IF s.recoveryRuns = 0 THEN "staging" ELSE "done",
                     !.mode = IF s.recoveryRuns = 0 THEN "recovery" ELSE "finished",
                     !.owner = IF s.recoveryRuns = 0 THEN "recovery" ELSE "free"]

NoteStep ==
  \/ BeginLock \/ BeginRead \/ BeginMkdir
  \/ StageWrite("begin-project", "project", "begin-input")
  \/ StageWrite("begin-input", "input", "begin-cache")
  \/ StageWrite("begin-cache", "cache", "begin-return")
  \/ BeginReturn \/ WorkCheck \/ WorkCache
  \/ StageWrite("work-asset", "asset", "work-thumb")
  \/ StageWrite("work-thumb", "thumb", "work-credits")
  \/ StageWrite("work-credits", "credits", "render")
  \/ StageWrite("render", "export", "notes")
  \/ StageWrite("notes", "notes", "publish-lock")
  \/ PublishLock \/ CheckBase
  \/ PrepareAtomic("snapshot", "snapshot", "metadata")
  \/ PrepareAtomic("metadata", "metadata", "prune")
  \/ Prune \/ CheckAbort("assets-check", "assets") \/ AssetRename
  \/ CheckAbort("credits-check", "credits-write") \/ CreditsWrite \/ CreditsRename
  \/ CheckAbort("version-check",
          IF Mutation = "project-first" THEN "project-write" ELSE "version-rename")
  \/ VersionRename \/ StageWrite("project-write", "temp", "project-check")
  \/ CheckAbort("project-check", "project-rename") \/ ProjectRename \/ SetPublished
  \/ MovePC("style", "append-write") \/ AppendWrite \/ AppendRename \/ Release
  \/ DiscardOne \/ DiscardDone \/ Stop \/ ToolFailure \/ AbortAtCheck \/ Timeout
  \/ TimeoutRemove \/ TimeoutRemoveDir \/ MissingStaged \/ LateStageWrite \/ RewriteVersion

Next ==
  \/ (s.mode = "running" /\ (NoteStep \/ WriterAcquire \/ WriterRead
                                          \/ WriterWrite \/ WriterRename))
  \/ Crash \/ Restart
  \/ (s.mode = "recovery" /\ (RecoveryStaging \/ RecoveryRead
                              \/ RecoveryRemove \/ RecoveryFinish))
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ s.disk.project \in {"old", "manual", "committed", "new"}
  /\ s.disk.assets \subseteq Assets
  /\ s.disk.oldVersion \subseteq VersionFiles
  /\ s.disk.version \subseteq VersionFiles
  /\ s.disk.stage \in [StageFiles -> 0..2]
  /\ s.disk.liveCache \in 0..1
  /\ s.disk.creditsTemp \in 0..2 /\ s.disk.appendTemp \in 0..2
  /\ s.recoveryRuns \in 0..2 /\ s.crashes \in 0..MaxCrashes
  /\ s.owner \in {"free", "note", "writer", "recovery"}
ReferencesExist ==
  Committed(s.disk) => s.disk.version = VersionFiles /\ s.disk.assets = Assets
PublishedImmutable == ~s.rewritten /\ s.disk.oldVersion = OldVersion
LiveCachesUntouched == ~s.cacheWrite /\ s.disk.liveCache = 0
StaleNeverPublishes == ~s.staleCommit
PublishExclusive == ~s.overlap
RecoveryIdempotent == ~s.recoveryBad

\* These retain the literal requested equality, separately from ReferencesExist.
OldBytes == Live(s.disk) = Live(InitialDisk)
NewBytes ==
  /\ s.disk.project = "new" /\ s.disk.assets = Assets /\ s.disk.credits
  /\ s.disk.version = VersionFiles /\ s.disk.oldVersion = OldVersion
  /\ s.disk.liveCache = 0 /\ s.disk.appendTemp = 0
AtRest == s.mode \in {"down", "finished"} \/ s.pc = "done"
OldOrCompleteNew == AtRest => OldBytes \/ NewBytes
ProjectOldOrCompleteNew == AtRest => s.disk.project \in {"old", "manual", "new"}

\* Reachability witnesses: TLC must refute each for a non-vacuous baseline run.
NeverCommitted == ~Committed(s.disk)
NeverRecoveredTwice == s.recoveryRuns < 2
NeverRejectedStale == s.fault # "stale"
=============================================================================
