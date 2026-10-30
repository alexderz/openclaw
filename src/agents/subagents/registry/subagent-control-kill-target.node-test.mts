import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRunOwnedKillTarget } from "./subagent-control-kill-target.ts";

const key = "agent:main:subagent:child";
const record = (identity: any, target: any) => ({
  childSessionKey: key, childSessionIdentity: identity, execution: { transcriptTarget: target },
}) as any;

test("run target requires a complete recorded pair, never stitched partial facts", () => {
  assert.equal(resolveRunOwnedKillTarget(record({ sessionId: "old" }, { sessionKey: key, expectedLifecycleRevision: "new" })), undefined);
  assert.equal(resolveRunOwnedKillTarget(record(undefined, undefined)), undefined);
  assert.equal(resolveRunOwnedKillTarget(record({ sessionId: "old" }, undefined)), undefined);
  assert.equal(resolveRunOwnedKillTarget(record({ lifecycleRevision: "old" }, undefined)), undefined);
  assert.deepEqual(resolveRunOwnedKillTarget(record({ sessionId: "id", lifecycleRevision: "rev" }, undefined)), {
    sessionKey: key, sessionId: "id", expectedLifecycleRevision: "rev",
  });
});

test("rejects mismatched key and conflicting complete incarnations", () => {
  assert.throws(() => resolveRunOwnedKillTarget(record({ sessionId: "id", lifecycleRevision: "rev" }, { sessionKey: "other", sessionId: "id", expectedLifecycleRevision: "rev" })), /target key changed/);
  assert.throws(() => resolveRunOwnedKillTarget(record({ sessionId: "old", lifecycleRevision: "old-rev" }, { sessionKey: key, sessionId: "new", expectedLifecycleRevision: "new-rev" })), /records disagree/);
  assert.throws(() => resolveRunOwnedKillTarget(record({ sessionId: "old", lifecycleRevision: "rev" }, { sessionKey: key, sessionId: "new" })), /records disagree/);
  assert.equal(resolveRunOwnedKillTarget(record(undefined, { sessionKey: key, sessionId: "id", expectedLifecycleRevision: "rev" }))?.sessionId, "id");
});
