-------------------------- MODULE OrphanRecovery --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Mutation, MaxCrashes
ASSUME Mutation \in {"none", "return-on-invalid", "delete-invalid", "sweep-refused"}
ASSUME MaxCrashes \in 0..2
Transactions == {"valid", "invalid"}
Assets == {"asset", "thumb"}
VersionFiles == {"export", "snapshot"}
StageFiles == {"manifest", "temp"}
VARIABLE s
vars == <<s>>
\* The valid transaction owns v2. An unrelated v3 must survive the skipped sweep.
Disk == <<s.assets, s.version, s.stage, s.folders, s.invalidBytes, s.unknownVersion>>
Init == s = [pc |-> "start", todo |-> {}, current |-> "valid", refused |-> FALSE,
             assets |-> Assets, version |-> VersionFiles, stage |-> StageFiles,
             folders |-> Transactions, invalidBytes |-> StageFiles,
             unknownVersion |-> VersionFiles, runs |-> 0, crashes |-> 0,
             first |-> <<>>, changedOnRepeat |-> FALSE]

\* recoverNoteStaging snapshots all remaining transaction names each pass.
Start ==
  /\ s.pc = "start"
  /\ s' = [s EXCEPT !.todo = s.folders, !.refused = FALSE, !.pc = "select"]
Select ==
  /\ s.pc = "select" /\ s.todo # {}
  /\ \E txn \in s.todo :
       s' = [s EXCEPT !.current = txn, !.todo = @ \ {txn}, !.pc = "validate"]
Validate ==
  /\ s.pc = "validate"
  /\ IF s.current = "invalid"
       THEN s' = [s EXCEPT !.refused = TRUE,
                          !.pc = CASE Mutation = "return-on-invalid" -> "finish"
                                   [] Mutation = "delete-invalid" -> "invalid-delete"
                                   [] OTHER -> "select"]
       ELSE s' = [s EXCEPT !.pc = "asset-parent"]
DeleteInvalid ==
  /\ s.pc = "invalid-delete" /\ s.invalidBytes # {}
  /\ \E f \in s.invalidBytes : s' = [s EXCEPT !.invalidBytes = @ \ {f}]

\* Parent validation is a separate read before unlink. Paths do not change
\* concurrently in this model; malformed manifests are abstracted by validity.
AssetParent ==
  /\ s.pc = "asset-parent"
  /\ s' = [s EXCEPT !.pc = IF s.assets = {} THEN "version-parent" ELSE "unlink"]
Unlink ==
  /\ s.pc = "unlink" /\ s.assets # {}
  /\ \E f \in s.assets :
       s' = [s EXCEPT !.assets = @ \ {f}, !.pc = "asset-parent"]
VersionParent ==
  /\ s.pc = "version-parent"
  /\ s' = [s EXCEPT !.pc = "version"]
RemoveVersionFile ==
  /\ s.pc = "version" /\ s.version # {}
  /\ \E f \in s.version : s' = [s EXCEPT !.version = @ \ {f}]
VersionDone ==
  /\ s.pc = "version" /\ s.version = {}
  /\ s' = [s EXCEPT !.pc = "stage-parent"]
StageParent ==
  /\ s.pc = "stage-parent"
  /\ s' = [s EXCEPT !.pc = "stage"]
RemoveStageFile ==
  /\ s.pc = "stage" /\ s.stage # {}
  /\ \E f \in s.stage : s' = [s EXCEPT !.stage = @ \ {f}]
RemoveStageFolder ==
  /\ s.pc = "stage" /\ s.stage = {}
  /\ s' = [s EXCEPT !.folders = @ \ {"valid"}, !.pc = "select"]
\* A refusal prevents rmdir(.staging) and the general unpublished-version sweep.
EndScan ==
  /\ s.pc = "select" /\ s.todo = {} /\ s.refused
  /\ s' = [s EXCEPT !.pc = IF Mutation = "sweep-refused" THEN "sweep" ELSE "finish"]
SweepFile ==
  /\ s.pc = "sweep" /\ s.unknownVersion # {}
  /\ \E f \in s.unknownVersion : s' = [s EXCEPT !.unknownVersion = @ \ {f}]
SweepDone == /\ s.pc = "sweep" /\ s.unknownVersion = {}
             /\ s' = [s EXCEPT !.pc = "finish"]
Finish ==
  /\ s.pc = "finish"
  /\ s' = [s EXCEPT !.runs = @ + 1,
                     !.changedOnRepeat = s.runs = 1 /\ s.first # Disk,
                     !.first = IF s.runs = 0 THEN Disk ELSE @,
                     !.pc = IF s.runs = 0 THEN "start" ELSE "done"]
Crash ==
  /\ s.pc \notin {"down", "done"} /\ s.crashes < MaxCrashes
  /\ s' = [s EXCEPT !.pc = "down", !.crashes = @ + 1]
Restart == /\ s.pc = "down" /\ s' = [s EXCEPT !.pc = "start"]
Next == Start \/ Select \/ Validate \/ DeleteInvalid \/ AssetParent \/ Unlink
        \/ VersionParent \/ RemoveVersionFile \/ VersionDone \/ StageParent
        \/ RemoveStageFile \/ RemoveStageFolder \/ EndScan \/ SweepFile \/ SweepDone
        \/ Finish \/ Crash \/ Restart
TypeOK ==
  /\ s.assets \subseteq Assets /\ s.version \subseteq VersionFiles
  /\ s.stage \subseteq StageFiles /\ s.folders \subseteq Transactions
  /\ s.invalidBytes \subseteq StageFiles /\ s.unknownVersion \subseteq VersionFiles
  /\ s.runs \in 0..2 /\ s.crashes \in 0..MaxCrashes
InvalidPreserved == "invalid" \in s.folders /\ s.invalidBytes = StageFiles
                    /\ s.unknownVersion = VersionFiles
ValidRecovered == s.runs > 0 => s.assets = {} /\ s.version = {} /\ s.stage = {}
                                  /\ "valid" \notin s.folders
RecoveryIdempotent == ~s.changedOnRepeat
NeverCompleted == s.runs < 2
=============================================================================
