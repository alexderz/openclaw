import { describe, expect, it } from "vitest";
import { CliSessionHistoryIndex } from "./cli-session-history-index.worker.js";

const meta = (id: string) => ({ importedFrom: "claude-cli", cliSessionId: "session-1", externalId: id, id });
const imported = (role: string, content: string, timestamp: number, id: string) =>
  ({ role, content, timestamp, __openclaw: meta(id) });

function runIndex(ambiguous: boolean, foreignPrompt = false) {
  const index = new CliSessionHistoryIndex(true, "session-1");
  const local = [
    { role: "user", content: "prompt", timestamp: 1000 },
    { role: "assistant", provider: "claude-cli", api: "cli", content: "a b", timestamp: 1250 },
    { role: "assistant", content: "ordinary", timestamp: 1300 },
  ];
  index.appendLocal(local.map((message, i) => ({ message, seq: i + 1 })));
  index.appendImported({ ...imported("user", "prompt", 1000, "user"), __openclaw: { ...meta("user"), cliSessionId: foreignPrompt ? "foreign" : "session-1" } });
  index.appendImported(imported("assistant", "a", 1100, "a1"));
  if (ambiguous) { index.appendImported(imported("assistant", "a", 1150, "a2")); }
  index.appendImported(imported("assistant", "b", 1200, "b"));
  index.finish(true);
  const all = Array.from({ length: index.count }, (_, i) => {
    const row = index.rows(i, i + 1)[0]!;
    return row.local_seq === null ? index.message(row.id) : local[row.local_seq - 1];
  });
  const ordinals = index.rows(0, index.count).map((row) => row.ordinal);
  index.close();
  return { all, ordinals };
}

describe("composite retirement on the real history index", () => {
  it("retires before one-row pagination but preserves ordinary history", () => {
    const result = runIndex(false);
    expect(result.all.map((message) => (message as { content: string }).content)).toEqual(["prompt", "a", "b", "ordinary"]);
    expect(result.ordinals).toEqual([0, 1, 2, 3]);
  });
  it("keeps the composite when the native prompt declares a foreign session", () => {
    expect(runIndex(false, true).all.map((message) => (message as { content: string }).content)).toContain("a b");
  });
  it("fails open on an ambiguous chain", () => {
    const result = runIndex(true);
    expect(result.all.map((message) => (message as { content: string }).content)).toEqual(["prompt", "a", "a", "b", "a b", "ordinary"]);
    expect(result.ordinals).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

it("maps a retired local ID and sequence only to its last visible native segment", () => {
  const index = new CliSessionHistoryIndex(true, "session-1");
  try {
    index.appendLocal([
      { seq: 1, message: { role: "user", content: "prompt", timestamp: 1000, __openclaw: { id: "prompt" } } },
      { seq: 2, message: { role: "assistant", provider: "claude-cli", api: "cli", content: "a b", timestamp: 1250, __openclaw: { id: "retired" } } },
    ]);
    index.appendImported(imported("user", "prompt", 1000, "user"));
    index.appendImported({ ...imported("assistant", "a", 1100, "a"), __openclaw: { ...meta("a"), id: "a" } });
    index.appendImported({ ...imported("assistant", "b", 1200, "b"), __openclaw: { ...meta("b"), id: "b" } });
    index.finish(true);
    const location = index.lookupDisplayLocation("retired");
    expect(location).toMatchObject({ kind: "retired-composite", localSeq: 2 });
    if (location?.kind !== "retired-composite") { throw new Error("missing alias"); }
    expect(index.localOrdinal(2)).toBe(location.ordinal);
    expect(index.message(location.targetRowId)).toMatchObject({ content: "b", __openclaw: { id: "b" } });
    expect(index.lookupDisplayLocation("unknown")).toBeUndefined();
  } finally { index.close(); }
});

it("keeps the local row when its message ID collides with a visible native row", () => {
  const index = new CliSessionHistoryIndex(true, "session-1");
  try {
    index.appendLocal([
      { seq: 1, message: { role: "user", content: "prompt", timestamp: 1000 } },
      { seq: 2, message: { role: "assistant", provider: "claude-cli", api: "cli", content: "a b", timestamp: 1250, __openclaw: { id: "collision" } } },
    ]);
    index.appendImported(imported("user", "prompt", 1000, "user"));
    index.appendImported(imported("assistant", "a", 1100, "a"));
    index.appendImported({ ...imported("assistant", "b", 1200, "b"), __openclaw: { ...meta("b"), id: "collision" } });
    index.finish(true);
    expect(index.hasCompositeRetirements).toBe(false);
    expect(index.localOrdinal(2)).toBeDefined();
  } finally { index.close(); }
});

function inspectComposite(local: unknown[], native: unknown[]) {
  const index = new CliSessionHistoryIndex(true, "session-1");
  try {
    index.appendLocal(local.map((message, i) => ({ message, seq: i + 1 })));
    native.forEach((message) => index.appendImported(message));
    index.finish(true);
    return {
      rows: index.rows(0, index.count).map((row) => row.local_seq === null ? index.message(row.id) : local[row.local_seq - 1]),
      aliases: local.map((_, i) => index.localOrdinal(i + 1)),
      locations: ["join1", "join2"].map((id) => index.lookupDisplayLocation(id)),
      count: index.count,
    };
  } finally { index.close(); }
}
const prompt = { role: "user", content: "prompt", timestamp: 1000 };
const join = (id: string, content = "a b") => ({ role: "assistant", provider: "claude-cli", api: "cli", content, timestamp: 2_761_000, __openclaw: { id } });
const nativePrompt = imported("user", "prompt", 1000, "prompt-native");
const nativeA = imported("assistant", "a", 2000, "a");
const nativeB = imported("assistant", "b", 2_760_000, "b");

it("keeps narration and internal tool results across a 46-minute native turn", () => {
  const narration = imported("assistant", "thinking", 10_000, "narration");
  const tool = { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }], timestamp: 20_000, __openclaw: meta("tool") };
  const notification = { role: "user", content: "internal notification", timestamp: 30_000,
    provenance: { kind: "internal_system" }, __openclaw: meta("notification") };
  const result = inspectComposite([prompt, join("join1")], [nativePrompt, nativeA, narration, tool, notification, nativeB]);
  expect(result.locations[0]).toMatchObject({ kind: "retired-composite" });
  expect(result.rows).toContainEqual(narration);
  expect(result.rows).toContainEqual(tool);
  expect(result.rows).toContainEqual(notification);
  expect(result.rows).not.toContainEqual(join("join1"));
  expect(result.rows).toContainEqual(nativeA);
  expect(result.rows).toContainEqual(nativeB);
});

it.each([
  ["text", { role: "user", content: "later", timestamp: 15_000, __openclaw: meta("later") }],
  ["image-only", { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aA==" } }], timestamp: 15_000, __openclaw: meta("later") }],
])("does not join across a later %s operator turn", (_name, boundary) => {
  const result = inspectComposite([prompt, join("join1")], [nativePrompt, nativeA, boundary, nativeB]);
  expect(result.rows).toContainEqual(join("join1"));
  expect(result.locations[0]).not.toMatchObject({ kind: "retired-composite" });
  expect(result.rows).toContainEqual(boundary);
});

it("does not allow two local joins to claim the same imported segments", () => {
  const first = join("join1");
  const second = { ...join("join2"), timestamp: 2_761_001 };
  const result = inspectComposite([prompt, first, second], [nativePrompt, nativeA, nativeB]);
  expect(result.locations[0]).toMatchObject({ kind: "retired-composite" });
  expect(result.locations[1]).not.toMatchObject({ kind: "retired-composite" });
  expect(result.rows).toContainEqual(second);
  expect(result.rows).toContainEqual(nativeA);
  expect(result.rows).toContainEqual(nativeB);
});

it.each([
  ["extra local text", join("join1", "extra a b")],
  ["media marker", join("join1", "a b\nMEDIA: /tmp/thing")],
  ["persisted media", { ...join("join1"), __openclaw: { id: "join1", media: [{ url: "media://photo", contentType: "image/png" }] } }],
  ["unknown block", { ...join("join1"), content: [{ type: "tool_use", text: "a b" }] }],
  ["ordinary assistant", { role: "assistant", content: "a b", timestamp: 2_761_000, __openclaw: { id: "join1" } }],
  ["foreign CLI", { ...join("join1"), __openclaw: { id: "join1", cliSessionId: "foreign" } }],
  ["missing timestamp", { ...join("join1"), timestamp: undefined }],
])("preserves unsupported %s local row and native rows", (_name, candidate) => {
  const result = inspectComposite([prompt, candidate], [nativePrompt, nativeA, nativeB]);
  expect(result.rows).toContainEqual(candidate);
  expect(result.rows).toContainEqual(nativeA);
  expect(result.rows).toContainEqual(nativeB);
  expect(result.locations[0]).not.toMatchObject({ kind: "retired-composite" });
});

it.each([[31, true], [32, false]])("handles %i extra endings at the 33-row sentinel", (extra, shouldRetire) => {
  const noise = Array.from({ length: extra }, (_, i) => imported("assistant", `noise-${i}`, 2_760_000, `noise-${i}`));
  const candidate = join("join1");
  const result = inspectComposite([prompt, candidate], [nativePrompt, nativeA, ...noise, nativeB]);
  expect(result.rows.includes(candidate)).toBe(!shouldRetire);
  expect(result.count).toBe(noise.length + 3 + (shouldRetire ? 0 : 1));
  expect(result.locations[0]?.kind === "retired-composite").toBe(shouldRetire);
});

it.each([[253, true], [254, false]])("handles %i internal rows at the raw-row boundary", (number, shouldRetire) => {
  const tools = Array.from({ length: number }, (_, i) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: "ok" }], timestamp: 5000 + i, __openclaw: meta(`tool-${i}`) }));
  const candidate = join("join1");
  const result = inspectComposite([prompt, candidate], [nativePrompt, nativeA, ...tools, nativeB]);
  expect(result.rows.includes(candidate)).toBe(!shouldRetire);
  expect(result.locations[0]?.kind === "retired-composite").toBe(shouldRetire);
  expect(result.rows).toContainEqual(nativeA);
  expect(result.rows).toContainEqual(nativeB);
  expect(result.count).toBe(number + 3 + (shouldRetire ? 0 : 1));
});

it.each([[32, true], [33, false]])("handles a %i-segment proof without partial retirement", (count, shouldRetire) => {
  const words = Array.from({ length: count }, (_, i) => `segment${i}`);
  const candidate = join("join1", words.join(" "));
  const segments = words.map((word, i) => imported("assistant", word, i === count - 1 ? 2_760_000 : 2_000 + i, `segment-${i}`));
  const result = inspectComposite([prompt, candidate], [nativePrompt, ...segments]);
  expect(result.rows.includes(candidate)).toBe(!shouldRetire);
  expect(result.locations[0]?.kind === "retired-composite").toBe(shouldRetire);
  expect(result.count).toBe(count + 1 + (shouldRetire ? 0 : 1));
  for (const segment of segments) { expect(result.rows).toContainEqual(segment); }
});

it.each([[262144, true], [262145, false]])("handles %i imported proof bytes without dropping rows", (budget, shouldRetire) => {
  const emptyNoise = imported("assistant", "", 5000, "noise");
  const overhead = Buffer.byteLength(JSON.stringify(emptyNoise)) + Buffer.byteLength(JSON.stringify(nativeA)) + Buffer.byteLength(JSON.stringify(nativeB));
  const noise = { ...emptyNoise, content: "x".repeat(budget - overhead) };
  const candidate = join("join1");
  const result = inspectComposite([prompt, candidate], [nativePrompt, nativeA, noise, nativeB]);
  expect(result.rows.includes(candidate)).toBe(!shouldRetire);
  expect(result.locations[0]?.kind === "retired-composite").toBe(shouldRetire);
  expect(result.rows).toContainEqual(noise);
  expect(result.rows).toContainEqual(nativeA);
  expect(result.rows).toContainEqual(nativeB);
});

it.each([[65536, true], [65537, false]])("handles %i local bytes without partial aliasing", (bytes, shouldRetire) => {
  const overhead = Buffer.byteLength(JSON.stringify(join("join1", " b")));
  const text = "x".repeat(bytes - overhead);
  const candidate = join("join1", `${text} b`);
  expect(Buffer.byteLength(JSON.stringify(candidate))).toBe(bytes);
  const first = imported("assistant", text, 2000, "long-a");
  const result = inspectComposite([prompt, candidate], [nativePrompt, first, nativeB]);
  expect(result.rows.includes(candidate)).toBe(!shouldRetire);
  expect(result.locations[0]?.kind === "retired-composite").toBe(shouldRetire);
  expect(result.rows).toContainEqual(first);
  expect(result.rows).toContainEqual(nativeB);
});

it.each([[10, true], [20, false]])("handles a %i-repetition proof at the state-work budget", (count, shouldRetire) => {
  const candidate = join("join1", `${Array(count).fill("a").join(" ")} b`);
  const segments = Array.from({ length: count }, (_, i) => imported("assistant", "a", 2000 + i, `repeat-${i}`));
  const result = inspectComposite([prompt, candidate], [nativePrompt, ...segments, nativeB]);
  expect(result.rows.includes(candidate)).toBe(!shouldRetire);
  expect(result.locations[0]?.kind === "retired-composite").toBe(shouldRetire);
  expect(result.count).toBe(count + 2 + (shouldRetire ? 0 : 1));
});

it("keeps the 4097th candidate and all native segments after the global candidate budget", () => {
  const index = new CliSessionHistoryIndex(true, "session-1");
  try {
    const count = 4097;
    const local: { message: unknown; seq: number }[] = [];
    for (let i = 0; i < count; i++) {
      const timestamp = 1_000 + i * 700_000;
      local.push({ seq: 2 * i + 1, message: { role: "user", content: `prompt-${i}`, timestamp } });
      local.push({ seq: 2 * i + 2, message: { role: "assistant", provider: "claude-cli", api: "cli", content: `a-${i} b-${i}`, timestamp: timestamp + 2000, __openclaw: { id: `join-${i}` } } });
      index.appendImported(imported("user", `prompt-${i}`, timestamp, `prompt-${i}`));
      index.appendImported(imported("assistant", `a-${i}`, timestamp + 1000, `a-${i}`));
      index.appendImported(imported("assistant", `b-${i}`, timestamp + 1500, `b-${i}`));
    }
    index.appendLocal(local);
    index.finish(true);
    expect(index.lookupDisplayLocation("join-4095")).toMatchObject({ kind: "retired-composite" });
    expect(index.lookupDisplayLocation("join-4096")).not.toMatchObject({ kind: "retired-composite" });
    expect(index.count).toBe(3 * count + 1);
    expect(index.localOrdinal(8194)).toBeDefined();
  } finally { index.close(); }
}, 120_000);

it("preserves the candidate that exhausts the global query-work budget", () => {
  const index = new CliSessionHistoryIndex(true, "session-1");
  try {
    const count = 253;
    const local: { message: unknown; seq: number }[] = [];
    for (let i = 0; i < count; i++) {
      const timestamp = 1_000 + i * 700_000;
      local.push({ seq: 2 * i + 1, message: { role: "user", content: `p-${i}`, timestamp } });
      local.push({ seq: 2 * i + 2, message: { role: "assistant", provider: "claude-cli", api: "cli", content: `a-${i} b-${i}`, timestamp: timestamp + 2000, __openclaw: { id: `join-work-${i}` } } });
      index.appendImported(imported("user", `p-${i}`, timestamp, `p-${i}`));
      index.appendImported(imported("assistant", `a-${i}`, timestamp + 1000, `a-${i}`));
      for (let j = 0; j < 253; j++) {
        index.appendImported({ role: "user", content: [{ type: "tool_result", tool_use_id: `t-${i}-${j}`, content: "ok" }], timestamp: timestamp + 1100 + j, __openclaw: meta(`t-${i}-${j}`) });
      }
      index.appendImported(imported("assistant", `b-${i}`, timestamp + 1500, `b-${i}`));
    }
    index.appendLocal(local);
    index.finish(true);
    expect(index.lookupDisplayLocation("join-work-251")).toMatchObject({ kind: "retired-composite" });
    expect(index.lookupDisplayLocation("join-work-252")).not.toMatchObject({ kind: "retired-composite" });
    expect(index.count).toBe(256 * count + 1);
    expect(index.localOrdinal(506)).toBeDefined();
  } finally { index.close(); }
}, 120_000);

it("keeps a local join without a mapped operator prompt", () => {
  const candidate = join("join1");
  const result = inspectComposite([{ ...prompt, content: "different prompt" }, candidate], [nativePrompt, nativeA, nativeB]);
  expect(result.rows).toContainEqual(candidate);
  expect(result.locations[0]).not.toMatchObject({ kind: "retired-composite" });
  expect(result.rows).toContainEqual(nativeA);
  expect(result.rows).toContainEqual(nativeB);
});

it("does not borrow an earlier prompt chain for a later local turn", () => {
  const later = { role: "user", content: "later prompt", timestamp: 2_760_500 };
  const candidate = join("join1");
  const result = inspectComposite([prompt, later, candidate], [nativePrompt, nativeA, nativeB,
    imported("user", "later prompt", 2_760_500, "later")]);
  expect(result.rows).toContainEqual(candidate);
  expect(result.locations[0]).not.toMatchObject({ kind: "retired-composite" });
});

it("retains an ambiguous local join when two native endings are plausible", () => {
  const candidate = join("join1");
  const result = inspectComposite([prompt, candidate], [nativePrompt, nativeA, nativeB,
    imported("assistant", "a", 2_760_100, "a-again"), imported("assistant", "b", 2_760_200, "b-again")]);
  expect(result.rows).toContainEqual(candidate);
  expect(result.locations[0]).not.toMatchObject({ kind: "retired-composite" });
  expect(result.count).toBe(6);
});
