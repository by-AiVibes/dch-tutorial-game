// Level 0 safety: a seed is never accepted, stored, echoed or logged by the server,
// and mainnet stays refused. No network access: these requests fail before any ledger call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Wallet } from "xrpl";
// Generated fresh each run (never hard-coded, never printed, never funded).
const W = Wallet.generate();
const SEED = W.seed as string;
const ADDR = W.address;

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-srv-"));
const { Game } = await import("../src/game.ts");
const { createHandler } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { assertNoSecrets } = await import("../src/secrets.ts");

const logs: string[] = [];
const game = new Game(loadConfig({}), (m) => logs.push(m));
const origLog = console.log, origErr = console.error;
console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
const server: Server = createServer(createHandler(game));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("claim with a seed instead of an address is refused without echoing it", async () => {
  for (const body of [
    { role: "holder", player: "ada", wallet: SEED },
    { role: "holder", player: "ada", wallet: ADDR, seed: SEED },
    { role: "holder", player: "ada", wallet: ADDR, secret: "x" },
    { role: "holder", player: SEED },
  ]) {
    const r = await post("/api/seat/claim", body);
    const text = await r.text();
    assert.equal(r.status, 400);
    assert.ok(!text.includes(SEED), "response must not echo the seed");
  }
});

test("malformed JSON containing a seed is refused generically", async () => {
  const r = await post("/api/seat/claim", `{"wallet": "${SEED}"`);
  const text = await r.text();
  assert.equal(r.status, 400);
  assert.ok(!text.includes(SEED));
});

test("account lookup refuses a seed in the path", async () => {
  const r = await fetch(`${base}/api/account/${SEED}`);
  assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes(SEED));
});

test("claim with a real address works and stores only the address", async () => {
  const r = await post("/api/seat/claim", { role: "holder", player: "ada", wallet: ADDR });
  assert.equal(r.status, 200);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.equal(s.seats.holder.wallet, ADDR);
  assert.equal(s.seats.holder.player, "ada");
});

test("nothing logged or persisted contains the seed", () => {
  assert.ok(!logs.join("\n").includes(SEED));
  for (const f of readdirSync(process.env.DCH_DATA_DIR!)) assert.ok(!readFileSync(join(process.env.DCH_DATA_DIR!, f), "utf8").includes(SEED));
});

test("browser Level 0 code never sends the seed anywhere", () => {
  const src = readFileSync(new URL("../public/level0.js", import.meta.url), "utf8");
  for (const m of src.matchAll(/JSON\.stringify\(([^)]*)\)/g)) assert.ok(!/seed/i.test(m[1]), `request body ${m[1]}`);
  assert.ok(!/localStorage\.setItem\([^)]*seed/i.test(src), "seed must not be stored");
  assert.ok(!/console\.\w+\([^)]*seed/i.test(src), "seed must not be logged");
});

test("secret guard: refuses every secret shape, allows addresses", () => {
  const ed = Wallet.generate();
  const hex64 = ed.privateKey.replace(/^ED|^00/, "").slice(0, 64);
  const cases: Record<string, string> = {
    "embedded seed": `my seed is ${SEED} ok`,
    "64-hex private key": hex64,
    "66-hex private key": ed.privateKey,
    "66-hex public key": ed.publicKey,
    "32-hex entropy": "0123456789abcdef0123456789ABCDEF",
    "12-word mnemonic": "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "secret numbers": "123456 234567 345678 456789 567890 678901 789012 890123",
    "secret numbers with dashes": "123456-234567-345678-456789-567890-678901-789012-890123",
  };
  for (const [name, v] of Object.entries(cases)) {
    assert.throws(() => assertNoSecrets({ wallet: v }), /never send a seed/, name);
  }
  for (const ok of [ADDR, ed.address, "ada", "a short note with five words", "123456 234567"]) {
    assert.doesNotThrow(() => assertNoSecrets({ wallet: ok, player: "ada" }), ok);
  }
});

test("level 0 names the configured network", () => {
  const v = game.view();
  const l0 = v.levels.find((l: { id: string }) => l.id === "wallet")!;
  assert.equal(l0.title, `Get your ${v.network} wallet`);
  assert.ok(!JSON.stringify(l0).includes("{network}") && !JSON.stringify(l0).includes("{Network}"));
});

test("missing vendor file does not leak a path", async () => {
  const r = await fetch(`${base}/vendor/xrpl.js`);
  const t = await r.text();
  assert.ok(r.status === 200 || (r.status === 500 && !t.includes("/")));
});

test("secret guard and mainnet refusal", () => {
  assert.throws(() => assertNoSecrets({ a: [{ b: SEED }] }));
  assert.doesNotThrow(() => assertNoSecrets({ wallet: ADDR, player: "ada" }));
  assert.throws(() => loadConfig({ XRPL_WS: "wss://xrplcluster.com" }));
  assert.throws(() => loadConfig({ XRPL_NETWORK: "mainnet" }));
});

test("cleanup", async () => {
  await new Promise((r) => server.close(r));
  console.log = origLog; console.error = origErr;
});
