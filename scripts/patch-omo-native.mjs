#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(scriptDir);
const profilePath = join(packageRoot, "compat", "omo-native-5.1.json");
const profile = JSON.parse(readFileSync(profilePath, "utf8"));

const args = new Set(process.argv.slice(2));
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const silent = args.has("--silent");
const optional = args.has("--apply-if-present");
const mode = args.has("--check") ? "check" : args.has("--restore") ? "restore" : "apply";
const info = (message) => {
  if (!silent) process.stdout.write(`${message}\n`);
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function replaceExact(text, from, to, expected, label) {
  const count = occurrences(text, from);
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected} occurrence(s), found ${count}.`);
  }
  return text.split(from).join(to);
}

function replaceFirstExact(text, from, to, expectedBefore, label) {
  const count = occurrences(text, from);
  if (count !== expectedBefore) {
    throw new Error(`${label}: expected ${expectedBefore} remaining occurrence(s), found ${count}.`);
  }
  return text.replace(from, to);
}

const thresholdHelper = [
  "    _compactionThresholdWindow(model, settings) {",
  "        const native = model?.contextWindow ?? 0;",
  "        if (native <= 0) return 0;",
  "        const ratio = model?.compactionTriggerRatio;",
  "        if (typeof ratio === \"number\" && ratio > 0 && ratio <= 1) {",
  "            const triggerTokens = Math.floor(native * ratio);",
  "            let thresholdWindow = Math.max(1, triggerTokens - 1);",
  "            for (let iteration = 0; iteration < 8; iteration += 1) {",
  "                const next = triggerTokens - 1 + resolveEffectiveReserveTokens(thresholdWindow, settings);",
  "                if (next === thresholdWindow) break;",
  "                thresholdWindow = next;",
  "            }",
  "            return thresholdWindow;",
  "        }",
  "        const override = model?.compactionContextWindow;",
  "        return typeof override === \"number\" && override > 0 ? Math.min(override, native) : native;",
  "    }",
  "",
].join("\n");

export function patchEngineSource(source, compatibilityProfile = profile) {
  const inputHash = sha256(source);
  if (compatibilityProfile.patchedSha256 && inputHash === compatibilityProfile.patchedSha256) {
    validatePatchedSource(source);
    return { status: "already-patched", source };
  }
  if (inputHash !== compatibilityProfile.pristineSha256) {
    throw new Error(
      `Unsupported engine fingerprint ${inputHash}; expected pristine ${compatibilityProfile.pristineSha256}` +
      `${compatibilityProfile.patchedSha256 ? ` or patched ${compatibilityProfile.patchedSha256}` : ""}.`,
    );
  }

  const helperAnchor = "    getContextUsage() {\n        const model = this.model;";
  let output = replaceExact(
    source,
    helperAnchor,
    `${thresholdHelper}${helperAnchor}`,
    1,
    "compaction helper anchor",
  );

  const usageOriginal = "shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings)";
  output = replaceFirstExact(
    output,
    usageOriginal,
    "shouldCompact(contextUsage.tokens, this._compactionThresholdWindow(model, settings), settings)",
    2,
    "model usage threshold",
  );
  output = replaceFirstExact(
    output,
    usageOriginal,
    "shouldCompact(contextUsage.tokens, this._compactionThresholdWindow(this.model, settings), settings)",
    1,
    "session usage threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contentTokens, model.contextWindow, settings)",
    "shouldCompact(contentTokens, this._compactionThresholdWindow(model, settings), settings)",
    1,
    "content estimate threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextTokens, model.contextWindow, settings)",
    "shouldCompact(contextTokens, this._compactionThresholdWindow(model, settings), settings)",
    4,
    "model context threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(staleUsageContentTokens, contextWindow, settings)",
    "shouldCompact(staleUsageContentTokens, this._compactionThresholdWindow(this.model, settings), settings)",
    1,
    "stale usage threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextTokens, contextWindow, settings)",
    "shouldCompact(contextTokens, this._compactionThresholdWindow(this.model, settings), settings)",
    1,
    "session context threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextTokens, model.contextWindow, compactionSettings)",
    "shouldCompact(contextTokens, this._compactionThresholdWindow(model, compactionSettings), compactionSettings)",
    1,
    "summary context threshold",
  );

  validatePatchedSource(output);
  const outputHash = sha256(output);
  if (compatibilityProfile.patchedSha256 && outputHash !== compatibilityProfile.patchedSha256) {
    throw new Error(`Patched output fingerprint ${outputHash} does not match reviewed ${compatibilityProfile.patchedSha256}.`);
  }
  return { status: "patched", source: output };
}

export function validatePatchedSource(source) {
  if (occurrences(source, "_compactionThresholdWindow(model, settings) {") !== 1) {
    throw new Error("Patched engine must contain exactly one compaction threshold helper.");
  }
  if (occurrences(source, "isContextOverflow(message, model.contextWindow)") !== 1) {
    throw new Error("Patched engine must preserve the real hard-overflow context window.");
  }
  if (occurrences(source, "this._compactionThresholdWindow(") !== 10) {
    throw new Error("Patched engine must route exactly ten proactive checks through the ratio-aware helper.");
  }
}

export function restorePristineSource(source) {
  const inputHash = sha256(source);
  if (inputHash !== profile.patchedSha256) {
    throw new Error(`Cannot derive pristine engine from unsupported patched fingerprint ${inputHash}.`);
  }
  validatePatchedSource(source);

  const helperStart = "    _compactionThresholdWindow(model, settings) {";
  const helperEnd = "    getContextUsage() {";
  const startIndex = source.indexOf(helperStart);
  const endIndex = source.indexOf(helperEnd, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error("Cannot locate the reviewed compaction helper bounds.");
  let output = source.slice(0, startIndex) + source.slice(endIndex);

  output = replaceExact(
    output,
    "shouldCompact(contextUsage.tokens, this._compactionThresholdWindow(model, settings), settings)",
    "shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings)",
    1,
    "restore model usage threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextUsage.tokens, this._compactionThresholdWindow(this.model, settings), settings)",
    "shouldCompact(contextUsage.tokens, contextUsage.contextWindow, settings)",
    1,
    "restore session usage threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contentTokens, this._compactionThresholdWindow(model, settings), settings)",
    "shouldCompact(contentTokens, model.contextWindow, settings)",
    1,
    "restore content estimate threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextTokens, this._compactionThresholdWindow(model, settings), settings)",
    "shouldCompact(contextTokens, model.contextWindow, settings)",
    4,
    "restore model context threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(staleUsageContentTokens, this._compactionThresholdWindow(this.model, settings), settings)",
    "shouldCompact(staleUsageContentTokens, contextWindow, settings)",
    1,
    "restore stale usage threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextTokens, this._compactionThresholdWindow(this.model, settings), settings)",
    "shouldCompact(contextTokens, contextWindow, settings)",
    1,
    "restore session context threshold",
  );
  output = replaceExact(
    output,
    "shouldCompact(contextTokens, this._compactionThresholdWindow(model, compactionSettings), compactionSettings)",
    "shouldCompact(contextTokens, model.contextWindow, compactionSettings)",
    1,
    "restore summary context threshold",
  );
  const outputHash = sha256(output);
  if (outputHash !== profile.pristineSha256) {
    throw new Error(`Restored pristine fingerprint ${outputHash} does not match reviewed ${profile.pristineSha256}.`);
  }
  return output;
}

function executableNames() {
  if (process.platform !== "win32") return ["omo"];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT")
    .split(";")
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());
  return ["omo", ...extensions.map((extension) => `omo${extension}`)];
}

function findOmoExecutables() {
  const output = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames()) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) output.push(candidate);
    }
  }
  return output;
}

function engineCandidatesFromExecutable(executable) {
  const candidates = [];
  const paths = new Set([resolve(executable)]);
  try {
    paths.add(realpathSync(executable));
  } catch {
    // The original path is still useful for Bun's non-symlink shim layout.
  }
  for (const path of paths) {
    const normalized = path.split(sep).join("/");
    if (normalized.includes("/.omo/bin/omo")) continue;
    const root = dirname(dirname(path));
    candidates.push(join(root, "install", "global", "node_modules", "omo-ai", profile.engineRelativePath));
    candidates.push(join(root, "node_modules", "omo-ai", profile.engineRelativePath));
    const marker = `${sep}node_modules${sep}omo-ai${sep}`;
    const index = path.lastIndexOf(marker);
    if (index >= 0) {
      const omoRoot = path.slice(0, index + marker.length - 1);
      candidates.push(join(omoRoot, profile.engineRelativePath));
    }
  }
  return candidates;
}

export function findEnginePath(explicitPath) {
  const explicit = explicitPath ?? process.env.PI_KIRO_SENPI_AGENT_SESSION;
  if (explicit) {
    const resolved = resolve(explicit);
    if (!existsSync(resolved)) throw new Error(`Explicit senpi engine path does not exist: ${resolved}`);
    return resolved;
  }
  const candidates = new Set();
  for (const executable of findOmoExecutables()) {
    for (const candidate of engineCandidatesFromExecutable(executable)) {
      if (existsSync(candidate)) candidates.add(realpathSync(candidate));
    }
  }
  if (candidates.size === 0) return undefined;
  if (candidates.size > 1) {
    throw new Error(
      `Multiple OMO Native engines found; set PI_KIRO_SENPI_AGENT_SESSION explicitly:\n${[...candidates].join("\n")}`,
    );
  }
  return [...candidates][0];
}

function packageInfoForEngine(enginePath) {
  const senpiRoot = resolve(dirname(enginePath), "../..");
  const omoRoot = resolve(senpiRoot, "../../..");
  const senpiPackage = JSON.parse(readFileSync(join(senpiRoot, "package.json"), "utf8"));
  const omoPackage = JSON.parse(readFileSync(join(omoRoot, "package.json"), "utf8"));
  if (senpiPackage.name !== "@code-yeongyu/senpi" || omoPackage.name !== "omo-ai") {
    throw new Error(`Engine package identity mismatch at ${enginePath}.`);
  }
  if (senpiPackage.version !== profile.senpiVersion || omoPackage.version !== profile.omoVersion) {
    throw new Error(
      `Unsupported OMO Native engine: omo-ai ${omoPackage.version}, senpi ${senpiPackage.version}; ` +
      `supported: omo-ai ${profile.omoVersion}, senpi ${profile.senpiVersion}.`,
    );
  }
  return { senpiRoot, omoRoot, senpiPackage, omoPackage };
}

function adjacentPaths(enginePath) {
  return {
    backup: `${enginePath}.pi-kiro-provider.backup`,
    receipt: `${enginePath}.pi-kiro-provider.receipt.json`,
    lock: `${enginePath}.pi-kiro-provider.lock`,
    temporary: `${enginePath}.pi-kiro-provider.tmp-${process.pid}.js`,
  };
}

function writeAtomic(path, content, mode) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function acquireLock(lockPath) {
  const descriptor = openSync(lockPath, "wx");
  return () => {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  };
}

export function checkEngine(enginePath) {
  const packageInfo = packageInfoForEngine(enginePath);
  const source = readFileSync(enginePath, "utf8");
  const fingerprint = sha256(source);
  if (fingerprint !== profile.patchedSha256) {
    throw new Error(`OMO Native engine is not patched: ${fingerprint}. Run npm run setup:native and restart OMO.`);
  }
  validatePatchedSource(source);
  return { enginePath, fingerprint, ...packageInfo };
}

export function applyEnginePatch(enginePath) {
  const packageInfo = packageInfoForEngine(enginePath);
  const paths = adjacentPaths(enginePath);
  const release = acquireLock(paths.lock);
  try {
    const source = readFileSync(enginePath, "utf8");
    const result = patchEngineSource(source);
    if (result.status === "already-patched") {
      return { status: result.status, enginePath, fingerprint: profile.patchedSha256, ...packageInfo };
    }

    const originalHash = sha256(source);
    if (existsSync(paths.backup) || existsSync(paths.receipt)) {
      throw new Error(`Refusing to overwrite an existing backup or receipt beside ${enginePath}.`);
    }
    const mode = statSync(enginePath).mode;
    writeFileSync(paths.backup, source, { encoding: "utf8", mode, flag: "wx" });
    if (sha256(readFileSync(enginePath, "utf8")) !== originalHash) {
      throw new Error("Engine changed while preparing the patch; no replacement was performed.");
    }
    writeFileSync(paths.temporary, result.source, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(paths.temporary, mode);
    execFileSync(process.execPath, ["--check", paths.temporary], { stdio: "pipe" });
    renameSync(paths.temporary, enginePath);
    const receipt = {
      schemaVersion: 1,
      patchId: profile.patchId,
      enginePath,
      backupPath: paths.backup,
      omoVersion: packageInfo.omoPackage.version,
      senpiVersion: packageInfo.senpiPackage.version,
      originalSha256: originalHash,
      patchedSha256: sha256(result.source),
      appliedAt: new Date().toISOString(),
    };
    writeAtomic(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
    return { status: "patched", enginePath, fingerprint: receipt.patchedSha256, ...packageInfo };
  } finally {
    rmSync(paths.temporary, { force: true });
    release();
  }
}

export function restoreEngine(enginePath) {
  packageInfoForEngine(enginePath);
  const paths = adjacentPaths(enginePath);
  const release = acquireLock(paths.lock);
  try {
    if (!existsSync(paths.backup) || !existsSync(paths.receipt)) {
      throw new Error(`No rollback backup and receipt exist beside ${enginePath}.`);
    }
    const receipt = JSON.parse(readFileSync(paths.receipt, "utf8"));
    const current = readFileSync(enginePath, "utf8");
    const backup = readFileSync(paths.backup, "utf8");
    if (receipt.patchId !== profile.patchId) throw new Error("Rollback receipt belongs to another patch revision.");
    if (sha256(current) !== receipt.patchedSha256) {
      throw new Error("Current engine differs from the recorded patched bytes; refusing rollback.");
    }
    if (sha256(backup) !== receipt.originalSha256) {
      throw new Error("Rollback backup differs from the recorded original bytes; refusing rollback.");
    }
    const mode = statSync(enginePath).mode;
    writeAtomic(enginePath, backup, mode);
    rmSync(paths.backup);
    rmSync(paths.receipt);
    return { status: "restored", enginePath, fingerprint: sha256(backup) };
  } finally {
    release();
  }
}

export function runCli() {
  const enginePath = findEnginePath(argumentValue("--engine-path"));
  if (!enginePath) {
    if (optional) {
      info("[omon-kiro-provider] OMO Native engine not found; skipped optional integration patch.");
      return;
    }
    throw new Error("OMO Native engine not found. Install omo-ai or set PI_KIRO_SENPI_AGENT_SESSION.");
  }
  const result = mode === "check"
    ? { status: "verified", ...checkEngine(enginePath) }
    : mode === "restore"
      ? restoreEngine(enginePath)
      : applyEnginePatch(enginePath);
  info(`[omon-kiro-provider] ${result.status}: ${result.enginePath}`);
  if (result.status === "patched" || result.status === "restored") {
    info("[omon-kiro-provider] Restart every running OMO process before using Kiro.");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`[omon-kiro-provider] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
