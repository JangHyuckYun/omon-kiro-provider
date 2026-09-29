import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = mkdtempSync(join(tmpdir(), "omon-kiro-provider-test-"));
const tscPath = join(root, "node_modules", "typescript", "bin", "tsc");

let exitCode = 0;

try {
  const compile = spawnSync(process.execPath, [tscPath, "--outDir", buildDir, "--noEmit", "false"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env },
  });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) {
    exitCode = compile.status ?? 1;
  } else {
    writeFileSync(join(buildDir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const nodeModulesPath = join(root, "node_modules");
    if (existsSync(nodeModulesPath)) symlinkSync(nodeModulesPath, join(buildDir, "node_modules"), "junction");
    const test = spawnSync(process.execPath, ["--test", "tests/*.test.mjs"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, PI_KIRO_PROVIDER_BUILD_DIR: buildDir },
    });
    if (test.error) throw test.error;
    exitCode = test.status ?? 1;
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

process.exit(exitCode);
