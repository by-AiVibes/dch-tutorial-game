// CLI: `npm run dch -- <command>`. Prints addresses, results and tx hashes; never seeds.

import { loadConfig } from "./config.ts";
import { Game } from "./game.ts";

const [cmd, ...args] = process.argv.slice(2);
const usage = `usage:
  reset-world                 fund fresh test accounts, bots in every seat, clear scores
  amendments                  check amendments on the network (feature RPC)
  play <level> goal|should-fail [player]
  status                      print the world (no secrets)`;

async function main() {
  const cfg = loadConfig();
  const game = new Game(cfg, (m) => console.log(`  · ${m}`));
  try {
    switch (cmd) {
      case "reset-world": {
        const v = await game.resetWorld();
        console.log(`world ${v.world} on ${v.network}:`);
        for (const [k, a] of Object.entries(v.accounts)) console.log(`  ${k.padEnd(10)} ${a.address}`);
        break;
      }
      case "amendments": {
        const r = await game.refreshAmendments();
        for (const a of Object.values(r.amendments)) console.log(`  ${a.name.padEnd(22)} ${a.enabled ? "enabled" : a.known ? "not enabled" : "unknown to server"}`);
        break;
      }
      case "play": {
        const [level, part, player] = args;
        if (!level || (part !== "goal" && part !== "should-fail")) throw new Error(usage);
        const r = await game.play(level, part === "goal" ? "goal" : "shouldFail", player ?? null);
        console.log(`${r.ok ? "OK" : "NOT OK"}: ${r.message} (+${r.added}, total ${r.view.score}/${r.view.maxScore})`);
        for (const t of r.results ?? []) console.log(`  ${t.type.padEnd(11)} ${t.engineResult.padEnd(16)} ${cfg.explorer}${t.hash}`);
        break;
      }
      case "status": {
        console.log(JSON.stringify(game.view(), null, 2));
        break;
      }
      default:
        console.log(usage);
        process.exitCode = cmd ? 1 : 0;
    }
  } finally {
    await game.close();
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
