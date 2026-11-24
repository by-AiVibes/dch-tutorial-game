// Live run log and ledger relay. No network: the XRPL client is a fake, and one run
// really has a wallet seed in scope so a leak into the stream fails the walk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Wallet } from "xrpl";

process.env.DCH_DATA_DIR = mkdtempSync(join(tmpdir(), "dch-live-"));
const { Game } = await import("../src/game.ts");
const { createHandler } = await import("../src/server.ts");
const { loadConfig } = await import("../src/config.ts");
const { RateLimiter, DEFAULT_RULES } = await import("../src/limits.ts");
const { findLevel } = await import("../src/levels/index.ts");
const { LedgerRelay } = await import("../src/ledgerstream.ts");
const { projectLedger, projectRunEvent, RIPPLE_EPOCH_SEC, streamUnsafe } = await import("../src/live.ts");
const { looksSecret } = await import("../src/secrets.ts");

const HASH = "AB".repeat(32);
const SECRET_KEY = /seed|secret|private|mnemonic|passphrase|entropy|blob/i;
const FAMILY = /(^|[^1-9A-HJ-NP-Za-km-z])s[1-9A-HJ-NP-Za-km-z]{24,34}(?![1-9A-HJ-NP-Za-km-z])/;
const WORDS = /\b[a-z]+(?:[\s,]+[a-z]+){11,}\b/;
const NUMBERS = /\b\d{6}(?:[\s-]+\d{6}){7}\b/;
const HEX = /[0-9A-Fa-f]{32,}/;

function walk(value: unknown, seed: string, key = ""): void {
  if (key && SECRET_KEY.test(key)) assert.fail(`secret key leaked: ${key}`);
  if (typeof value === "string") {
    assert.equal(value.includes(seed), false, key || "value");
    if (key === "hash") {
      assert.match(value, /^[A-F0-9]{64}$/);
      return;
    }
    assert.equal(FAMILY.test(value), false, `family seed in ${key}`);
    assert.equal(WORDS.test(value), false, `mnemonic in ${key}`);
    assert.equal(NUMBERS.test(value), false, `secret numbers in ${key}`);
    assert.equal(HEX.test(value), false, `hex secret in ${key}`);
    assert.equal(looksSecret(value), false, key);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, i) => walk(item, seed, String(i)));
  if (value && typeof value === "object") for (const [k, item] of Object.entries(value)) walk(item, seed, k);
}

function fakeLedger() {
  const listeners = new Set<(msg: unknown) => void>();
  return {
    subs: 0,
    unsubs: 0,
    on(event: string, fn: (msg: unknown) => void) { if (event === "ledgerClosed") listeners.add(fn); },
    removeListener(event: string, fn: (msg: unknown) => void) { if (event === "ledgerClosed") listeners.delete(fn); },
    listenerCount() { return listeners.size; },
    async request(cmd: { command?: string }) {
      if (cmd.command === "subscribe") this.subs++;
      else if (cmd.command === "unsubscribe") this.unsubs++;
      return {};
    },
    emit(msg: unknown) { for (const fn of listeners) fn(msg); },
    async autofill(tx: Record<string, unknown>) {
      return { ...tx, Sequence: 1, Fee: "12", LastLedgerSequence: 20 };
    },
    async submitAndWait() {
      return { result: { hash: HASH, validated: true, ledger_index: 88, meta: { TransactionResult: "tesSUCCESS" } } };
    },
  };
}

test("run events copy an allowlist and drop a seed, a secret, and a signed blob", () => {
  const seed = Wallet.generate().seed as string;
  const clean = projectRunEvent({
    label: "Issuer creates a KYC credential for the holder",
    type: "CredentialCreate",
    engineResult: "tesSUCCESS",
    hash: HASH,
    validated: true,
    ledgerIndex: 88,
    seed,
    secret: "x",
    privateKey: "ab".repeat(32),
    mnemonic: "abandon ability able about above absent absorb abstract absurd abuse access accident",
    tx_blob: "EE".repeat(80),
  });
  assert.deepEqual(clean, {
    label: "Issuer creates a KYC credential for the holder",
    type: "CredentialCreate",
    engineResult: "tesSUCCESS",
    hash: HASH,
    validated: true,
    ledgerIndex: 88,
  });
  assert.equal(streamUnsafe(clean), false);
  walk(clean, seed);
  // A label that is the seed itself never becomes an event field.
  const dropped = projectRunEvent({ label: seed, type: "AccountSet", engineResult: "tesSUCCESS", hash: HASH, seed });
  assert.equal(dropped?.label, undefined);
  assert.equal(JSON.stringify(dropped).includes(seed), false);
  walk(dropped, seed);
});

test("renamed step labels (KYC, BATCH, HALF, NONE) pass through the allowlist unchanged", () => {
  const level3 = readFileSync(new URL("../src/levels/level3.ts", import.meta.url), "utf8");
  const level4 = readFileSync(new URL("../src/levels/level4.ts", import.meta.url), "utf8");
  const level5 = readFileSync(new URL("../src/levels/level5.ts", import.meta.url), "utf8");
  for (const src of [level3, level4, level5]) assert.doesNotMatch(src, /DCH-/);
  assert.match(level3, /Issuer creates a KYC credential for the holder/);
  assert.match(level5, /HALF_TYPE/);
  const labels = [
    "Issuer creates a KYC credential for the holder",
    "Issuer creates a domain that accepts its KYC credential",
    "Holder bot, without a KYC credential, tries to trade in the domain",
  ];
  for (const label of labels) {
    const ev = projectRunEvent({ label, type: "CredentialCreate", engineResult: "tesSUCCESS", hash: HASH });
    assert.equal(ev?.label, label);
    assert.equal(ev?.engineResult, "tesSUCCESS");
  }
});

test("ledger relay sends only index and close time", async () => {
  const seed = Wallet.generate().seed as string;
  const fake = fakeLedger();
  const relay = new LedgerRelay(async () => fake);
  const got: unknown[] = [];
  const stop = await relay.add((e) => got.push(e));
  fake.emit({
    type: "ledgerClosed",
    ledger_index: 42,
    ledger_time: 700_000_000,
    ledger_hash: "C".repeat(64),
    fee_base: 10,
    fee_ref: 10,
    reserve_base: 1_000_000,
    reserve_inc: 200_000,
    txn_count: 3,
    validated_ledgers: "1-42",
    seed,
    tx_blob: "EE".repeat(40),
  });
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], {
    ledgerIndex: 42,
    closeTime: new Date((700_000_000 + RIPPLE_EPOCH_SEC) * 1000).toISOString(),
  });
  assert.deepEqual(Object.keys(got[0] as object).sort(), ["closeTime", "ledgerIndex"]);
  walk(got[0], seed);
  assert.equal(projectLedger({ ledger_index: 1, ledger_time: 1, seed })?.ledgerIndex, 1);
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.unsubs, 1);
  assert.equal(fake.listenerCount(), 0);
  assert.equal(fake.subs, 1);
});

test("a level run with a seed in scope streams only safe run and ledger events, and disconnect unsubscribes", async () => {
  const fake = fakeLedger();
  const g = new Game(loadConfig({}), () => {}, { maxWorlds: 100, minIdleMs: 3_600_000, newPerHour: 100, maxAwards: 100 });
  const any = g as any;
  any.ledger = async () => fake;
  any.fundAccounts = async () => Object.fromEntries(["issuer", "holder", "lender", "borrower", "auditor", "holderBot"].map((k) => {
    const w = Wallet.generate();
    return [k, { address: w.address, seed: w.seed }];
  }));
  any.shared.amendments = { network: "devnet", checkedAt: new Date(0).toISOString(), amendments: {} };
  const owner = Wallet.generate().address;
  await g.startWorld(owner);
  const key = Game.key(owner);
  const seed = any.st(key).accounts.issuer.seed as string;
  assert.match(seed, /^s/);
  const level = findLevel("issue")!;
  const orig = level.runGoal;
  level.runGoal = async (ctx) => {
    const held = ctx.wallet("issuer").seed as string;
    assert.equal(held, seed);
    ctx.note(`Issuer creates a KYC credential ${held}`);
    const r = await ctx.submit("issuer", { TransactionType: "AccountSet", SetFlag: 8 });
    return { ok: true, message: "KYC credential created", results: [r] };
  };
  const relay = new LedgerRelay(async () => fake);
  const server = createServer(createHandler(g, new RateLimiter(DEFAULT_RULES), false, undefined, relay));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ac = new AbortController();
  try {
    const posted = await fetch(`${base}/api/levels/issue/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ world: owner, async: true }),
    });
    assert.equal(posted.status, 202);
    const started = await posted.json() as { job: string; status: string };
    let polled: { status?: string; events?: unknown[]; result?: unknown } = {};
    for (let i = 0; i < 40 && polled.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      polled = await (await fetch(`${base}/api/jobs/${started.job}`)).json();
    }
    assert.equal(polled.status, "done");
    assert.equal(JSON.stringify(polled).includes(seed), false);
    walk(polled.events, seed);

    const res = await fetch(`${base}/api/jobs/${started.job}/stream`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const frames: { event: string; data: unknown }[] = [];
    const take = () => {
      const blocks = buf.split("\n\n");
      buf = blocks.pop() || "";
      for (const block of blocks) {
        if (!block.trim() || block.trimStart().startsWith(":")) continue;
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data) frames.push({ event, data: JSON.parse(data) });
      }
    };
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
      } catch { /* the test aborts the stream on purpose */ }
    })();
    void pump;
    const settle = async (ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        take();
        await new Promise((r) => setTimeout(r, 20));
      }
      take();
    };
    for (let i = 0; i < 50 && fake.subs < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fake.subs, 1, "the server subscribed to the ledger stream");
    await settle(100);
    fake.emit({
      type: "ledgerClosed",
      ledger_index: 90,
      ledger_time: 700_000_100,
      ledger_hash: "D".repeat(64),
      fee_base: 10,
      txn_count: 1,
      seed,
      validated_ledgers: "1-90",
    });
    await settle(300);
    const kinds = frames.map((f) => f.event);
    assert.ok(kinds.includes("run"), "run-log event");
    assert.ok(kinds.includes("ledger"), "ledger event");
    for (const frame of frames) {
      walk(frame.data, seed);
      if (frame.event === "ledger") {
        assert.deepEqual(Object.keys(frame.data as object).sort(), ["closeTime", "ledgerIndex"]);
        assert.equal((frame.data as { ledgerIndex: number }).ledgerIndex, 90);
      }
        if (frame.event === "run") {
        const ev = frame.data as { type?: string; engineResult?: string; hash?: string; label?: string };
        assert.equal(ev.type, "AccountSet");
        assert.equal(ev.engineResult, "tesSUCCESS");
        assert.equal(ev.hash, HASH);
        assert.equal(ev.label, undefined, "the step label carried the seed, so it is omitted");
      }
    }
    assert.equal(JSON.stringify(frames).includes(seed), false);
    await reader.cancel().catch(() => {});
    ac.abort();
    for (let i = 0; i < 50 && fake.unsubs < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fake.unsubs, 1, "disconnect drops the ledger subscription");
    assert.equal(fake.listenerCount(), 0);
  } finally {
    level.runGoal = orig;
    ac.abort();
    await new Promise((r) => server.close(r));
  }
});
