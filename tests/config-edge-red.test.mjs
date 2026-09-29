import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const buildDir = process.env.PI_KIRO_PROVIDER_BUILD_DIR;
if (!buildDir) throw new Error("PI_KIRO_PROVIDER_BUILD_DIR is required.");

const fromBuild = (path) => pathToFileURL(join(buildDir, path)).href;
const { loadConfig } = await import(fromBuild("src/config.js"));

function writeConfig(raw) {
  const dir = mkdtempSync(join(tmpdir(), "pi-kiro-provider-config-edge-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(raw), "utf-8");
  return dir;
}

test("loadConfig ignores negative model cost values instead of producing negative usage pricing metadata", () => {
  const { config } = loadConfig(writeConfig({
    models: [{
      id: "edge-model",
      name: "Edge Model",
      cost: { input: -1, output: -2, cacheRead: -3, cacheWrite: -4 },
    }],
  }));

  assert.deepEqual(config.models[0].cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("loadConfig drops cache checkpoint limits when prompt caching is explicitly disabled", () => {
  const { config } = loadConfig(writeConfig({
    models: [{
      id: "no-cache-model",
      name: "No Cache Model",
      promptCaching: {
        supportsPromptCaching: false,
        maximumCacheCheckpointsPerRequest: 4,
        minimumTokensPerCacheCheckpoint: 1024,
      },
    }],
  }));

  assert.deepEqual(config.models[0].promptCaching, { supportsPromptCaching: false });
});

test("loadConfig bounds the transient Kiro rate-limit retry policy", () => {
  const defaults = loadConfig(writeConfig({})).config;
  assert.equal(defaults.rateLimitMaxRetries, 3);
  assert.equal(defaults.rateLimitRetryBaseMs, 30_000);
  assert.equal(defaults.rateLimitRetryMaxMs, 120_000);

  const { config } = loadConfig(writeConfig({
    rateLimitMaxRetries: -1,
    rateLimitRetryBaseMs: 200_000,
    rateLimitRetryMaxMs: 1_000,
  }));
  assert.equal(config.rateLimitMaxRetries, 3);
  assert.equal(config.rateLimitRetryBaseMs, 200_000);
  assert.equal(config.rateLimitRetryMaxMs, 200_000);
});
