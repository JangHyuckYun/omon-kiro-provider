#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  findEnginePath,
  restorePristineSource,
} from "./patch-omo-native.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-kiro-provider-install-"));
const fixtureHome = join(fixtureRoot, "home");
const bunRoot = join(fixtureHome, ".bun");
const omoRoot = join(bunRoot, "install", "global", "node_modules", "omo-ai");
const senpiRoot = join(omoRoot, "node_modules", "@code-yeongyu", "senpi");
const enginePath = join(senpiRoot, "dist", "core", "agent-session.js");
const fakeBin = join(bunRoot, "bin");
const installRoot = join(fixtureRoot, "install");
const installedPackage = join(installRoot, "node_modules", "pi-kiro-provider");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

try {
  const activeEngine = findEnginePath();
  if (!activeEngine) throw new Error("A verified patched OMO Native engine is required to build the pristine fixture.");
  const pristineEngine = restorePristineSource(readFileSync(activeEngine, "utf8"));

  mkdirSync(dirname(enginePath), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(enginePath, pristineEngine, "utf8");
  writeFileSync(join(omoRoot, "package.json"), JSON.stringify({
    name: "omo-ai",
    version: "5.1.0",
  }), "utf8");
  writeFileSync(join(senpiRoot, "package.json"), JSON.stringify({
    name: "@code-yeongyu/senpi",
    version: "2026.9.28-7",
  }), "utf8");
  const fakeOmo = join(fakeBin, process.platform === "win32" ? "omo.cmd" : "omo");
  writeFileSync(
    fakeOmo,
    process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  if (process.platform !== "win32") chmodSync(fakeOmo, 0o755);

  writeFileSync(join(installRoot, "package.json"), JSON.stringify({
    name: "pi-kiro-provider-install-fixture",
    version: "1.0.0",
    private: true,
  }, null, 2), "utf8");

  const packResult = run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", fixtureRoot],
  );
  const packMetadata = JSON.parse(packResult.stdout);
  const tarballPath = join(fixtureRoot, packMetadata[0].filename);
  if (!existsSync(tarballPath)) throw new Error(`Packed artifact missing: ${tarballPath}`);

  const npmPath = process.platform === "win32"
    ? execFileSync("where", ["npm.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
    : execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
  const fixturePath = [
    fakeBin,
    dirname(process.execPath),
    dirname(npmPath),
    ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
  ].join(delimiter);
  const fixtureEnv = {
    ...process.env,
    HOME: fixtureHome,
    PATH: fixturePath,
    PI_KIRO_SKIP_OMO_NATIVE_PATCH: "",
    PI_KIRO_SENPI_AGENT_SESSION: "",
    npm_config_ignore_scripts: "false",
    npm_config_loglevel: "error",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };

  run(npmPath, ["install", "--save-exact", tarballPath], {
    cwd: installRoot,
    env: fixtureEnv,
  });

  for (const relativePath of [
    "src/kiro.ts",
    "scripts/patch-omo-native.mjs",
    "scripts/postinstall.mjs",
    "compat/omo-native-5.1.json",
    "docs/OMO_NATIVE_HARDENING.ko.md",
    "tests/native-compat.test.mjs",
  ]) {
    if (!existsSync(join(installedPackage, relativePath))) {
      throw new Error(`Packed install omitted ${relativePath}.`);
    }
  }

  const backupPath = `${enginePath}.pi-kiro-provider.backup`;
  const receiptPath = `${enginePath}.pi-kiro-provider.receipt.json`;
  if (!existsSync(backupPath) || !existsSync(receiptPath)) {
    throw new Error("Postinstall did not create the reviewed engine backup and receipt.");
  }

  const firstPatchedBytes = readFileSync(enginePath, "utf8");
  const firstMtime = statSync(enginePath).mtimeMs;
  run(npmPath, ["run", "check:native"], { cwd: installedPackage, env: fixtureEnv });
  run(npmPath, ["run", "setup:native"], { cwd: installedPackage, env: fixtureEnv });
  run(npmPath, ["run", "setup:native"], { cwd: installedPackage, env: fixtureEnv });
  if (readFileSync(enginePath, "utf8") !== firstPatchedBytes) {
    throw new Error("Idempotent setup changed already patched engine bytes.");
  }
  if (statSync(enginePath).mtimeMs !== firstMtime) {
    throw new Error("Idempotent setup changed already patched engine mtime.");
  }

  run(npmPath, ["run", "restore:native"], { cwd: installedPackage, env: fixtureEnv });
  if (readFileSync(enginePath, "utf8") !== pristineEngine) {
    throw new Error("Rollback did not restore exact pristine engine bytes.");
  }
  if (existsSync(backupPath) || existsSync(receiptPath)) {
    throw new Error("Rollback left backup or receipt artifacts behind.");
  }

  process.stdout.write("INSTALL_FIXTURE_OK\n");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
