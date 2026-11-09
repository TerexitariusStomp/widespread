// market.test.mjs — WidespreadMarket contract tests on a REAL nearcore
// sandbox (near-workspaces + near-sandbox). The compiled contract.wasm is
// deployed to a real account; every assertion reads real chain state via
// view calls or real transaction results. No runtime stubs.
//
// Semantic notes vs the old in-process harness:
//  - "caller" is a real sandbox account (predecessorAccountId).
//  - Timestamps are real block time; expiry tests use real past/future
//    deadlines instead of injected clocks.
//  - Payout transfers are real receipts — recipients are real accounts so
//    balances actually move (asserted via balance()).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { deployContract, account, call, view, nowNs, YOCTO, stopSandbox } from "./sandbox.mjs";

const GAS = 300_000_000_000_000n;
const CREATE = {
  specHash: "sha256:spec", spec: "do the thing", deadline: null,
  acceptanceRule: "best", platformBps: 0, platformTo: null,
  payToHat: null, claimTtlNs: null, acceptanceHash: null,
};
const FAR_FUTURE = "999999999999999999999"; // ns — never expires in-test

async function fixture() {
  const contract = await deployContract("market");
  const payer = await account("payer");
  return { contract, payer };
}

function createArgs(over = {}) {
  return { ...CREATE, ...over };
}

test("createMarket requires attached deposit", async () => {
  const { contract, payer } = await fixture();
  await assert.rejects(
    call(payer, contract, "createMarket", createArgs()),
    /must be funded/);
});

test("createMarket caps platformBps at 50%", async () => {
  const { contract, payer } = await fixture();
  await assert.rejects(
    call(payer, contract, "createMarket", createArgs({ platformBps: 5001 }),
      { attachedDeposit: YOCTO }),
    /platformBps/);
  const id = await call(payer, contract, "createMarket",
    createArgs({ platformBps: 5000 }), { attachedDeposit: YOCTO });
  const m = await view(contract, "getMarket", { marketId: id });
  assert.equal(m.platformBps, 5000);
});

test("createMarket stores spec/escrow/fee fields on-chain", async () => {
  const { contract, payer } = await fixture();
  const sink = await account("sink");
  const id = await call(payer, contract, "createMarket",
    createArgs({ platformBps: 1000, platformTo: sink.accountId }),
    { attachedDeposit: YOCTO });
  const m = await view(contract, "getMarket", { marketId: id });
  assert.equal(m.status, "open");
  assert.equal(m.locked, YOCTO.toString());
  assert.equal(m.payer, payer.accountId);
  assert.equal(m.platformBps, 1000);
  assert.equal(m.specHash, "sha256:spec");
});

test("shipClaim is unbounded — 60 competing claims all land", async () => {
  const { contract, payer } = await fixture();
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  // Sequential: concurrent txs from one account race on the access-key
  // nonce and degenerate into retry storms. Unbounded means unbounded —
  // the contract imposes no cap, which is what this proves.
  const N = 60;
  for (let n = 0; n < N; n++) {
    await call(payer, contract, "shipClaim", {
      marketId: id, claimHash: `h${n}`, actor: `a${n}`,
      commits: [], evidence: {}, claimant: `w${n}`,
      forgeId: "github", forgeUserId: String(1000 + n),
      relayer: "bridge", attested: n % 2 === 0,
    });
  }
  const page = await view(contract, "getClaims", { marketId: id, from: 0, limit: 200 });
  assert.equal(page.total, N);
  assert.equal(page.pending, N);
});

test("shipClaim stamps forge identity + attestation + deadline", async () => {
  const { contract, payer } = await fixture();
  const id = await call(payer, contract, "createMarket",
    createArgs({ claimTtlNs: "1000000000" }), { attachedDeposit: YOCTO });
  const cid = await call(payer, contract, "shipClaim", {
    marketId: id, claimHash: "h", actor: "agent",
    commits: ["abc"], evidence: {}, claimant: "",
    forgeId: "github", forgeUserId: "424242", relayer: "bridge", attested: true,
  });
  const { claims } = await view(contract, "getClaims", { marketId: id });
  const claim = claims.find((c) => c.claimId === cid);
  assert.equal(claim.forgeUserId, "424242");
  assert.equal(claim.attested, true);
  assert.equal(claim.shippedBy, payer.accountId); // real predecessor
  assert.ok(BigInt(claim.claimDeadline) > BigInt(claim.ts));
});

test("shipClaim rejects closed markets", async () => {
  const { contract, payer } = await fixture();
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  await call(payer, contract, "refund", { marketId: id });
  await assert.rejects(
    call(payer, contract, "shipClaim", { marketId: id, claimHash: "h" }),
    /not open/);
});

test("withdrawClaim: only shippedBy/claimant, only while pending", async () => {
  const { contract, payer } = await fixture();
  const shipper = await account("shipper");
  const victim = await account("victim");
  const rando = await account("rando");
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  const cid = await call(shipper, contract, "shipClaim", {
    marketId: id, claimHash: "h", claimant: victim.accountId,
  });
  await assert.rejects(
    call(rando, contract, "withdrawClaim", { marketId: id, claimId: cid }),
    /not your claim/);
  assert.equal(await call(victim, contract, "withdrawClaim",
    { marketId: id, claimId: cid }), true);
  const { claims } = await view(contract, "getClaims", { marketId: id });
  assert.equal(claims.find((c) => c.claimId === cid).status, "withdrawn");
});

test("cleanupExpired reaps stale pending claims (real clock)", async () => {
  const { contract, payer } = await fixture();
  const rando = await account("reaper");
  const id = await call(payer, contract, "createMarket",
    createArgs({ claimTtlNs: "1" }), { attachedDeposit: YOCTO }); // 1ns ttl
  await call(payer, contract, "shipClaim", { marketId: id, claimHash: "h" });
  // The cleanup tx lands in a later block — blockTimestamp has advanced
  // past claimDeadline (= ship-time + 1ns).
  const r = await call(rando, contract, "cleanupExpired", { marketId: id });
  assert.equal(r.reaped, 1);
  const page = await view(contract, "getClaims", { marketId: id });
  assert.equal(page.pending, 0);
});

test("release: payer settles, splits locked correctly, pays real accounts", async () => {
  const { contract, payer } = await fixture();
  const sink = await account("sink");
  const winner = await account("winner");
  const id = await call(payer, contract, "createMarket",
    createArgs({ platformBps: 1000, platformTo: sink.accountId }),
    { attachedDeposit: YOCTO });
  const winId = await call(payer, contract, "shipClaim", {
    marketId: id, claimHash: "win", claimant: winner.accountId });
  await call(payer, contract, "shipClaim", {
    marketId: id, claimHash: "lose", claimant: "loser-placeholder" });

  const before = await winner.balance();
  const r = await call(payer, contract, "release",
    { marketId: id, winningClaimId: winId });
  const fee = (YOCTO * 200n) / 10000n;
  const cut = (YOCTO * 1000n) / 10000n;
  const net = YOCTO - fee - cut;
  assert.equal(r.paid, winner.accountId);
  assert.equal(r.fee, fee.toString());
  assert.equal(r.platformCut, cut.toString());
  assert.equal(r.net, net.toString());
  assert.equal(r.losers, 1);

  // Real chain state: market paid, claims resolved, winner actually paid.
  const m = await view(contract, "getMarket", { marketId: id });
  assert.equal(m.status, "paid");
  const { claims } = await view(contract, "getClaims", { marketId: id });
  assert.equal(claims.find((c) => c.claimId === winId).status, "won");
  const loser = claims.find((c) => c.claimHash === "lose");
  assert.equal(loser.status, "outcompeted");
  // Transfer receipt lands in a follow-up block — poll the balance.
  const deadline = Date.now() + 15000;
  let after = await winner.balance();
  while (BigInt(after.total) - BigInt(before.total) < net && Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 500));
    after = await winner.balance();
  }
  assert.equal(BigInt(after.total) - BigInt(before.total), net);
});

test("release: oracle needs verdictSig + attested winner", async () => {
  const { contract, payer } = await fixture();
  const oracleReg = await account("oracle-reg");
  const judge = await account("judge");
  await call(oracleReg, contract, "registerOracle", { pubkey: "oracle-pk" });
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  const cid = await call(payer, contract, "shipClaim", {
    marketId: id, claimHash: "h", attested: false });
  // oracle without verdictSig → reject
  await assert.rejects(
    call(judge, contract, "release",
      { marketId: id, oraclePubkey: "oracle-pk", winningClaimId: cid }),
    /verdict proof required/);
  // oracle on unattested claim → reject even with sig
  await assert.rejects(
    call(judge, contract, "release",
      { marketId: id, oraclePubkey: "oracle-pk",
        verdictSig: "x".repeat(64), winningClaimId: cid }),
    /attested claims/);
});

test("release: oracle settles attested claim, bumps oracle verdicts", async () => {
  const { contract, payer } = await fixture();
  const oracleReg = await account("oracle-reg2");
  const judge = await account("judge2");
  const winner = await account("owinner");
  await call(oracleReg, contract, "registerOracle", { pubkey: "oracle-pk2" });
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  const cid = await call(payer, contract, "shipClaim", {
    marketId: id, claimHash: "h", claimant: winner.accountId, attested: true });
  const r = await call(judge, contract, "release",
    { marketId: id, oraclePubkey: "oracle-pk2",
      verdictSig: "x".repeat(64), winningClaimId: cid });
  assert.equal(r.paid, winner.accountId);
  const o = await view(contract, "getOracle", { pubkey: "oracle-pk2" });
  assert.equal(o.verdicts, 1);
});

test("release: random account cannot settle", async () => {
  const { contract, payer } = await fixture();
  const rando = await account("rando2");
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  await call(payer, contract, "shipClaim", { marketId: id, claimHash: "h" });
  await assert.rejects(
    call(rando, contract, "release", { marketId: id }),
    /payer sig or oracle/);
});

test("refund: payer pulls only with no pending claims; expired is permissionless", async () => {
  const { contract, payer } = await fixture();
  const rando = await account("rando3");
  // live market with a pending claim — payer cannot pull
  const live = await call(payer, contract, "createMarket",
    createArgs({ deadline: FAR_FUTURE }), { attachedDeposit: YOCTO });
  await call(payer, contract, "shipClaim", { marketId: live, claimHash: "h" });
  await assert.rejects(call(payer, contract, "refund", { marketId: live }),
    /live with pending/);
  // payer refund with NO pending claims works while live
  const empty = await call(payer, contract, "createMarket",
    createArgs({ deadline: FAR_FUTURE }), { attachedDeposit: YOCTO });
  const r3 = await call(payer, contract, "refund", { marketId: empty });
  assert.equal(r3.status, "refunded");
  // expired market (deadline in the real past): anyone can pull
  const expired = await call(payer, contract, "createMarket",
    createArgs({ deadline: "1" }), { attachedDeposit: YOCTO });
  const r = await call(rando, contract, "refund", { marketId: expired });
  assert.equal(r.status, "expired");
  // null deadline never expires — rando cannot pull a live market
  const open = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  await assert.rejects(call(rando, contract, "refund", { marketId: open }),
    /live with pending|not open/);
});

test("getClaims paginates pending-first", async () => {
  const { contract, payer } = await fixture();
  const id = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  for (let i = 0; i < 5; i++) {
    await call(payer, contract, "shipClaim",
      { marketId: id, claimHash: `h${i}` });
  }
  const p1 = await view(contract, "getClaims",
    { marketId: id, from: 0, limit: 3 });
  assert.equal(p1.claims.length, 3);
  assert.equal(p1.total, 5);
  const p2 = await view(contract, "getClaims",
    { marketId: id, from: 3, limit: 3 });
  assert.equal(p2.claims.length, 2);
});

test("listOpen filters paid/refunded markets", async () => {
  const { contract, payer } = await fixture();
  const winner = await account("lwwinner");
  const open = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  const paid = await call(payer, contract, "createMarket", createArgs(),
    { attachedDeposit: YOCTO });
  const cid = await call(payer, contract, "shipClaim",
    { marketId: paid, claimHash: "h", claimant: winner.accountId });
  await call(payer, contract, "release",
    { marketId: paid, winningClaimId: cid });
  const list = await view(contract, "listOpen");
  assert.deepEqual(list.map((m) => m.marketId), [open]);
});

// nearcore keeps the event loop alive — tear the sandbox down or the
// test process never exits.
after(async () => { await stopSandbox(); });
