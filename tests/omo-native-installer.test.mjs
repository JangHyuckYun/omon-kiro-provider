import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  patchEngineSource,
  validatePatchedSource,
} from "../scripts/patch-omo-native.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function pristineFixtureSource() {
  return [
    "function resolveEffectiveReserveTokens(_contextWindow, settings) { return settings.reserveTokens; }",
    "function shouldCompact(tokens, contextWindow, settings) { return tokens > contextWindow - settings.reserveTokens; }",
    "",
    "class AgentSession {",
    "    constructor(model) { this.model = model; }",
    "    check(model, settings, compactionSettings, contextTokens, contentTokens) {",
    "        const contextUsage = { tokens: contextTokens, contextWindow: model.contextWindow };",
    "        const contextWindow = model.contextWindow;",
    "        const staleUsageContentTokens = contentTokens;",
    "        return [",
    "            shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings),",
    "            shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings),",
    "            shouldCompact(contentTokens, model.contextWindow, settings),",
    "            shouldCompact(contextTokens, model.contextWindow, settings),",
    "            shouldCompact(contextTokens, model.contextWindow, settings),",
    "            shouldCompact(contextTokens, model.contextWindow, settings),",
    "            shouldCompact(contextTokens, model.contextWindow, settings),",
    "            shouldCompact(staleUsageContentTokens, contextWindow, settings),",
    "            shouldCompact(contextTokens, contextWindow, settings),",
    "            shouldCompact(contextTokens, model.contextWindow, compactionSettings),",
    "        ];",
    "    }",
    "    getContextUsage() {",
    "        const model = this.model;",
    "        return { contextWindow: model.contextWindow };",
    "    }",
    "}",
    "const hardOverflowContract = 'isContextOverflow(message, model.contextWindow)';",
    "export { AgentSession, hardOverflowContract };",
    "",
  ].join("\n");
}

test("engine transformation is exact, idempotent, and preserves hard overflow", async () => {
  const pristine = pristineFixtureSource();
  const first = patchEngineSource(pristine, {
    pristineSha256: sha256(pristine),
  });
  assert.equal(first.status, "patched");
  validatePatchedSource(first.source);
  assert.match(first.source, /isContextOverflow\(message, model\.contextWindow\)/);

  const second = patchEngineSource(first.source, {
    pristineSha256: sha256(pristine),
    patchedSha256: sha256(first.source),
  });
  assert.equal(second.status, "already-patched");
  assert.equal(second.source, first.source);

  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-engine-"));
  try {
    const modulePath = join(fixtureDir, "agent-session.mjs");
    writeFileSync(modulePath, first.source, "utf8");
    const engine = await import(`${pathToFileURL(modulePath).href}?fixture=${Date.now()}`);
    const settings = { enabled: true, reserveTokens: 16_384 };

    const million = { contextWindow: 1_000_000, compactionTriggerRatio: 0.8 };
    const millionSession = new engine.AgentSession(million);
    assert.deepEqual(
      millionSession.check(million, settings, settings, 799_999, 799_999),
      Array(10).fill(false),
    );
    assert.deepEqual(
      millionSession.check(million, settings, settings, 800_000, 800_000),
      Array(10).fill(true),
    );

    const scaled = { contextWindow: 64_000, compactionTriggerRatio: 0.8 };
    const scaledSession = new engine.AgentSession(scaled);
    assert.deepEqual(
      scaledSession.check(scaled, settings, settings, 51_199, 51_199),
      Array(10).fill(false),
    );
    assert.deepEqual(
      scaledSession.check(scaled, settings, settings, 51_200, 51_200),
      Array(10).fill(true),
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("engine transformation rejects unknown or partially patched input", () => {
  const pristine = pristineFixtureSource();
  const unknown = pristine.replace("getContextUsage()", "getContextUsageRenamed()");
  assert.throws(
    () => patchEngineSource(unknown, { pristineSha256: sha256(unknown) }),
    /compaction helper anchor/,
  );

  const partial = pristine.replace(
    "shouldCompact(contentTokens, model.contextWindow, settings)",
    "shouldCompact(contentTokens, this._compactionThresholdWindow(model, settings), settings)",
  );
  assert.throws(
    () => patchEngineSource(partial, { pristineSha256: sha256(partial) }),
    /content estimate threshold/,
  );
});
