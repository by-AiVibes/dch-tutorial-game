// One ledger-stream subscription on the game's existing XRPL connection, shared by
// every browser that is watching a run, and dropped when the last one disconnects.

import { projectLedger, type LedgerEvent } from "./live.ts";

/** Waits between subscribe attempts when the first ledger subscribe fails. */
export const LEDGER_SUBSCRIBE_BACKOFF_MS = [100, 300];

export interface LedgerSource {
  on(event: "ledgerClosed", listener: (msg: unknown) => void): void;
  removeListener(event: "ledgerClosed", listener: (msg: unknown) => void): void;
  request(cmd: { command: "subscribe" | "unsubscribe"; streams: string[] }): Promise<unknown>;
}

/**
 * Relays validated ledger closes. Listeners receive only { ledgerIndex, closeTime }.
 * add() returns a stop function; the XRPL subscribe is reference-counted, so the
 * last stop unsubscribes and removes the handler.
 */
export class LedgerRelay {
  private listeners = new Set<(event: LedgerEvent) => void>();
  private client: LedgerSource | null = null;
  private subscribed = false;
  private opening: Promise<void> | null = null;
  /** Bumped on stop so an in-flight subscribe can't outlive the last listener. */
  private generation = 0;
  private connect: () => Promise<LedgerSource>;

  constructor(connect: () => Promise<LedgerSource>) {
    this.connect = connect;
  }

  private readonly onClosed = (msg: unknown) => {
    const event = projectLedger(msg);
    if (!event) return;
    for (const listener of this.listeners) listener(event);
  };

  async add(listener: (event: LedgerEvent) => void): Promise<() => void> {
    this.listeners.add(listener);
    try {
      await this.ensure();
    } catch {
      // The run log still streams. A failed subscribe must not throw away the watcher,
      // and must not leave a half-open handler behind (ensure rolls that back).
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.stop();
    };
  }

  private async ensure(): Promise<void> {
    if (this.subscribed || this.listeners.size === 0) return;
    if (this.opening) return this.opening;
    const generation = this.generation;
    this.opening = (async () => {
      const client = await this.connect();
      if (generation !== this.generation || this.listeners.size === 0) return;
      client.on("ledgerClosed", this.onClosed);
      let live = false;
      try {
        live = await this.subscribeLedger(client, generation);
      } catch (err) {
        try { client.removeListener("ledgerClosed", this.onClosed); } catch { /* already gone */ }
        throw err;
      }
      if (!live || generation !== this.generation || this.listeners.size === 0) {
        if (live) await this.detach(client);
        else try { client.removeListener("ledgerClosed", this.onClosed); } catch { /* already gone */ }
        return;
      }
      this.client = client;
      this.subscribed = true;
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  /** First subscribe, retried with backoff. False when the last listener left during a wait. */
  private async subscribeLedger(client: LedgerSource, generation: number): Promise<boolean> {
    let last: unknown;
    for (let attempt = 0; attempt <= LEDGER_SUBSCRIBE_BACKOFF_MS.length; attempt++) {
      if (generation !== this.generation || this.listeners.size === 0) return false;
      try {
        await client.request({ command: "subscribe", streams: ["ledger"] });
        return true;
      } catch (err) {
        last = err;
        const wait = LEDGER_SUBSCRIBE_BACKOFF_MS[attempt];
        if (wait == null) break;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw last;
  }

  private async stop(): Promise<void> {
    this.generation++;
    const client = this.client;
    this.client = null;
    this.subscribed = false;
    if (client) await this.detach(client);
  }

  private async detach(client: LedgerSource): Promise<void> {
    try { client.removeListener("ledgerClosed", this.onClosed); } catch { /* ignore */ }
    try { await client.request({ command: "unsubscribe", streams: ["ledger"] }); } catch { /* ignore */ }
  }
}
