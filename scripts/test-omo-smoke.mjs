#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = mkdtempSync(join(tmpdir(), "omon-kiro-provider-omo-"));
const agentRoot = join(fixtureRoot, "agent");
const npmRoot = join(agentRoot, "npm");
const installedPackage = join(npmRoot, "node_modules", "omon-kiro-provider");

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
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(join(npmRoot, "package.json"), JSON.stringify({
    name: "omon-kiro-provider-omo-smoke",
    version: "1.0.0",
    private: true,
  }, null, 2), "utf8");

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const pack = run(npmCommand, [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    fixtureRoot,
  ]);
  const tarball = join(fixtureRoot, JSON.parse(pack.stdout)[0].filename);
  if (!existsSync(tarball)) throw new Error(`Packed artifact missing: ${tarball}`);

  run(npmCommand, ["install", "--save-exact", tarball], {
    cwd: npmRoot,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_loglevel: "error",
    },
  });

  const omoCommand = process.platform === "win32" ? "omo.cmd" : "omo";
  const modelList = run(omoCommand, [
    "--extension",
    installedPackage,
    "--list-models",
    "kiro",
  ], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      OMO_CODING_AGENT_DIR: agentRoot,
      SENPI_CODING_AGENT_DIR: agentRoot,
    },
  });
  const matchingRows = modelList.stdout
    .split(/\r?\n/)
    .filter((line) => /^\s*kiro\s+claude-opus-5\.5\s+/.test(line));
  if (matchingRows.length !== 1) {
    throw new Error(`Expected exactly one Opus 5.5 row, found ${matchingRows.length}.\n${modelList.stdout}`);
  }
  if (!/\b1M\b/.test(matchingRows[0]) || !/\b128K\b/.test(matchingRows[0])) {
    throw new Error(`Opus 5.5 row has unexpected metadata: ${matchingRows[0]}`);
  }

  process.stdout.write(`${matchingRows[0]}\nOMO_SMOKE_OK\n`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
