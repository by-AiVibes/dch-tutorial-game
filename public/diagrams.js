// Small teaching diagrams for the step cards: our own inline SVG (no images, no CDNs).
// DIAG is plain data (tested); diagram() builds the SVG figure in the browser.

const NS = "http://www.w3.org/2000/svg";

/** 24x24 line icons (stroke = currentColor). */
export const ICONS = {
  wallet: "M3 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zm0 0 12-4v4M16 13h2",
  key: "M14 10a4 4 0 1 0-1 2.6L21 20m-3-3 2-2m-4 0 2-2",
  faucet: "M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z",
  ledger: "M4 5h16v4H4zM4 10h16v4H4zM4 15h16v4H4z",
  bank: "M3 9 12 4l9 5M5 10v8M10 10v8M14 10v8M19 10v8M3 20h18",
  person: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6",
  lock: "M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3M12 15v2",
  badge: "M12 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM9 13l-2 8 5-3 5 3-2-8",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z",
  dex: "M4 8h14l-3-3M20 16H6l3 3",
  doc: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7",
  vault: "M3 4h18v16H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 9V7M15 12h2",
  coin: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9h4a2 2 0 0 1 0 4h-3m0-4v8",
  briefcase: "M3 8h18v12H3zM9 8V5h6v3M3 13h18",
  server: "M4 4h16v6H4zM4 14h16v6H4zM7 7h1M7 17h1",
  eyeoff: "M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.2 6.2C4 7.8 3 10 3 12c0 0 4 6 9 6a9 9 0 0 0 4-1",
  check: "M5 12l5 5 9-10",
  seat: "M7 4v9h10M7 13v7M17 13v7M7 9h8a2 2 0 0 1 2 2v2",
  switch: "M3 14h4l9-6M16 14h5M7 14a1 1 0 1 0 0 .1M16 14a1 1 0 1 0 0 .1",
};

const n = (icon, label, state) => ({ icon, label, ...(state ? { state } : {}) });

/**
 * Diagram specs, keyed "<levelId>:<card>". nodes left to right; links[i] joins node i and i+1;
 * bad = index of the link the ledger refuses; caption = one or two short lines.
 */
export const DIAG = {
  // Level 0
  "wallet:devnet": { nodes: [n("faucet", "faucet"), n("wallet", "you"), n("ledger", "devnet")], links: ["free XRP", ""], caption: ["A practice copy of the XRP Ledger.", "Test XRP has no value; the network can be wiped."] },
  "wallet:wallet": { nodes: [n("key", "key pair"), n("wallet", "address r…")], links: ["makes"], caption: ["Made in your browser. The address is public."] },
  "wallet:seed": { nodes: [n("key", "seed"), n("lock", "this page only")], links: ["kept"], caption: ["The seed signs for the account.", "Whoever has it controls the account."] },
  "wallet:fund": { nodes: [n("faucet", "faucet"), n("wallet", "you", "ok"), n("ledger", "account")], links: ["test XRP", "created"], caption: ["An account exists once it holds the base reserve."] },
  "wallet:world": { nodes: [n("server", "game server"), n("faucet", "faucet"), n("ledger", "6 accounts")], links: ["asks", "funds"], caption: ["Your own issuer, holder, lender, borrower, auditor and a bot."] },
  "wallet:seat": { nodes: [n("person", "you"), n("seat", "one seat")], links: ["plays"], caption: ["Bots play every seat you leave open."] },
  // Level 1
  "issue:goal": { nodes: [n("bank", "issuer"), n("person", "holder"), n("person", "holder 2")], links: ["trust line", "TST"], caption: ["Holders open trust lines to the issuer.", "Tokens go holder → issuer → holder."] },
  "issue:fail": { nodes: [n("bank", "issuer"), n("person", "holder"), n("person", "holder 2")], links: ["TST", "via holder"], bad: 1, caption: ["NoRipple on the holder's lines blocks the hop.", "Ledger result: tecPATH_DRY."] },
  // Level 2
  "freeze:goal": { nodes: [n("bank", "issuer"), n("lock", "frozen line"), n("person", "holder")], links: ["freeze", "claw back"], caption: ["The issuer freezes the line, then claws tokens back.", "Clawback must be switched on before the issuer owns anything (no trust lines yet)."] },
  "freeze:fail": { nodes: [n("bank", "Level 1 issuer"), n("person", "holder")], links: ["claw back"], bad: 0, caption: ["This issuer never enabled clawback: refused."] },
  // Level 3
  "creds:goal": { nodes: [n("bank", "issuer"), n("badge", "credential"), n("person", "holder", "ok")], links: ["create", "accept"], caption: ["The issuer creates a credential for the holder.", "It counts only after the holder accepts it."] },
  "creds:fail": { nodes: [n("person", "holder bot"), n("badge", "holder's credential")], links: ["accept"], bad: 0, caption: ["Only the credential's subject can accept it."] },
  // Level 4
  "domain:goal": { nodes: [n("badge", "credential"), n("shield", "domain"), n("dex", "domain DEX")], links: ["admits", "trade"], caption: ["A permissioned domain admits credentialed accounts.", "Only they can trade in its DEX."] },
  "domain:fail": { nodes: [n("person", "no credential"), n("shield", "domain")], links: ["offer"], bad: 0, caption: ["No accepted credential, no entry: refused."] },
  // Level 5
  "batch:goal": { nodes: [n("doc", "create"), n("doc", "accept"), n("ledger", "both applied", "ok")], links: ["+", "one batch"], caption: ["Two transactions in one all-or-nothing batch.", "Both apply, or neither does."] },
  "batch:fail": { nodes: [n("doc", "create"), n("doc", "bad accept"), n("ledger", "rolled back")], links: ["+", "one batch"], bad: 1, caption: ["One inner transaction can't succeed,", "so the whole batch rolls back."] },
  // Level 6
  "vault:goal": { nodes: [n("person", "holder"), n("vault", "vault"), n("coin", "shares")], links: ["deposit XRP", "mints"], caption: ["Depositors put XRP in and get vault shares.", "A withdrawal redeems your own shares."] },
  "vault:fail": { nodes: [n("person", "borrower"), n("vault", "vault")], links: ["withdraw"], bad: 0, caption: ["No shares, nothing to redeem: refused."] },
  // Level 7
  "lend:goal": { nodes: [n("vault", "vault"), n("briefcase", "loan broker"), n("person", "borrower")], links: ["funds", "10 XRP loan"], caption: ["The broker lends vault funds, backed by first-loss cover.", "The borrower repays the loan."] },
  "lend:fail": { nodes: [n("briefcase", "loan broker"), n("person", "borrower")], links: ["25 XRP loan"], bad: 0, caption: ["Above the broker's 20 XRP debt maximum: refused."] },
  // Level 8 (explainer parts)
  "confidential:p0": { nodes: [n("coin", "MPT"), n("wallet", "account")], links: ["held directly"], caption: ["No trust line: the holder opts in with an MPToken entry."] },
  "confidential:p1": { nodes: [n("server", "this game"), n("ledger", "test network")], links: ["live check"], caption: ["The game checks the amendment live; it never assumes."] },
  "confidential:p2": { nodes: [n("coin", "amount"), n("eyeoff", "hidden"), n("check", "proof valid", "ok")], links: ["encrypt", "ZK proof"], caption: ["Balances and amounts are shielded from public view;", "the ledger still verifies each transfer."] },
  "confidential:p3": { nodes: [n("person", "issuer / auditor"), n("coin", "balance", "ok")], links: ["decrypts"], caption: ["The issuer (and an auditor, if set) can decrypt balances.", "Total supply stays public."] },
  "confidential:p4": { nodes: [n("doc", "hands-on steps"), n("ledger", "when enabled")], links: ["coming"], caption: ["Runs only where the live check shows it enabled."] },
  // shared
  seat: { nodes: [n("person", "you"), n("seat", "a seat"), n("server", "bots")], links: ["optional", "rest"], caption: ["Play a seat yourself, or let bots play them all."] },
  done: { nodes: [n("switch", "switch closed", "ok"), n("check", "next level")], links: ["power flows"], caption: ["Each finished level closes one switch on your circuit."] },
};

/** Build the figure for a diagram key (or null). */
let diagSeq = 0;
export function diagram(key) {
  const d = DIAG[key];
  if (!d) return null;
  const W = 320, H = 92, N = d.nodes.length;
  const x = (i) => (W * (i + 0.5)) / N;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "diag-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", d.nodes.map((nd) => nd.label).join(" → ") + ". " + d.caption.join(" "));
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  const uid = `d${++diagSeq}`;
  add("defs", {}).innerHTML = `<marker id="${uid}-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#7ee2a8"/></marker><marker id="${uid}-ahb" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#f85149"/></marker>`;
  d.links.forEach((lab, i) => {
    if (i >= N - 1) return;
    const bad = d.bad === i;
    const x1 = x(i) + 26, x2 = x(i + 1) - 26;
    add("line", { x1, y1: 32, x2, y2: 32, class: bad ? "dl bad" : "dl", "marker-end": `url(#${uid}-${bad ? "ahb" : "ah"})` });
    if (lab) add("text", { x: (x1 + x2) / 2, y: 22, class: "dlab" + (bad ? " bad" : "") }, lab);
    if (bad) add("text", { x: (x1 + x2) / 2, y: 50, class: "dx" }, "✗");
  });
  d.nodes.forEach((nd, i) => {
    add("circle", { cx: x(i), cy: 32, r: 21, class: "dnode" + (nd.state ? " " + nd.state : "") });
    const g = add("g", { transform: `translate(${x(i) - 12} 20)`, class: "dicon" });
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", ICONS[nd.icon] || ICONS.doc);
    g.append(p);
    add("text", { x: x(i), y: 72, class: "dname" }, nd.label);
  });
  const fig = document.createElement("figure");
  fig.className = "diag";
  fig.append(svg);
  const cap = document.createElement("figcaption");
  for (const line of d.caption) { const s = document.createElement("span"); s.textContent = line; cap.append(s); }
  fig.append(cap);
  return fig;
}
