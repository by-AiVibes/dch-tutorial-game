// CLI: `npm run dch -- <command>`. Prints addresses, results and tx hashes; never seeds.

import { loadConfig, statsPath } from "./config.ts";
import { LEVELS } from "./levels/index.ts";
import { formatStats, Stats } from "./stats.ts";
import { Game } from "./game.ts";

const [cmd, ...args] = process.argv.slice(2);
const usage = `usage:
  reset-world                 fund fresh test accounts, bots in every seat, clear scores
  amendments                  check amendments on the network (feature RPC)
  play <level> goal|should-fail [player]
  play-all                    run every playable level's goal and should-fail in order (smoke)
  status                      print the world (no secrets)
  stats [days] [--json]       visitor and player counts from the stats file (counts only)`;

async function main() {
  if (cmd === "stats") {
    // Reads the file the server writes; no network, no world access.
    const path = statsPath();
    const data = Stats.read(path);
    if (!data) { console.log(`no stats yet (${path})`); return; }
    const s = new Stats(path, { network: data.network, flushMs: 1e9 });
    const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 14);
    const snap = s.snapshot(days);
    console.log(args.includes("--json") ? JSON.stringify(snap, null, 2) : formatStats(snap, LEVELS.map((l) => l.id)));
    return;
  }
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
      case "play-all": {
        const order = ["issue", "freeze", "creds", "domain", "batch", "vault", "lend"];
        for (const id of order) {
          for (const part of ["goal", "shouldFail"] as const) {
            const r = await game.play(id, part, null);
            const hashes = (r.results ?? []).map((t) => `${t.type}:${t.engineResult}:${t.hash}`).join(" ");
            console.log(`${id} ${part}: ${r.ok ? "OK" : "NOT OK"} +${r.added} | ${r.message}${hashes ? `\n    ${hashes}` : ""}`);
          }
        }
        console.log(`score ${game.view().score}/${game.view().maxScore} on ${cfg.name}`);
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
