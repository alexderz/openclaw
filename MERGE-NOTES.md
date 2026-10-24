# Window 108: merge of upstream v2026.10.7 into der-544/107-combined

- Base: `der-544/107-combined` @ `55a97471673ceb461d6b2c1beb23f2070be1d442` (window 107, unchanged).
- Upstream: tag `v2026.10.7` (tag object `5c101ce5a06`, commit `157d8c2bc3e`, verified with `git ls-remote` against openclaw/openclaw). Merge base `1b58cb9` (v2026.10.5).
- Method: `git merge --no-ff v2026.10.7` (a merge, not a rebase, so every fork commit keeps its SHA).
- Conflicts: 8 files, 22 hunks, as `scratch/der-rebase-1010-assess` (DER-629) predicted. Plus one clean-merge follow-up (see 6).

## Resolutions

1. **`src/auto-reply/reply/session-event-handoff.ts`** (9 hunks; our #169529 port 136cf85 and DER-604 6d2d47a vs upstream #169529 4270111).
   Took upstream's file whole, then re-applied DER-604's own diff (6d2d47a) on top. 9 of its 10 hunks applied as-is; the `onAbandoned` hunk was placed by hand after upstream's new abandonment bookkeeping (`failureClass = "final"` unconditionally, as on 107).
   One deliberate addition: upstream's `configChangeRetention` also requires `!activityBegun` (a DER-604 flag). A config refusal at the runner's first reported activity (`onStarted`'s own check) leaves `started` false, so upstream alone would re-admit a turn that may already have run. The guard is load-bearing: with it removed, `der604-readmission` "does not re-admit after the runner reported model activity" fails; with it, 5/5 pass.
   Dropped with the port (upstream behaviour now): the suffixed readmission `MessageSid` (upstream frees the queue dedupe key on abandonment instead), re-admission after a refusal reported only as pre-adoption abandonment, and the once-only producer `onAdopted` (upstream may call it again on a re-admitted attempt; only the restart sentinel and session-state notices pass `onAdopted`, exec does not).
2. **`src/auto-reply/reply/session-event-handoff.test.ts`** (1 hunk): upstream's file. Our port's edits there only re-expressed the same "policy failure re-admits once" cases upstream now covers.
   **`session-event-handoff.config-readmission.test.ts`** (port-only file, merged clean): removed. Its 5 cases that still hold on upstream code (undeferred re-admission, no re-admission after model activity, plain abandonment terminal, cancel forwarded, DER-604 retryable kept) are kept as `session-event-handoff.der604-readmission.test.ts`. The 3 port-only cases are deleted.
3. **`src/agents/bash-tools.exec-run.ts`** (1 hunk; DER-593 e45b99f vs upstream #169645 25ecf35). Kept DER-593's `execBackgroundFollowUp` helper (hidden-subagent wording) and fed it upstream's runtime state: `notifyOnExit: run.session.notifyOnExit === true`, computed after the process starts, so a failed wake-target capture (which #169645 makes clear `notifyOnExit`) shows the manual-collection guidance. Both visible text and `details.followUp` use the same value.
4. **`src/agents/bash-tools.exec-background-followup.test.ts`** (2 hunks). Took upstream's rewritten real-infrastructure file. Re-expressed DER-593 in it: in "starts and notifies…", the recovered iteration (spawned dashboard, `spawnDepth 1`) now wakes too (receipts and model calls 2, follow-up says "Completion wakes this conversation"), and the hidden-subagent case is re-added on the real fixture (no receipt, no model call, "does not wake it").
5. **`src/infra/agent-run-registry.ts`** (1 hunk; DER-594 d0a0cec vs upstream #176422 5c0d399). DER-594 moved the cron next-check helpers to `src/infra/agent-run-cron-next-check.ts` (max-lines); upstream changed them in place. Kept the move and ported #176422's change into the moved file: the execution-owner check, `nextCheckEnabled` instead of `pacingEnabled`, and the new error text. DER-593's registry changes (merged clean) are untouched.
6. **`src/cron/isolated-agent/run.fast-mode.test.ts`** (clean merge, would not compile): upstream's new test imports `recordCronNextCheckProposal` from the registry; it now imports it from `agent-run-cron-next-check.js`.
7. **The 3 prompt snapshots** (8 hunks; DER-544): regenerated with `scripts/generate-prompt-snapshots.ts --write` (`pnpm prompt:snapshots:gen`), not hand-edited; `--check` then reports 7 files current. The fork's delta against upstream 10.7 is the same 5 files and 26 lines as 107's delta against 10.5.

## Not changed

Every other fork commit merged clean. Upstream 10.6/10.7 did not touch the local-patch files (claude-cli task settlement, CLI history cron, spawn-broker worker, announce retry/delivery, mobile UI); see the window-108 handoff evidence for the re-checks.
