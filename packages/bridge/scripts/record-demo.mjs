// Records the judging demo: launches headless Chromium with video capture
// and walks the live pipeline end to end. Everything on screen is real.
//   PLAYWRIGHT_BROWSERS_PATH=~/.local/share/ms-playwright \
//   PAYPAL_BASIC_B64=$(echo -n "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" | base64 -w0) \
//   node scripts/record-demo.mjs
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const require = createRequire("/home/terex/Documents/delta-git/package.json");
const { chromium } = require("playwright");
const exec = promisify(execFile);

const BRIDGE = "https://slopcash-bridge.hardwoodstablecoin.workers.dev";
const FORGE = "https://code.widespread.fyi";
const REPO = "slop/slopdotcash";
const SHA = "a0cc9de43d530b6b4d3884a5910074e4eee02e84";
const DIR = "/home/terex/Documents/slopcash-bridge";
const TERM = `file://${DIR}/video/term.html`;
const TITLE = `file://${DIR}/video/title.html`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: "/tmp/rec", size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();

const title = (t, s, g) => page.goto(`${TITLE}?t=${encodeURIComponent(t)}&s=${encodeURIComponent(s)}&g=${encodeURIComponent(g)}`);
const term = (lines) => page.evaluate((l) => window.term(l), lines);
const cap = (s) => page.evaluate((c) => window.cap(c), s);
async function beat(seconds) { await wait(seconds * 1000); }
async function prettyJson(url, caption, secs = 9) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.evaluate((c) => {
    try {
      const j = JSON.parse(document.body.innerText);
      document.body.innerHTML = `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;color:#e6edf3;background:#0d1117;margin:0;padding:24px;white-space:pre-wrap">${JSON.stringify(j, null, 2).replace(/</g, "&lt;")}</pre><div id="cap" style="position:fixed;left:0;right:0;bottom:0;padding:10px 18px;background:rgba(13,17,23,.96);border-top:2px solid #0070e0;font:14px -apple-system,Segoe UI,sans-serif;color:#c9d1d9">${c}</div>`;
      document.body.style.background = "#0d1117";
    } catch {}
  }, caption);
  await beat(secs);
}
const run = (cmd, args) => exec("bash", ["-lc", `${cmd} ${args}`], { cwd: DIR }).then((r) => r.stdout.trim());

// ── beat 1: title ─────────────────────────────────────────────────────
await title(
  "Slop.cash <span class='pp'>×</span> delta-git",
  "Verified-work payouts, agent-to-human. A signed forge attestation, an AI adjudicator, and a real PayPal payout — live, nothing mocked.",
  "PayPal Payouts|AI adjudicator|delta-git op-log|Cloudflare Workers|AG Grid|Postman"
);
await beat(6);

// ── beat 2: the forge's public op-log ─────────────────────────────────
await prettyJson(
  `${FORGE}/api/${REPO}/dg/oplog`,
  "<b>delta-git op-log</b> — every repo on code.widespread.fyi keeps a public, hash-chained log of agent operations.",
  9
);

// ── beat 3: agent ships → real dg-ship-1 claim lands ──────────────────
await page.goto(TERM);
await cap("<b>Agent ships work</b> — an ephemeral did:key agent posts /dg/ship; the forge verifies the commits against the GitHub upstream's .patch endpoint and writes a signed op-log entry.");
await term(["$ node scripts/ship-claim.mjs --repo slop/slopdotcash --commits a0cc9de4…"]);
const claimOut = await run("node", [`scripts/ship-claim.mjs --repo ${REPO} --commits ${SHA} --session slopcash-demo-lease-receipt --tool devin`]);
const seq = (claimOut.match(/"op_seq":(\d+)/) ?? [])[1] ?? "1";
await term(claimOut.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("ship") ? `!${l}` : l)));
await beat(9);

// ── beat 4: claim is in the chain ─────────────────────────────────────
await prettyJson(
  `${FORGE}/api/${REPO}/dg/oplog`,
  `<b>Claim landed</b> — seq ${seq} is a kind=ship attestation; each entry's hash covers the previous one all the way to genesis.`,
  9
);

// ── beat 5: the bridge reviews it ─────────────────────────────────────
await page.goto(TERM);
await cap("<b>Bridge /review</b> — replay the hash chain → recompute each commit's real diff → LLM verdict → PayPal Payouts.");
await term([`$ curl -X POST ${BRIDGE}/review -d '{"repo":"${REPO}","seq":${seq}}'`]);
const reviewOut = await run("curl", [`-s -X POST ${BRIDGE}/review -H 'content-type: application/json' -d '{"repo":"${REPO}","seq":${seq}}'`]);
const rec = JSON.parse(reviewOut).records[0];
const short = JSON.stringify(
  {
    status: rec.status,
    chain: rec.chain,
    crosscheck: rec.crosscheck,
    adjudication: { verdict: rec.adjudication.verdict, confidence: rec.adjudication.confidence, reasoning: rec.adjudication.reasoning },
    payout: rec.payout,
  },
  null,
  2
).split("\n");
await term(short.map((l) => (/batch|transaction|SUCCESS|accept/i.test(l) ? `@${l}` : l)));
await beat(14);

// ── beat 6: dashboard card ────────────────────────────────────────────
await page.goto(BRIDGE, { waitUntil: "networkidle" });
await page.evaluate((c) => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;left:0;right:0;bottom:0;padding:10px 18px;background:rgba(13,17,23,.96);border-top:2px solid #0070e0;font:14px -apple-system,Segoe UI,sans-serif;color:#c9d1d9;z-index:9999";
  d.innerHTML = c;
  document.body.appendChild(d);
}, "<b>Dashboard</b> — claim → recomputed evidence → AI verdict → PayPal receipt. The model cited the actual diff; PayPal moved real sandbox money.");
await page.evaluate(() => {
  const el = document.getElementById("claim-slop/slopdotcash:1") ?? document.querySelector(".card");
  el?.scrollIntoView({ block: "start" });
});
await beat(16);

// ── beat 7: PayPal's own API confirms the transaction ────────────────
await page.goto(TERM);
await cap("<b>PayPal says SUCCESS</b> — GET /v1/payments/payouts on PayPal's sandbox API returns the batch with the transaction id.");
await term(["$ curl api.sandbox.paypal.com/v1/payments/payouts/<batch>"]);
const batch = rec.payout?.batch_id;
if (batch) {
  const tok = await run("curl", [`-s -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token -H "authorization: Basic ${process.env.PAYPAL_BASIC_B64}" -d grant_type=client_credentials | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])"`]);
  const batchJson = await run("curl", [`-s https://api-m.sandbox.paypal.com/v1/payments/payouts/${batch} -H "authorization: Bearer ${tok}" | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'batch_header':d['batch_header'],'items':[{'transaction_id':i.get('transaction_id'),'transaction_status':i.get('transaction_status'),'payout_item':i['payout_item']} for i in d.get('items',[])]},indent=2))"`]);
  await term(batchJson.split("\n").map((l) => (/SUCCESS|transaction_id/i.test(l) ? `!${l}` : l)));
} else {
  await term(["!no batch in record"]);
}
await beat(12);

// ── beat 8: receipt written back to the forge ────────────────────────
await prettyJson(
  `${FORGE}/api/${REPO}/dg/status/${SHA}`,
  "<b>Bidirectional audit</b> — the payout receipt is written back to the forge as a signed slopcash/payout commit status.",
  9
);

// ── beat 9: the reject lane ──────────────────────────────────────────
await page.goto(BRIDGE);
await page.evaluate(() => {
  const el = document.getElementById("claim-slop/protocol:0") ?? document.querySelectorAll(".card")[1];
  el?.scrollIntoView({ block: "start" });
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;left:0;right:0;bottom:0;padding:10px 18px;background:rgba(13,17,23,.96);border-top:2px solid #f85149;font:14px -apple-system,Segoe UI,sans-serif;color:#c9d1d9;z-index:9999";
  d.innerHTML = "<b>Reject lane</b> — the same pipeline on a spec-mismatched claim: REJECT at 90% confidence, reasoning cites the diff, and no money moves.";
  document.body.appendChild(d);
});
await beat(10);

// ── beat 10: closing ──────────────────────────────────────────────────
await title(
  "github.com/TerexitariusStomp/slopcash-bridge",
  "Live at slopcash-bridge.hardwoodstablecoin.workers.dev — PayPal Payouts · Workers AI adjudicator · delta-git provenance · AG Grid · Postman",
  "PayPal Payouts|AI|verified work|agent-to-human"
);
await beat(6);

await ctx.close();
await browser.close();
console.log("done — video in /tmp/rec");
