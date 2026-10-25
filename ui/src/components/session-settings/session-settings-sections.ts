import { html, nothing, type TemplateResult } from "lit";
import type { BoardSnapshot } from "../../../../packages/gateway-protocol/src/schema/board.js";
import type { SessionsProcessesListResult } from "../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { formatAgentRuntimeLabel } from "../../../../src/shared/agent-runtime-display.js";
import type {
  CronJobsListResult,
  GatewaySessionRow,
  SessionsListResult,
  SessionsUsageResult,
  ToolsEffectiveResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatCompactTokenCount, formatCost } from "../../lib/format.ts";
import { resolveSessionContextLimit } from "../../lib/sessions/context-budget.ts";
import {
  capabilityFacts,
  capabilityRestrictionLabels,
} from "../../pages/chat/components/session-capability-info.ts";
import type { SessionMenuData } from "../session-menu-actions.ts";
import {
  effectiveToolGroups,
  summarizeSessionPermissions,
  type SessionPermissionsSummary,
} from "./session-settings-permissions.ts";

const KEY = "chat.sessionSettings";

export type SectionLoad<T> =
  | { status: "loading" }
  | { status: "done"; value: T }
  | { status: "error"; error: string }
  | { status: "unavailable" };

type Fact = [label: string, value: string | TemplateResult | undefined | null];

/** Label/value pairs; a missing value drops its row, so sections never show empty labels. */
export function renderFacts(rows: Fact[]) {
  const shown = rows.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return shown.length
    ? html`<dl class="session-settings__facts">
        ${shown.map(
          ([label, value]) =>
            html`<dt>${label}</dt>
              <dd>${value}</dd>`,
        )}
      </dl>`
    : nothing;
}

function list(values: string[]) {
  return values.length === 1
    ? values[0]
    : html`<ul class="session-settings__list">
        ${values.map((value) => html`<li>${value}</li>`)}
      </ul>`;
}

/** Load state for sections whose data is not on the row. */
export function renderLoad<T>(
  load: SectionLoad<T> | undefined,
  ready: (value: T) => unknown,
  onRetry: () => void,
) {
  if (!load || load.status === "loading") {
    return html`<p class="session-settings__muted" role="status">${t("common.loading")}</p>`;
  }
  if (load.status === "unavailable") {
    return html`<p class="session-settings__muted">${t(`${KEY}.unavailable`)}</p>`;
  }
  if (load.status === "error") {
    return html`<p class="session-settings__muted" role="alert">
      ${t(`${KEY}.failed`, { error: load.error })}
      <button type="button" class="btn btn--sm session-settings__retry" @click=${onRetry}>
        ${t(`${KEY}.retry`)}
      </button>
    </p>`;
  }
  return ready(load.value);
}

function formatDate(ms: number | undefined | null) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toLocaleString() : undefined;
}

function actorLabel(actor: { label?: string; id?: string; type: string } | undefined) {
  return actor ? (actor.label ?? actor.id ?? actor.type) : undefined;
}

export function renderIdentitySection(
  row: GatewaySessionRow | undefined,
  session: SessionMenuData,
) {
  const created = actorLabel(row?.createdActor);
  const createdAt = formatDate(row?.createdAt);
  return renderFacts([
    [t(`${KEY}.identity.name`), session.label],
    [t(`${KEY}.identity.key`), html`<code>${row?.key ?? session.key}</code>`],
    [
      t(`${KEY}.identity.sessionId`),
      session.sessionId ? html`<code>${session.sessionId}</code>` : undefined,
    ],
    [t(`${KEY}.identity.group`), row?.category ?? session.category ?? t(`${KEY}.actions.noGroup`)],
    [
      t(`${KEY}.identity.createdBy`),
      created && createdAt
        ? t(`${KEY}.identity.createdByWhen`, { actor: created, date: createdAt })
        : (created ?? createdAt),
    ],
    [t(`${KEY}.identity.owner`), actorLabel(row?.owner?.actor) ?? t(`${KEY}.identity.noOwner`)],
  ]);
}

export function renderClassSection(session: SessionMenuData, capabilityLabel: string) {
  return renderFacts(
    capabilityFacts(session, capabilityLabel).map(([label, values]) => [label, list(values)]),
  );
}

export type LineageChildren = { subagents: number; visible: number };

/** Sub-agent runs and visible sessions are counted apart: only the second have a sidebar row. */
export function countChildSessions(result: SessionsListResult): LineageChildren {
  const subagents = result.sessions.filter((row) => row.key.includes(":subagent:")).length;
  return { subagents, visible: result.sessions.length - subagents };
}

export function renderLineageSection(params: {
  row: GatewaySessionRow | undefined;
  parentLabel: string | undefined;
  children: SectionLoad<LineageChildren> | undefined;
  onRetry: () => void;
}) {
  const { row } = params;
  return html`${renderFacts([
    [t(`${KEY}.lineage.parent`), params.parentLabel ?? t(`${KEY}.lineage.topLevel`)],
    [t(`${KEY}.lineage.depth`), String(row?.spawnDepth ?? 0)],
    [t(`${KEY}.lineage.liveChildren`), String(row?.childSessions?.length ?? 0)],
  ])}
  ${renderFacts([
    [
      t(`${KEY}.lineage.totalChildren`),
      html`${renderLoad(
        params.children,
        (counts) =>
          t(`${KEY}.lineage.childCounts`, {
            subagents: String(counts.subagents),
            visible: String(counts.visible),
          }),
        params.onRetry,
      )}`,
    ],
  ])}`;
}

function permissionsHeadline(summary: Extract<SessionPermissionsSummary, { kind: "limited" }>) {
  const extra =
    summary.extraCount === 0
      ? t(`${KEY}.permissions.standardOnly`)
      : summary.extraCount === 1
        ? t(`${KEY}.permissions.extraLimit`)
        : t(`${KEY}.permissions.extraLimits`, { count: String(summary.extraCount) });
  const send =
    summary.sessionsSend === "denied"
      ? t(`${KEY}.permissions.sendDenied`)
      : summary.sessionsSend === "allowed"
        ? t(`${KEY}.permissions.sendAllowed`)
        : t(`${KEY}.permissions.sendUnknown`);
  return [t(`${KEY}.permissions.${summary.evaluatedClass}`), extra, send].join(" · ");
}

function renderToolList(tools: string[]) {
  return html`<ul class="session-settings__tools">
    ${tools.map((tool) => html`<li><code>${tool}</code></li>`)}
  </ul>`;
}

function renderAllTools(result: ToolsEffectiveResult, count: number) {
  return html`<details class="session-settings__fold" data-fold="all-tools">
    <summary>${t(`${KEY}.permissions.showAll`, { count: String(count) })}</summary>
    ${effectiveToolGroups(result).map(
      (group) => html`<p class="session-settings__tool-group">
        <span class="session-settings__muted">${group.label}</span>
        ${group.tools.map((tool) => html`<code>${tool}</code> `)}
      </p>`,
    )}
  </details>`;
}

/**
 * Summary first: one headline, the standard sub-agent denials folded to one line, then only the
 * limits beyond them by source, and every tool behind one more fold. Unknown says so plainly.
 */
export function renderPermissionsSection(params: {
  session: SessionMenuData;
  tools: SectionLoad<ToolsEffectiveResult> | undefined;
  onRetry: () => void;
}) {
  const status = params.session.capabilityStatus;
  const load = params.tools;
  if (!load || load.status === "loading") {
    return html`<p class="session-settings__headline" role="status">
      ${t(`${KEY}.permissions.checking`)}
    </p>`;
  }
  const result = load.status === "done" ? load.value : null;
  const summary = summarizeSessionPermissions(status, result);
  if (summary.kind === "unknown") {
    // The row may still carry a matching earlier evaluation; say what it recorded, nothing more.
    const recorded = status?.toolLimits ? capabilityRestrictionLabels(status) : [];
    return html`<p class="session-settings__headline">${t(`${KEY}.permissions.notChecked`)}</p>
      ${recorded.length ? list(recorded) : nothing}
      ${load.status === "done" ? nothing : renderLoad(load, () => nothing, params.onRetry)}`;
  }
  const viewerNote = summary.viewerDiffers
    ? html`<p class="session-settings__muted">${t(`${KEY}.permissions.viewerDiffers`)}</p>`
    : nothing;
  if (summary.kind === "full") {
    return html`<p class="session-settings__headline">${t(`${KEY}.permissions.full`)}</p>
      ${viewerNote}`;
  }
  return html`<p class="session-settings__headline">${permissionsHeadline(summary)}</p>
    ${viewerNote}
    ${
      summary.standard.length
        ? html`<details class="session-settings__fold" data-fold="standard">
            <summary>
              ${t(`${KEY}.permissions.standard`, { count: String(summary.standard.length) })}
            </summary>
            <p class="session-settings__muted">${t(`${KEY}.permissions.standardHint`)}</p>
            ${renderToolList(summary.standard)}
          </details>`
        : nothing
    }
    ${summary.groups.map(
      (group) => html`<section class="session-settings__limits" data-origin=${group.origin}>
        <h4>${t(`${KEY}.permissions.origin.${group.origin}`)}</h4>
        ${renderToolList(group.tools)}
      </section>`,
    )}
    ${result ? renderAllTools(result, summary.toolCount) : nothing}`;
}

function fallbackLabel(row: GatewaySessionRow) {
  const fallbacks = row.modelFallbacks;
  if (!fallbacks) {
    return undefined;
  }
  switch (fallbacks.state) {
    case "active":
      return fallbacks.models?.join(" → ") ?? t(`${KEY}.models.fallbacksNone`);
    case "none":
      return t(`${KEY}.models.fallbacksNone`);
    case "disabled-by-model-override":
      return t(`${KEY}.models.fallbacksOverride`);
    case "disabled-by-model-lock":
      return t(`${KEY}.models.fallbacksLock`);
    default:
      return fallbacks.state satisfies never;
  }
}

function modelRef(provider: string | undefined, model: string | undefined) {
  return model ? (provider ? `${provider}/${model}` : model) : undefined;
}

export function renderModelsSection(params: {
  row: GatewaySessionRow | undefined;
  usage: SectionLoad<SessionsUsageResult> | undefined;
  onRetry: () => void;
}) {
  const { row } = params;
  if (!row) {
    return html`<p class="session-settings__muted">${t(`${KEY}.unknown`)}</p>`;
  }
  const selected = modelRef(row.modelProvider, row.model);
  const active = modelRef(row.activeModelProvider, row.activeModel);
  const auth = row.authProfile
    ? row.authProfile.kind === "personal"
      ? t(`${KEY}.models.personal`)
      : row.authProfile.label
    : undefined;
  return html`${renderFacts([
      [t(`${KEY}.models.model`), selected],
      [t(`${KEY}.models.activeModel`), active && active !== selected ? active : undefined],
      [t(`${KEY}.models.fallbacks`), fallbackLabel(row)],
      [
        t(`${KEY}.models.runtime`),
        row.agentRuntime ? formatAgentRuntimeLabel(row.agentRuntime) : undefined,
      ],
      [t(`${KEY}.models.authProfile`), auth],
      [t(`${KEY}.models.execHost`), row.execHost ?? row.execNode],
      [t(`${KEY}.models.elevated`), row.elevatedLevel],
      [t(`${KEY}.models.sandbox`), row.sandboxMode],
    ])}
    <h4 class="session-settings__subheading">${t(`${KEY}.models.used`)}</h4>
    ${renderLoad(
      params.usage,
      (result) => {
        const models = (result.sessions[0]?.usage?.modelUsage ?? []).toSorted(
          (left, right) => right.totals.totalTokens - left.totals.totalTokens,
        );
        const total = models.reduce((sum, entry) => sum + entry.totals.totalTokens, 0);
        return models.length && total > 0
          ? renderFacts(
              models.map((entry) => [
                modelRef(entry.provider, entry.model) ?? t(`${KEY}.unknown`),
                t(`${KEY}.models.share`, {
                  tokens: formatCompactTokenCount(entry.totals.totalTokens),
                  percent: String(Math.round((entry.totals.totalTokens / total) * 100)),
                }),
              ]),
            )
          : html`<p class="session-settings__muted">${t(`${KEY}.models.noUsage`)}</p>`;
      },
      params.onRetry,
    )}`;
}

export function renderUsageSection(row: GatewaySessionRow | undefined) {
  if (!row) {
    return html`<p class="session-settings__muted">${t(`${KEY}.unknown`)}</p>`;
  }
  const tokens = (value: number | undefined) =>
    typeof value === "number" ? formatCompactTokenCount(value) : undefined;
  const limit = resolveSessionContextLimit(row).tokens;
  const used = row.totalTokensFresh === false ? undefined : row.totalTokens;
  return renderFacts([
    [t(`${KEY}.usage.input`), tokens(row.inputTokens)],
    [t(`${KEY}.usage.output`), tokens(row.outputTokens)],
    [t(`${KEY}.usage.cacheRead`), tokens(row.cacheReadTokens)],
    [t(`${KEY}.usage.cacheWrite`), tokens(row.cacheWriteTokens)],
    [
      t(`${KEY}.usage.cost`),
      typeof row.estimatedCostUsd === "number" ? formatCost(row.estimatedCostUsd) : undefined,
    ],
    [
      t(`${KEY}.usage.context`),
      typeof used === "number" && limit > 0
        ? t(`${KEY}.usage.contextFill`, {
            used: formatCompactTokenCount(used),
            limit: formatCompactTokenCount(limit),
            percent: String(Math.min(100, Math.round((used / limit) * 100))),
          })
        : undefined,
    ],
    [
      t(`${KEY}.usage.compactions`),
      typeof row.compactionCount === "number" ? String(row.compactionCount) : undefined,
    ],
  ]);
}

export function renderActivitySection(params: {
  row: GatewaySessionRow | undefined;
  processes: SectionLoad<SessionsProcessesListResult> | undefined;
  automations: SectionLoad<CronJobsListResult> | undefined;
  onRetryProcesses: () => void;
  onRetryAutomations: () => void;
}) {
  const { row } = params;
  const running = row?.hasActiveRun ?? row?.status === "running";
  return renderFacts([
    [t(`${KEY}.activity.state`), t(`${KEY}.activity.${running ? "running" : "idle"}`)],
    [t(`${KEY}.activity.queueMode`), row?.effectiveQueueMode ?? row?.queueMode],
    [t(`${KEY}.activity.liveChildren`), String(row?.childSessions?.length ?? 0)],
    [
      t(`${KEY}.activity.processes`),
      html`${renderLoad(
        params.processes,
        (result) =>
          t(`${KEY}.activity.processCounts`, {
            running: String(result.processes.filter((entry) => entry.status === "running").length),
            total: String(result.processes.length),
          }),
        params.onRetryProcesses,
      )}`,
    ],
    [
      t(`${KEY}.activity.automations`),
      html`${renderLoad(
        params.automations,
        (result) =>
          result.jobs.length
            ? list(
                result.jobs.map((job) =>
                  t(`${KEY}.activity.${job.enabled ? "automationEnabled" : "automationDisabled"}`, {
                    name: job.displayName ?? job.name,
                  }),
                ),
              )
            : t(`${KEY}.none`),
        params.onRetryAutomations,
      )}`,
    ],
  ]);
}

export function renderDashboardSection(params: {
  row: GatewaySessionRow | undefined;
  board: SectionLoad<BoardSnapshot> | undefined;
  onRetry: () => void;
}) {
  if (params.row?.hasBoard === false) {
    return html`<p class="session-settings__muted">${t(`${KEY}.dashboard.none`)}</p>`;
  }
  return renderLoad(
    params.board,
    (snapshot) =>
      snapshot.tabs.length
        ? renderFacts(
            snapshot.tabs.map((tab) => {
              const count = snapshot.widgets.filter((widget) => widget.tabId === tab.tabId).length;
              return [
                tab.title,
                count === 1
                  ? t(`${KEY}.dashboard.widget`)
                  : t(`${KEY}.dashboard.widgets`, { count: String(count) }),
              ];
            }),
          )
        : html`<p class="session-settings__muted">${t(`${KEY}.dashboard.none`)}</p>`,
    params.onRetry,
  );
}
