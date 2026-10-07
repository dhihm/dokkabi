import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachPiLoop } from "../src/plugins/loop-pi.ts";
import { containsSecretValue, newSecretValues, sessionSecretProvenance } from "../src/host/redact.ts";
import { inputDigest, liveProviderState } from "../src/host/provider-input.ts";
import { agentTranscriptPath, recordedAgentTranscript, saveAgentTranscript, synchronizeAgentTranscript } from "../src/host/agent-transcript.ts";
import { applyCompactionToTranscript } from "../src/host/compaction.ts";
import { finishCompactionTransaction } from "../src/host/compaction-transaction.ts";
import { providerFixture, completionResponse } from "./fixtures/provider-input-fixture.ts";

const options = { maxOutputTokens: 128, timeoutMs: 5000, streamIdleMs: 0 };
function fixture() {
  const generated = randomUUID().replaceAll("-", "");
  const f = providerFixture((_body, ordinal) => {
    if (ordinal !== 2) return completionResponse();
    const data = { id: "fixture", choices: [{ index: 0, delta: {
      role: "assistant", reasoning_content: `I generated a test assignment password=${generated}.`, content: "Synthetic fixture complete.",
    }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  return f;
}

test("Given provider-authored fixture thinking, cache persistence matches the log and a real Pi continuation resumes", async () => {
  const f = fixture(); let loop = attachPiLoop(f.ctx);
  try {
    await loop.prompt("First clean question", options);
    await loop.prompt("Generate a synthetic test fixture", options);
    const state = liveProviderState(f.log), provenance = sessionSecretProvenance(f.log.events);
    expect(containsSecretValue(state.messages)).toBe(true);
    expect(newSecretValues(state.messages, provenance.authored, provenance.observed)).toEqual([]);
    const cache = JSON.parse(readFileSync(agentTranscriptPath(f.log.path), "utf8"));
    expect(inputDigest(cache.messages)).toBe(inputDigest(state.messages));
    loop.dispose(); loop = attachPiLoop(f.resumedContext());
    await loop.prompt("Continue from the recorded result", options);
    expect(f.received).toHaveLength(3);
  } finally { loop.dispose(); f.close(); }
}, 15000);

test("Given retained authored thinking, compaction can keep its exact bytes without a false secret refusal", async () => {
  const f = fixture(), loop = attachPiLoop(f.ctx);
  try {
    await loop.prompt("First clean question", options);
    await loop.prompt("Generate a synthetic test fixture", options);
    const result = applyCompactionToTranscript({ log: f.log, transcriptPath: agentTranscriptPath(f.log.path),
      summary: "Retain the latest fixture evidence", keepMessages: 2, transcriptTokens: 800, tokenBudget: 400,
      messageTokens: [200, 200, 200, 200], roles: ["user", "assistant", "user", "assistant"],
    });
    expect(result.droppedMessages).toBeGreaterThan(0);
    const state = liveProviderState(f.log), cache = JSON.parse(readFileSync(agentTranscriptPath(f.log.path), "utf8"));
    expect(containsSecretValue(cache.messages)).toBe(true);
    expect(inputDigest(cache.messages)).toBe(inputDigest(state.pending!.messages));
    f.ctx.sealIfNeeded("compaction");
    finishCompactionTransaction(agentTranscriptPath(f.log.path));
    expect(inputDigest(cache.messages)).toBe(inputDigest(liveProviderState(f.log).messages));
  } finally { loop.dispose(); f.close(); }
}, 15000);

test("Given provenance-qualified history, cache-only inserted arguments cannot be saved with log authority", async () => {
  const f = fixture(), loop = attachPiLoop(f.ctx);
  try {
    await loop.prompt("First clean question", options);
    await loop.prompt("Generate a synthetic test fixture", options);
    const file = recordedAgentTranscript(f.log)!;
    file.messages = [...file.messages, { role: "user", content: "Unlogged insertion" }];
    const before = readFileSync(agentTranscriptPath(f.log.path), "utf8");
    expect(() => saveAgentTranscript(agentTranscriptPath(f.log.path), file, f.log)).toThrow("provider-input");
    expect(readFileSync(agentTranscriptPath(f.log.path), "utf8")).toBe(before);
  } finally { loop.dispose(); f.close(); }
}, 15000);

test("Given only a claimed fixture without durable provenance, legacy plaintext cache saving still refuses", async () => {
  const f = fixture(), loop = attachPiLoop(f.ctx);
  try {
    await loop.prompt("First clean question", options);
    await loop.prompt("Generate a synthetic test fixture", options);
    expect(saveAgentTranscript(join(f.root, "untrusted.json"), recordedAgentTranscript(f.log)!)).toBe(false);
  } finally { loop.dispose(); f.close(); }
}, 15000);

for (const tamper of [false, true]) {
  test(`Given an older ${tamper ? "tampered" : "authenticated"} cache, provenance-policy migration ${tamper ? "refuses" : "repairs and records"} it`, async () => {
    const f = fixture(), loop = attachPiLoop(f.ctx);
    try {
      await loop.prompt("First clean question", options);
      const path = agentTranscriptPath(f.log.path), before = JSON.parse(readFileSync(path, "utf8"));
      await loop.prompt("Generate a synthetic test fixture", options);
      if (tamper) before.messages[0].content[0].text = "Cache-only replacement";
      writeFileSync(path, JSON.stringify(before));
      if (tamper) {
        expect(() => synchronizeAgentTranscript(f.log)).toThrow("recorded ancestor");
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(before);
      } else {
        synchronizeAgentTranscript(f.log);
        const cache = JSON.parse(readFileSync(path, "utf8"));
        expect(inputDigest(cache.messages)).toBe(inputDigest(liveProviderState(f.log).messages));
        expect(f.log.events.find(e => e.name === "work/cache_recovered")?.payload).toMatchObject({ reason: "provenance_cache_repair", status: "completed" });
      }
    } finally { loop.dispose(); f.close(); }
  }, 15000);
}
