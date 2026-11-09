// market.test.mjs — unit tests for the WidespreadMarket contract, run
// against the REAL contract.src.js bundled by esbuild with a stubbed
// near-sdk-js runtime. node --test test/market.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { loadContract, setNear } from "./harness.mjs";

const SRC = new URL("../contracts/market/contract.src.js", import.meta.url).pathname;
const { Contract, near } = await loadContract(SRC, "WidespreadMarket");

const ONE = 10n ** 24n; // 1 NEAR in yocto

function setup({ payer = "payer.testnet", deposit = ONE, ts = 1_000_000_000n } = {}) {
  const c = new Contract();
  const transfers = setNear(near, { account: payer, deposit, timestamp: ts });
  return { c, transfers };
}

function createMarket(c, over = {}) {
  return c.createMarket({
    specHash: "sha256:spec", spec: "do the thing", deadline: null,
    acceptanceRule: "best", platformBps: 0, platformTo: null,
    payToHat: null, claimTtlNs: null, acceptanceHash: null,
    ...over,
  });
}

test("createMarket requires attached deposit", () => {
  const { c } = setup({ deposit: 0n });
  assert.throws(() => createMarket(c), /must be funded/);
});

test("createMarket caps platformBps at 50%", () => {
  const { c } = setup();
  assert.throws(() => createMarket(c, { platformBps: 5001 }), /platformBps/);
  const id = createMarket(c, { platformBps: 5000 });
  assert.equal(c.markets[id].platformBps, 5000);
});

test("createMarket stores spec/escrow/fee fields", () => {
  const { c } = setup();
  const id = createMarket(c, { platformBps: 1000, platformTo: "widespread-dao.near" });
  const m = c.markets[id];
  assert.equal(m.status, "open");
  assert.equal(m.locked, ONE.toString());
  assert.equal(m.payer, "payer.testnet");
  assert.equal(m.platformBps, 1000);
});

test("shipClaim is unbounded — 200 competing claims all land", () => {
  const { c } = setup();
  const id = createMarket(c);
  const ids = [];
  for (let i = 0; i < 200; i++) {
    ids.push(c.shipClaim({ marketId: id, claimHash: `h${i}`, actor: `a${i}`,
      commits: [], evidence: {}, claimant: `w${i}.testnet`, attested: i % 2 === 0 }));
  }
  assert.equal(c.getClaims({ marketId: id }).total, 200);
  assert.equal(c.getClaims({ marketId: id }).pending, 200);
});

test("shipClaim stamps forge identity + attestation + deadline", () => {
  const { c } = setup();
  const id = createMarket(c, { claimTtlNs: "1000000000" }); // 1s
  const cid = c.shipClaim({ marketId: id, claimHash: "h", actor: "agent",
    commits: ["abc"], evidence: {}, claimant: "", forgeId: "github",
    forgeUserId: "424242", relayer: "bridge", attested: true });
  const claim = c.claims[id].items[cid];
  assert.equal(claim.forgeUserId, "424242");
  assert.equal(claim.attested, true);
  assert.equal(claim.shippedBy, "payer.testnet"); // predecessor default
  assert.ok(BigInt(claim.claimDeadline) > BigInt(claim.ts));
});

test("shipClaim rejects closed markets", () => {
  const { c } = setup();
  const id = createMarket(c);
  c.refund({ marketId: id });
  assert.throws(() => c.shipClaim({ marketId: id, claimHash: "h" }), /not open/);
});

test("withdrawClaim: only shippedBy/claimant, only while pending", () => {
  const { c } = setup();
  const id = createMarket(c);
  const cid = c.shipClaim({ marketId: id, claimHash: "h", claimant: "victim.testnet" });
  setNear(near, { account: "random.testnet" });
  assert.throws(() => c.withdrawClaim({ marketId: id, claimId: cid }), /not your claim/);
  setNear(near, { account: "victim.testnet" });
  assert.equal(c.withdrawClaim({ marketId: id, claimId: cid }), true);
  assert.equal(c.claims[id].items[cid].status, "withdrawn");
});

test("cleanupExpired reaps stale pending claims", () => {
  const { c } = setup({ ts: 1_000n });
  const id = createMarket(c, { claimTtlNs: "100" }); // 100ns ttl
  c.shipClaim({ marketId: id, claimHash: "h" });
  setNear(near, { timestamp: 1_000_000n }); // far future
  const r = c.cleanupExpired({ marketId: id });
  assert.equal(r.reaped, 1);
  assert.equal(c.getClaims({ marketId: id }).pending, 0);
});

test("release: payer settles without oracle, splits locked correctly", () => {
  const { c, transfers } = setup();
  const id = createMarket(c, { platformBps: 1000, platformTo: "widespread-dao.near" });
  const cid = c.shipClaim({ marketId: id, claimHash: "win", claimant: "winner.testnet" });
  c.shipClaim({ marketId: id, claimHash: "lose", claimant: "loser.testnet" });
  // payer release — no verdictSig needed
  const r = c.release({ marketId: id, winningClaimId: cid });
  // transfers recorded under the release call's near ctx — re-set to capture:
  const pays = transfers.filter((t) => t.to !== "payer.testnet");
  assert.equal(r.paid, "winner.testnet");
  assert.equal(r.fee, (ONE * 200n / 10000n).toString());
  assert.equal(r.platformCut, (ONE * 1000n / 10000n).toString());
  assert.equal(r.net, (ONE - ONE * 200n / 10000n - ONE * 1000n / 10000n).toString());
  assert.equal(r.losers, 1);
  assert.equal(c.markets[id].status, "paid");
  assert.equal(c.claims[id].items[cid].status, "won");
  const loser = Object.values(c.claims[id].items).find((x) => x.claimHash === "lose");
  assert.equal(loser.status, "outcompeted");
});

test("release: oracle needs verdictSig + attested winner", () => {
  const { c } = setup();
  const id = createMarket(c);
  c.registerOracle({ pubkey: "oracle-pk" });
  const cid = c.shipClaim({ marketId: id, claimHash: "h", attested: false });
  setNear(near, { account: "oracle-signer.testnet" });
  // oracle without verdictSig → reject
  assert.throws(() => c.release({ marketId: id, oraclePubkey: "oracle-pk",
    winningClaimId: cid }), /verdict proof required/);
  // oracle on unattested claim → reject even with sig
  assert.throws(() => c.release({ marketId: id, oraclePubkey: "oracle-pk",
    verdictSig: "x".repeat(64), winningClaimId: cid }), /attested claims/);
});

test("release: oracle settles attested claim, bumps oracle verdicts", () => {
  const { c } = setup();
  const id = createMarket(c);
  c.registerOracle({ pubkey: "oracle-pk" });
  const cid = c.shipClaim({ marketId: id, claimHash: "h", claimant: "w.testnet", attested: true });
  setNear(near, { account: "oracle-signer.testnet" });
  const r = c.release({ marketId: id, oraclePubkey: "oracle-pk",
    verdictSig: "x".repeat(64), winningClaimId: cid });
  assert.equal(r.paid, "w.testnet");
  assert.equal(c.oracles["oracle-pk"].verdicts, 1);
});

test("release: random account cannot settle", () => {
  const { c } = setup();
  const id = createMarket(c);
  c.shipClaim({ marketId: id, claimHash: "h" });
  setNear(near, { account: "rando.testnet" });
  assert.throws(() => c.release({ marketId: id }), /payer sig or oracle/);
});

test("refund: payer pulls only with no pending claims; expired is permissionless", () => {
  const { c, transfers } = setup();
  const id = createMarket(c, { deadline: "999999999999999999999" }); // far future
  c.shipClaim({ marketId: id, claimHash: "h" });
  assert.throws(() => c.refund({ marketId: id }), /live with pending/);
  // payer refund with NO pending claims works while live
  const id3 = createMarket(c, { deadline: "999999999999999999999" });
  const r3 = c.refund({ marketId: id3 });
  assert.equal(r3.status, "refunded");
  // expired market: anyone can pull — null deadline never expires
  setNear(near, { account: "payer.testnet", deposit: ONE, timestamp: 1_000n });
  const id2 = createMarket(c, { deadline: "1" }); // epoch+1ns, long past
  setNear(near, { account: "rando.testnet", timestamp: 2_000_000_000_000n });
  const r = c.refund({ marketId: id2 });
  assert.equal(r.status, "expired");
  setNear(near, { account: "payer.testnet", deposit: ONE, timestamp: 1_000n });
  const id4 = createMarket(c, { deadline: null });
  setNear(near, { account: "rando.testnet", timestamp: 2_000_000_000_000n });
  assert.throws(() => c.refund({ marketId: id4 }), /live with pending|not open/);
});

test("getClaims paginates pending-first", () => {
  const { c } = setup();
  const id = createMarket(c);
  for (let i = 0; i < 5; i++) c.shipClaim({ marketId: id, claimHash: `h${i}` });
  const p1 = c.getClaims({ marketId: id, from: 0, limit: 3 });
  assert.equal(p1.claims.length, 3);
  assert.equal(p1.total, 5);
  const p2 = c.getClaims({ marketId: id, from: 3, limit: 3 });
  assert.equal(p2.claims.length, 2);
});

test("listOpen filters paid/refunded markets", () => {
  const { c } = setup();
  const open = createMarket(c);
  const paid = createMarket(c);
  c.shipClaim({ marketId: paid, claimHash: "h", claimant: "w" });
  c.release({ marketId: paid });
  const list = c.listOpen();
  assert.deepEqual(list.map((m) => m.marketId), [open]);
});
