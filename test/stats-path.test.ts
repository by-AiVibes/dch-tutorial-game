// CLI and server must resolve the same stats file: DCH_DATA_DIR/stats.json, or .data/stats.json if unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStats } from "../src/server.ts";
import { statsPath } from "../src/config.ts";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url)));
const CLI = join(ROOT, "src", "cli.ts");

function envWith(dataDir: string | undefined): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DCH_DATA_DIR;
  if (dataDir !== undefined) env.DCH_DATA_DIR = dataDir;
  return env;
}

function cliStats(env: NodeJS.ProcessEnv, cwd: string): string {
  return execFileSync(process.execPath, [CLI, "stats"], { env, encoding: "utf8", cwd });
}

test("CLI and server resolve the same stats path, with DCH_DATA_DIR set and unset", () => {
  const cwd = mkdtempSync(join(tmpdir(), "dch-stats-path-cwd-"));

  const setDir = mkdtempSync(join(tmpdir(), "dch-stats-path-data-"));
  const setEnv = envWith(setDir);
  const setPath = statsPath(setEnv);
  assert.equal(setPath, join(setDir, "stats.json"));
  assert.equal(openStats("devnet", setEnv).path, setPath);
  assert.equal(cliStats(setEnv, cwd).trim(), `no stats yet (${setPath})`);

  const unsetEnv = envWith(undefined);
  const unsetPath = statsPath(unsetEnv);
  assert.equal(unsetPath, join(".data", "stats.json"));
  assert.equal(openStats("devnet", unsetEnv).path, unsetPath);
  assert.equal(cliStats(unsetEnv, cwd).trim(), `no stats yet (${unsetPath})`);
});
