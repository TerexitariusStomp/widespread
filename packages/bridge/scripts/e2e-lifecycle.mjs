#!/usr/bin/env node
// e2e-lifecycle.mjs — the flagship proof: one mirror through the entire
// money trail, stage by stage, against the LIVE bridge + PayPal sandbox +
// NEAR testnet. Idempotent — safe to re-run; each stage reports state.
//
//   node scripts/e2e-lifecycle.mjs                 # full walkthrough
//   node scripts/e2e-lifecycle.mjs --mirror <id>   # specific mirror
//   node scripts/e2e-lifecycle.mjs --stage fund    # resume at a stage
//
// Stages: detect → fund(order) → [you approve in browser] → capture →
// escrow(on-chain) → claim(auto/manual) → verdict → payout → receipt.
// The approval step is the only human one — PayPal sandbox requires a
// logged-in buyer; everything else is API-driven.

const BASE = process.env.BRIDGE_BASE
  ?? "https://widespread-bridge.widespread.workers.dev";
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const ONLY = arg("--stage", null);

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path) => fetch(`${BASE}${path}`);

const step = async (name, fn) => {
  if (ONLY && ONLY !== name) return null;
  console.log(`\n=== ${name} ===`);
  const out = await fn();
  console.log(JSON.stringify(out, null, 2).slice(0, 2000));
  return out;
};

// 1. detect — pick a seeking-funder mirror (or --mirror override)
const mirrorId = arg("--mirror", null);
let mirror = null;
if (!mirrorId || ONLY === "detect") {
  const { mirrors } = await (await get("/api/mirrors")).json();
  mirror = mirrorId
    ? mirrors.find((m) => m.id === mirrorId)
    : mirrors.find((m) => m.status === "seeking-funder") ?? mirrors[0];
  if (!mirror) { console.error("no mirrors found"); process.exit(1); }
}
const MID = mirror?.id ?? mirrorId;
console.log(`mirror: ${MID}`);
console.log(`title:  ${mirror?.title ?? "(lookup)"}`);
console.log(`value:  ${mirror?.original?.amount ?? "?"} ${mirror?.original?.currency ?? ""} face`);

// 2. fund — PayPal sandbox order at face value
const fund = await step("fund", async () => {
  const r = await post("/api/mirrors/fund", { mirror_id: MID });
  const { status, body } = await j(r);
  if (body.approve_url) {
    console.log(`\n>>> APPROVE THIS ORDER IN YOUR BROWSER (PayPal sandbox):\n    ${body.approve_url}\n`);
  }
  return { status, ...body };
});

// 3. capture — poll until payer approves, then capture
await step("capture", async () => {
  const orderId = fund?.order_id ?? fund?.funding?.order_id;
  if (!orderId) return { skipped: "no order_id — run fund stage first" };
  // Try capture; if the payer hasn't approved yet we get a 409 — that's
  // expected. Re-run after approving.
  const r = await post("/api/mirrors/capture", { mirror_id: MID, order_id: orderId });
  const { status, body } = await j(r);
  if (status === 409) {
    return { pending: "order not yet approved — approve the link above, then re-run --stage capture" };
  }
  return { status, funding: body.funding, escrow: body.escrow };
});

// 4. escrow — ops account converts USD→NEAR, creates on-chain market
await step("escrow", async () => {
  const r = await post("/api/mirrors/escrow", { mirror_id: MID });
  const { status, body } = await j(r);
  return { status, ...body };
});

// 5. claims — list what's been auto-ingested (or file a manual one)
await step("claims", async () => {
  const r = await get(`/api/mirrors/claims?mirror_id=${encodeURIComponent(MID)}`);
  const { body } = await j(r);
  return { count: body.claims?.length ?? 0, claims: body.claims?.slice(0, 3) };
});

// 6. verdict — pick the first attested claim (or --claim <hash>)
const claimHash = arg("--claim", null);
await step("verdict", async () => {
  let hash = claimHash;
  if (!hash) {
    const r = await get(`/api/mirrors/claims?mirror_id=${encodeURIComponent(MID)}`);
    const { body } = await j(r);
    const attested = (body.claims ?? []).find((c) => c.attested);
    if (!attested) return { skipped: "no attested claims yet — submit work on the source issue" };
    hash = attested.claim_hash;
  }
  const r = await post("/api/mirrors/verdict", {
    mirror_id: MID, claim_hash: hash, accept: true,
    payout: { paypal_email: arg("--payout-email", "sandbox-buyer@paypal.com") },
    reasoning: "e2e-lifecycle demo verdict",
  });
  const { status, body } = await j(r);
  return { status, settlement: body.settlement };
});

// 7. payout — PayPal Payouts USD (or PYUSD pending_ops without Paxos creds)
await step("payout", async () => {
  const r = await post("/api/mirrors/payout", { mirror_id: MID });
  const { status, body } = await j(r);
  return { status, payout: body.settlement?.payout };
});

// 8. receipt — the public proof page
await step("receipt", async () => {
  const r = await get(`/api/mirrors/claims?mirror_id=${encodeURIComponent(MID)}`);
  const { body } = await j(r);
  const c = (body.claims ?? [])[0];
  if (!c) return { skipped: "no claims" };
  const page = `/receipts/m/${encodeURIComponent(MID)}/${encodeURIComponent(c.claim_hash)}`;
  const html = await get(page);
  return { receipt_url: `${BASE}${page}`, status: html.status };
});

console.log("\nDone. Receipt + full trail live at the URLs above.");
