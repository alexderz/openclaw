import type { ChildRootAuthorization } from "../agents/subagents/registry/subagent-control-root-authority.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TrustedAgentToolCaller } from "./server-methods/types.js";

/** Host-only admission facts; never accepted from model arguments or Gateway wire params. */
export type TrustedSubagentResume = Readonly<{
  caller: TrustedAgentToolCaller;
  childSessionKey: string;
  childSessionId: string;
  previousRunId: string;
  taskRunId: string;
  generation: number | undefined;
  createdAt: number;
  /** Sync revalidation of the child root retained at bind. Not a cached DTO. */
  assertChildRootCurrent: () => ChildRootAuthorization;
  releaseChildRootProof: () => void;
}>;

/** Releases the child-root proof when the admission function returns, including early exits. */
export function releaseParentSubagentResumeOnDispose(
  resume: TrustedSubagentResume | undefined,
): Disposable {
  return {
    [Symbol.dispose]() {
      resume?.releaseChildRootProof();
    },
  };
}

// Published host runtime and source tools must redeem the same process-owned binding.
const resumes = resolveGlobalSingleton<WeakMap<object, TrustedSubagentResume>>(
  Symbol.for("openclaw.inProcessSubagentResumes"),
  () => new WeakMap(),
);

/** Associates host-owned resume authority without widening request, client, or SDK types. */
export function bindInProcessSubagentResume<T extends object>(
  carrier: T,
  resume: TrustedSubagentResume | undefined,
): T {
  if (resume) {
    resumes.set(carrier, resume);
  }
  return carrier;
}

/** Reads only authority attached to this exact in-process carrier, never serialized fields. */
export function readInProcessSubagentResume(
  carrier: object | null | undefined,
): TrustedSubagentResume | undefined {
  return carrier ? resumes.get(carrier) : undefined;
}
