# Saturn 2026.10.4 backend source ports

Base: DER-544 f1dbd98550d53c281f5957da70f589887dd47617 on v2026.10.4 383c124cc32f.
Branch: saturn/104-backend-ports. Isolated worktree molting-backend-ports-104.
No installed files, shared maintenance folders, configuration, automations, or Gateway changed.

## Upstream matrix

| Maintenance fix | 10.4 behavior | Source disposition |
| --- | --- | --- |
| claude-cli-task-settlement | STILL NEEDED: live captures 1/2 and synthetic restart/foreground-Bash fail | Hand-ported restart/requeue sets and foreground receipt handling into extensions/anthropic/cli.runtime.ts; retained input lifecycle, authority, hooks, and transport behavior |
| spawn-broker-child-retirement | STILL NEEDED: four finished parent-disconnected IPC children remain owned | Native exit + IPC disconnect + stdio-close join in worker.ts; transferred pipe leases still gate forget; failed-launch cleanup uses same join |
| completion-wake-silent-reply | PARTIAL: CLI silence rejected and empty-response retry classification absent; successful silent-settle custody already supported by newer DER-544 predicate | Only cli-runner.ts empty-text predicate and retry.ts classification changed; direct-response.ts custody/promotions untouched. Five extracted predicate behavioral controls pass |
| cli-session-history-cron | STILL NEEDED: eligibility and both process-held provider cases throw prepared-name error | Deferred no-name resolver supplied at two worker-side read boundaries; host label refresh remains authoritative |

Do not retire any of the four maintenance fixes yet. Parent may retire only dist-specific application after the packaged build is verified; no shared folders or automations were deleted.

## Guard

Every check ran through bash /var/lib/openclaw/.openclaw/workspace/scratch/molting-capped-check.sh LABEL CMD... . Each started log confirms both scope and aggregate memory.max=8589934592, memory.swap.max=0; serial flock and 10-minute deadline. Initial busy returned 75 without starting. No typecheck/full build/install ran in this lane. Dependencies reused read-only through local node_modules symlink to parent's molting-saturn-104; lockfile unchanged.

## Behavioral evidence

Receipts are in /var/lib/openclaw/.openclaw/workspace/scratch/LABEL.log and LABEL.exit.

- backend-settlement-baseline: exit 1, genuine old-source live replay failures; backend-settlement-green: exit 0, all nine scenarios pass. Command body: node .backend-port-evidence/stage.mjs && node .backend-port-evidence/settlement.mjs .backend-port-evidence/transpiled/cli.runtime.js . Harness is unchanged original except capture directory relocation, operating on TypeScript transpileModule output.
- backend-broker-baseline: exit 1 bug-present, four IPC children leaked, five controls pass; backend-broker-green: exit 0 fixed, all six lifecycle cases pass. Command body: node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild src/process/spawn-broker/worker.ts --bundle --platform=node --format=esm --packages=external --outfile=.backend-port-evidence/transpiled/worker.js && node .backend-port-evidence/broker.mjs .backend-port-evidence/transpiled/worker.js . Original harness changed only brokerDir to isolated generated output, never stages under live install.
- backend-wake-baseline: exit 1, three failed checks + one control; backend-wake-green: exit 0, four checks. Source extraction retains real retry classifier; runner predicate checked as original maintenance harness did.
- backend-history-baseline: exit 1, forwarded cron throws while normal control passes. backend-history-replay-red repeats final source tests with a Vite loader reading git-HEAD baseline source: three failures, two controls pass, including actual non-Claude eligibility. backend-history-green: exit 0, four tests. backend-eligibility-green: exit 0, one test.
- backend-native-final: exit 0, eleven source tests across four files (held cron, native eligibility, typed/serialized retry classification, broker completion receipt joins).
- backend-anthropic-green: exit 0, four native protocol scenarios (existing two controls plus resumed/requeued agents), 34 skipped. Command: node node_modules/vitest/vitest.mjs run --config .backend-port-evidence/source-tests.config.mts extensions/anthropic/cli-runtime.test.ts -t 'keeps an interim result open'.
- backend-runner-silence: exit 0, two real runner cases preserve bare/JSON intentional silence with required terminal-reply custody (50 skipped); 21.16s.
- backend-custody-proof: exit 0, five controls exercise unchanged direct-response predicate (successful silence accepted, yielded/pending/aborted/error/visible output not consumed).
- backend-format-syntax: exit 0; oxfmt 13 explicit roots, transpile syntax 13 roots, git diff --check. This is syntax validation, NOT a typecheck.

All vitest commands use node node_modules/vitest/vitest.mjs run --config .backend-port-evidence/{vitest,source-tests,history-baseline}.config.mts with explicit filenames. Scratch configs supply source aliases and read-only pnpm dependency reuse; no dependency installation.

## Still required by parent

- Full packaged build, then rerun all four maintenance harnesses on generated modules (adapt hashes / split modules; do not apply dist diffs).
- Approved bounded typecheck if desired; no full-repo tsc performed here.
- Broader CLI reliability suite and narrow existing announce custody suites; required-silence cases passed; preserve accepted DER-544 authority/custody semantics. No live private-session smoke or Gateway reload performed.
- Source tests/syntax are not proof of loaded Gateway behavior.
