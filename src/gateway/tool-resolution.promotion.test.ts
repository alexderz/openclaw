import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { createOpenClawCodingTools } from "../agents/agent-tools.js";
import type { createOpenClawTools } from "../agents/openclaw-tools.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { SessionEffectiveAdmission } from "../sessions/session-promotion-state.js";
import { captureSessionEffectiveAdmissionForTest } from "../sessions/session-promotion-state.test-support.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

type CreateOpenClawToolsArg = Parameters<typeof createOpenClawTools>[0];
type CreateOpenClawCodingToolsArg = Parameters<typeof createOpenClawCodingTools>[0];

const { createTools, codingTools } = vi.hoisted(() => {
  const buildTool = (name: string) => ({
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  });
  return {
    codingTools: vi.fn((_args: CreateOpenClawCodingToolsArg): ReturnType<typeof buildTool>[] => []),
    createTools: vi.fn((_args: CreateOpenClawToolsArg) =>
      ["read", "sessions_send", "sessions_list"].map(buildTool),
    ),
  };
});

vi.mock("../agents/openclaw-tools.js", () => ({ createOpenClawTools: createTools }));
vi.mock("../agents/agent-tools.js", () => ({ createOpenClawCodingTools: codingTools }));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const sessionId = "promoted-session";
const entryFields: InternalSessionEntry = {
  sessionId,
  updatedAt: 1,
  spawnedBy: "agent:main:main",
  parentSessionKey: "agent:main:main",
  spawnDepth: 1,
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: ["read"],
  lifecycleRevision: "after-handoff",
};

// An administrator may promote a subagent-key task session too; its key shape alone must not
// keep the delegated envelope once an ordinary admission was minted for it.
describe.each([
  ["dashboard", "agent:main:dashboard:promoted-peer"],
  ["subagent", "agent:main:subagent:promoted-task"],
])("loopback tool resolution consumes the admitted session class (%s key)", (_kind, sessionKey) => {
  function admissionOf(effectiveClass: "ordinary" | "delegated"): SessionEffectiveAdmission {
    return captureSessionEffectiveAdmissionForTest({ sessionKey, sessionId, effectiveClass });
  }
  let dir: string;
  let previousStateDir: string | undefined;
  const admissions: PreparedAgentRunAdmission[] = [];

  beforeEach(() => {
    createTools.mockClear();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-promoted-tools-")));
    process.env.OPENCLAW_STATE_DIR = dir;
    replaceSessionEntrySync(
      {
        sessionKey,
        storePath: path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      },
      entryFields,
    );
  });

  afterEach(async () => {
    admissions.splice(0).forEach((admission) => admission.close());
    await closeOpenClawAgentDatabaseByPathAsync(
      path.join(dir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }),
    );
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function admittedContext(admission?: SessionEffectiveAdmission) {
    const prepared = prepareSystemAgentRunAdmission(
      {},
      "run-promoted",
      "main",
      "promotion-tool-resolution-test",
      undefined,
      admission
        ? createAdmittedRunOperatorAuthority({
            profileId: "human",
            scopes: [],
            assertCurrent() {},
            sessionEffectiveAdmission: admission,
          })
        : undefined,
    );
    admissions.push(prepared);
    return await prepared.admit("embedded");
  }

  function resolve(
    admittedRunContext: Awaited<ReturnType<typeof admittedContext>>,
    cfg: Parameters<typeof resolveGatewayScopedTools>[0]["cfg"] = {},
  ) {
    return resolveGatewayScopedTools({
      cfg,
      sessionKey,
      sessionId,
      runId: "run-promoted",
      surface: "loopback",
      admittedRunContext,
    });
  }

  it("lifts the delegated envelope and gives sessions_send ordinary semantics for an ordinary admission", async () => {
    const admission = admissionOf("ordinary");
    const result = resolve(await admittedContext(admission));
    expect(result.tools.map((tool) => tool.name)).toContain("sessions_send");
    expect(createTools.mock.calls[0]?.[0]?.sessionEffectiveAdmission).toBe(admission);
  });

  it("keeps a pre-handoff delegated admission delegated even when the live row is promoted", async () => {
    const result = resolve(await admittedContext(admissionOf("delegated")));
    expect(result.tools.map((tool) => tool.name)).not.toContain("sessions_send");
    expect(result.tools.map((tool) => tool.name)).toContain("read");
  });

  it("keeps an admission without a captured class delegated", async () => {
    const result = resolve(await admittedContext());
    expect(result.tools.map((tool) => tool.name)).not.toContain("sessions_send");
  });

  it("still applies agent-wide config restrictions to an ordinary admission", async () => {
    const result = resolve(await admittedContext(admissionOf("ordinary")), {
      tools: { deny: ["sessions_send"] },
    });
    expect(result.tools.map((tool) => tool.name)).not.toContain("sessions_send");
  });
});
