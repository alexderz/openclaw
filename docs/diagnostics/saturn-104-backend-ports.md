# Saturn 2026.10.4 backend source ports

Base: DER-544 f1dbd98550d53c281f5957da70f589887dd47617 on v2026.10.4 383c124cc32f.
Branch: saturn/104-backend-ports. Isolated worktree molting-backend-ports-104.
No installed files, shared maintenance folders, configuration, automations, or Gateway changed.

## Upstream matrix

| Maintenance fix | 10.4 behavior | Source disposition |
| --- | --- | --- |
| claude-cli-task-settlement | STILL NEEDED: live captures 1/2 and synthetic restart/foreground-Bash fail | Hand-ported restart/requeue sets and foreground receipt handling into extensions/anthropic/cli.runtime.ts; retained input lifecycle, authority, hooks, and transport behavior |
| spawn-broker-child-retirement | STILL NEEDED: four finished parent-disconnected IPC children remain owned | Native exit + IPC disconnect + stdio-close join in worker.ts; transferred pipe leases still gate forget; failed-launch cleanup uses same join |
| completion-wake-silent-reply | STILL NEEDED for empty-response retry classification; optional synthetic silence and successful silent-settle custody already supported by DER-544 | Retain required-reply silent-output guard; required silence needs delivery/yield/announcing-child custody. Port retry classification only. Direct-response.ts custody/promotions untouched |
| cli-session-history-cron | STILL NEEDED: eligibility and both process-held provider cases throw prepared-name error | Deferred no-name resolver supplied at two worker-side read boundaries; host label refresh remains authoritative |

Do not retire any of the four maintenance fixes yet. Parent may retire only dist-specific application after the packaged build is verified; no shared folders or automations were deleted.

## Guard

Every check ran through bash /var/lib/openclaw/.openclaw/workspace/scratch/molting-capped-check.sh LABEL CMD... . Each started log confirms both scope and aggregate memory.max=8589934592, memory.swap.max=0; serial flock and 10-minute deadline. Initial busy returned 75 without starting. No typecheck/full build/install ran in this lane. Dependencies reused read-only through local node_modules symlink to parent's molting-saturn-104; lockfile unchanged.

## Behavioral evidence

Receipts are in /var/lib/openclaw/.openclaw/workspace/scratch/LABEL.log and LABEL.exit.

- backend-settlement-baseline: exit 1, genuine old-source live replay failures; backend-settlement-green: exit 0, all nine scenarios pass. Command body: node .backend-port-evidence/stage.mjs && node .backend-port-evidence/settlement.mjs .backend-port-evidence/transpiled/cli.runtime.js . Harness is unchanged original except capture directory relocation, operating on TypeScript transpileModule output.
- backend-broker-baseline: exit 1 bug-present, four IPC children leaked, five controls pass; backend-broker-green: exit 0 fixed, all six lifecycle cases pass. Command body: node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild src/process/spawn-broker/worker.ts --bundle --platform=node --format=esm --packages=external --outfile=.backend-port-evidence/transpiled/worker.js && node .backend-port-evidence/broker.mjs .backend-port-evidence/transpiled/worker.js . Original harness changed only brokerDir to isolated generated output, never stages under live install.
- HISTORICAL, PARTLY SUPERSEDED: backend-wake-baseline/green exercised the retry classifier and an insufficient runner predicate check. The unconditional silent-output allowance was rejected by independent review; use the complete custody matrix below, not that predicate check, for current runner evidence.
- backend-history-baseline: exit 1, forwarded cron throws while normal control passes. backend-history-replay-red repeats final source tests with a Vite loader reading git-HEAD baseline source: three failures, two controls pass, including actual non-Claude eligibility. backend-history-green: exit 0, four tests. backend-eligibility-green: exit 0, one test.
- backend-native-final: exit 0, eleven source tests across four files (held cron, native eligibility, typed/serialized retry classification, broker completion receipt joins).
- backend-anthropic-green: exit 0, four native protocol scenarios (existing two controls plus resumed/requeued agents), 34 skipped. Command: node node_modules/vitest/vitest.mjs run --config .backend-port-evidence/source-tests.config.mts extensions/anthropic/cli-runtime.test.ts -t 'keeps an interim result open'.
- HISTORICAL, INVALIDATED: backend-runner-silence passed two required-silence cases while skipping 50, including the negative child-custody control. Those permissive cases were corrected after independent review; they are not approval evidence.
- backend-custody-proof: exit 0, five controls exercise unchanged direct-response predicate (successful silence accepted, yielded/pending/aborted/error/visible output not consumed).
- backend-format-syntax: exit 0; oxfmt 13 explicit roots, transpile syntax 13 roots, git diff --check. This is syntax validation, NOT a typecheck.

All vitest commands use node node_modules/vitest/vitest.mjs run --config .backend-port-evidence/{vitest,source-tests,history-baseline}.config.mts with explicit filenames. Scratch configs supply source aliases and read-only pnpm dependency reuse; no dependency installation.

## Still required by parent

- Full packaged build, then rerun all four maintenance harnesses on generated modules (adapt hashes / split modules; do not apply dist diffs).
- Approved bounded typecheck if desired; no full-repo tsc performed here.
- Broader CLI reliability/persistence suite and narrow existing announce custody suites; only the complete relevant custody matrix below is green, not all reliability cases. Preserve accepted DER-544 authority/custody semantics. No live private-session smoke or Gateway reload performed.
- Source tests/syntax are not proof of loaded Gateway behavior.

## Independent-review correction (supersedes initial silence evidence)

The independent review correctly blocked the first source-port commit: unconditional acceptance of NO_REPLY weakened required terminal-reply custody, and the native completion helper assumed stdio existed on EMFILE/ENFILE failed spawn.

Changes:

- Restore the original required-reply predicate using isSilentReplyPayloadText (the import is again used). Optional synthetic settle turns can remain silent through the existing resolveReplyExpectation policy. Explicit requiredness still wins. An accepted child must actually expect a completion message before its custody can exempt required silent/empty output; non-announcing accepted children reject empty_response with model fallback stopped. No-child required silence rejects empty_response without inventing a fallback-stop requirement when no side effect occurred.
- Join child.stdio ?? [] so a failed native spawn with no PID or stdio preserves its original EMFILE/ENFILE error. New tests mirror the launch error-rethrow path and verify error/exit/disconnect listeners are removed.
- Expand the complete relevant CLI matrix to sixteen cases: bare/JSON silence and empty text, announcing/non-announcing child custody, no-child requiredness, optional synthetic provenance, explicit requiredness overriding synthetic provenance, and source final/progress/wrong-target delivery. Five broker receipt cases include both no-stdio failures. Promotion/direct-response modules are unchanged.

Capped commands/receipts (same 8 GiB aggregate/scope, swap 0, serial launcher, no cap increase):

- backend-review-red: initial full 61-case reliability + five broker run on pre-fix source. Reproduced required-custody failures and EMFILE/ENFILE becoming TypeError: child.stdio is not iterable. Also exposed unrelated broader persistence controls and initially over-strict no-child fallback-stop assertions; those new assertions were corrected.
- backend-review-matrix-red: final sixteen-case custody matrix against exact pre-review cli-runner source from 845452860c8 via a read-only Vite loader. Exit 1; eight required-silence failures and eight controls passing reproduced without editing the working source. Command: node node_modules/vitest/vitest.mjs run --config .backend-port-evidence/review-before.config.mts src/agents/cli-runner.reliability.test.ts -t 'settles NO_REPLY|child continuation custody|uncustodied required|synthetic settle silence|explicit required policy'.
- backend-review-matrix-green: same complete relevant matrix against corrected source: sixteen pass (45 unrelated reliability tests skipped), followed by all five broker receipt cases passing. Command uses source-tests.config.mts and the same -t expression, then a second explicit worker.child-retirement.test.ts invocation. The parent wrapper owns both sequential invocations.
- Full reliability was attempted, not claimed green. The post-fix full run exposed seven broader transcript-persistence/control failures as well as five over-strict new fallback-stop assertions subsequently removed. Those seven are outside this correction; baseline control verification is recorded below. The complete relevant custody matrix is the approved alternative verification scope requested by the parent.

- backend-review-base-controls: exit 1, the same seven broader persistence/control cases fail when the loader supplies the unmodified DER-544 f1dbd98550d53c281f5957da70f589887dd47617 cli-runner.ts. This isolates them from the corrected runner predicate, but does not diagnose or fix them. Command: node node_modules/vitest/vitest.mjs run --config .backend-port-evidence/review-base.config.mts src/agents/cli-runner.reliability.test.ts -t 'returns accepted CLI session spawns|durable local proof|before_message_write|canonical recorder|restrictive prompt preparation'.
- backend-review-static: exit 0, oxfmt and oxlint --deny no-unused-vars on the four explicit changed TS roots (231 lint rules, zero warnings/errors), four-root transpile syntax and git diff --check, then all five native receipt tests pass. No typecheck or build was run. Narrow lint first caught and prompted fixes for new test-only shadowing and a Promise executor return.

Compiled-package adapters remain paused awaiting a corrected explicit stage root. Their expected runner predicate now requires custody for required silence, preserves optional silence, and their broker adapter adds both no-stdio resource-failure controls. No package/live module has been modified or tested by these prepared adapters yet.
