#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.env.PI_KIRO_SKIP_OMO_NATIVE_PATCH !== "1") {
  runNode(join(root, "scripts", "patch-omo-native.mjs"), ["--apply-if-present", "--silent"]);
}

// Preserve the upstream Pi-extension vulnerable-dependency hook when installed
// directly under ~/.pi/agent/extensions.
const normalizedRoot = root.split(sep).join("/");
if (normalizedRoot.includes("/.pi/agent/extensions/")) {
  const legacyPatcher = resolve(root, "../../scripts/patch-vulnerable-deps.mjs");
  if (existsSync(legacyPatcher)) {
    runNode(legacyPatcher, ["--target", root, "--quiet"]);
  }
}
