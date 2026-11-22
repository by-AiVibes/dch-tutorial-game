// Level 0: Get your devnet wallet.
// The wallet is generated IN THIS BROWSER with xrpl.js. The seed stays in this page's memory
// only: it is never stored, never sent to our server, and never logged. The faucet is called
// directly from the browser with your address; our server only ever sees the address.
(() => {
  const root = document.getElementById("l0body");
  let wallet = null; // { address, seed } — in memory only
  let st = null;
  let info = "";
  const savedAddr = () => localStorage.getItem("dch-wallet-address") || "";
  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === "class") e.className = v; else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : String(k));
    return e;
  };
  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text);

  async function createWallet() {
    if (!window.xrpl) { info = "Couldn't load xrpl.js in the browser."; return render(); }
    const w = window.xrpl.Wallet.generate();
    wallet = { address: w.address, seed: w.seed };
    localStorage.setItem("dch-wallet-address", w.address); // the address is public; the seed is NOT stored
    info = "Wallet created in your browser. Save the seed now: it is shown only on this page and is gone when you reload.";
    render();
  }

  async function fund() {
    const address = wallet?.address || savedAddr();
    if (!address || !st?.faucetHost) return;
    info = `Asking the public ${st.network} faucet to fund ${address}…`; render();
    try {
      const r = await fetch(`https://${st.faucetHost}/accounts`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ destination: address }),
      });
      if (!r.ok) throw new Error(`faucet said ${r.status}`);
      info = "Faucet accepted. Checking the balance on the ledger (this can take a few seconds)…"; render();
      for (let i = 0; i < 8; i++) { await new Promise((ok) => setTimeout(ok, 2500)); if ((await balance(address))?.funded) break; }
    } catch (e) { info = `Faucet error: ${e.message}. Try again in a minute.`; }
    render();
  }

  let bal = null;
  async function balance(address = wallet?.address || savedAddr()) {
    if (!address) return null;
    const r = await fetch(`/api/account/${encodeURIComponent(address)}`); // address only
    bal = await r.json();
    if (!r.ok) { info = `Balance check failed: ${bal.error}`; bal = null; }
    else info = bal.funded ? `Live on ${bal.network}: ${bal.balanceXrp} test XRP (base reserve ${bal.reserveBaseXrp ?? "?"} XRP).` : "Not funded yet on the ledger.";
    render();
    return bal;
  }

  async function claim(role) {
    const player = (document.getElementById("player").value || "").trim();
    if (!player) { info = "Type your name in the Seats box first."; return render(); }
    const address = wallet?.address || savedAddr();
    const r = await fetch("/api/seat/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, player, wallet: address }), // never the seed
    });
    const j = await r.json();
    info = r.ok ? `You hold the ${role} seat with wallet ${address}. A bot no longer plays it.` : `Couldn't claim: ${j.error}`;
    if (r.ok) window.dispatchEvent(new Event("dch-refresh"));
    render();
  }

  function render() {
    const net = st?.network ?? "test network";
    const title = document.querySelector("#level0 h2");
    if (title && st) title.firstChild.textContent = `Level 0: Get your ${net} wallet `;
    const address = wallet?.address || savedAddr();
    const freeSeats = st ? Object.values(st.seats).filter((s) => !s.player).map((s) => s.role) : [];
    root.replaceChildren(
      h("ol", {},
        h("li", {}, h("b", {}, `What ${net} is. `), "A public XRP Ledger test network for developers. Its XRP comes free from a faucet and ",
          h("b", {}, "has no value"), ", and the network can be reset at any time, which wipes accounts. ",
          link("https://xrpl.org/docs/concepts/networks-and-servers/parallel-networks", "Parallel networks"), " · ",
          link("https://xrpl.org/resources/dev-tools/xrp-faucets", "Faucets")),
        h("li", {}, h("b", {}, "Create a wallet. "), "The game generates a key pair in this browser. ",
          h("button", { on: { click: createWallet } }, wallet ? "Create another" : `Create my ${net} wallet`), " ",
          link("https://xrpl.org/docs/concepts/accounts/cryptographic-keys", "About keys")),
        wallet ? h("div", { class: "msg" },
          h("b", {}, "Save your seed. "), "It's test-only. ", h("b", {}, "Never reuse a test seed on mainnet."),
          " It never leaves this browser and is not saved; reloading the page forgets it.", h("br"),
          "Address: ", h("code", {}, wallet.address), h("br"),
          "Seed: ", h("code", { id: "l0seed" }, "•••••••• (click Show)"), " ",
          h("button", { on: { click: () => { const c = document.getElementById("l0seed"); c.textContent = c.textContent.startsWith("•") ? wallet.seed : "•••••••• (click Show)"; } } }, "Show / hide")) : null,
        !wallet && address ? h("p", {}, "Your saved address: ", h("code", {}, address), " (the seed is not stored)") : null,
        h("li", {}, h("b", {}, "Fund it. "), "An account exists once it holds at least the base reserve. ",
          h("button", { ...(address ? {} : { disabled: "" }), on: { click: fund } }, `Fund from the ${net} faucet`), " ",
          h("button", { ...(address ? {} : { disabled: "" }), on: { click: () => balance() } }, "Check balance"), " ",
          link("https://xrpl.org/docs/concepts/accounts", "Accounts"), " · ", link("https://xrpl.org/docs/concepts/accounts/reserves", "Reserves")),
        h("li", {}, h("b", {}, "Claim a seat with it. "), "Your address replaces a bot in that seat. ",
          ...(bal?.funded ? freeSeats.map((r) => h("button", { on: { click: () => claim(r) } }, r)) : [h("span", { class: "tag warn" }, "fund and check the balance first")]))),
      h("p", { class: "sub" }, "In this version, level transactions for a seat are still signed by the world's server-side test account for that role; your wallet is linked to the seat and shown on the dashboard. Signing level steps from your own wallet is planned."),
      info ? h("div", { class: "msg" }, info) : null);
  }

  window.addEventListener("dch-state", (e) => { st = e.detail; render(); });
  render();
})();
