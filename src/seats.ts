// Seat model: five role seats. A human may claim one; bots fill every unclaimed seat.

export const ROLES = ["issuer", "holder", "lender", "borrower", "auditor"] as const;
export type Role = (typeof ROLES)[number];

export interface Seat {
  role: Role;
  /** null means a bot plays this seat. */
  player: string | null;
}

export type Seats = Record<Role, Seat>;

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}

export function botSeats(): Seats {
  return Object.fromEntries(ROLES.map((r) => [r, { role: r, player: null }])) as Seats;
}

/** Validates a player label: short, plain, no markup. */
export function cleanPlayer(name: unknown): string {
  if (typeof name !== "string") throw new Error("player must be a string");
  const n = name.trim();
  if (!/^[A-Za-z0-9 _.-]{1,32}$/.test(n)) throw new Error("player: 1-32 letters, digits, space, _ . -");
  return n;
}

/** Claim a seat. One seat per player; a seat held by someone else can't be taken. */
export function claimSeat(seats: Seats, role: Role, player: string): Seats {
  const p = cleanPlayer(player);
  const current = seats[role];
  if (current.player && current.player !== p) {
    throw new Error(`The ${role} seat is already claimed.`);
  }
  const next = structuredClone(seats);
  for (const r of ROLES) if (next[r].player === p) next[r].player = null; // move, don't hold two
  next[role].player = p;
  return next;
}

/** Release a seat; a bot takes it back. */
export function releaseSeat(seats: Seats, role: Role, player: string): Seats {
  const p = cleanPlayer(player);
  if (seats[role].player !== p) throw new Error(`You don't hold the ${role} seat.`);
  const next = structuredClone(seats);
  next[role].player = null;
  return next;
}

export function whoPlays(seats: Seats, role: Role): "human" | "bot" {
  return seats[role].player ? "human" : "bot";
}

/**
 * Can this player act for these roles? A level step lists the seats that may run it.
 * Bot-only worlds (no human seats) let anyone drive the demo; otherwise you must hold one of the roles.
 */
export function canAct(seats: Seats, roles: readonly Role[], player: string | null): boolean {
  const anyHuman = roles.some((r) => seats[r].player);
  if (!anyHuman) return true;
  return player !== null && roles.some((r) => seats[r].player === player);
}
