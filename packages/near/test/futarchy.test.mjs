// futarchy.test.mjs — unit tests for the ForeguildFutarchy contract
// (propose → buy YES/NO shares → metric resolve → pro-rata redeem), plus
// the ABI gate: the source's decorator table must equal the method table
// recorded from the previously-deployed compiled bundle.
// Same esbuild+stub harness as market.test.mjs (decorators are recorded,
// not enforced — see near-sdk-js-stub.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { loadContract, setNear } from "./harness.mjs";

const SRC = new URL("../contracts/futarchy/contract.src.js", import.meta.url).pathname;
const METHODS_H = new URL("../contracts/futarchy/build/methods.h", import.meta.url);
const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/futarchy-methods.json", import.meta.url), "utf8")
);
const { Contract, near } = await loadContract(SRC, "ForeguildFutarchy");

const ONE = 10n ** 24n; // 1 NEAR in yocto
const DEADLINE = 2_000_000_000n; // ns; harness default block time is 1e9

/** Set caller context; `balance` feeds near.accountBalance(). */
function as(account, { deposit = 0n, ts = 1_000_000_000n, balance = 0n } = {}) {
  const transfers = setNear(near, { account, deposit, timestamp: ts });
  near.accountBalance = () => balance;
  return transfers;
}

function propose(c, over = {}) {
  as("prop.testnet");
  return c.propose({
    title: "allocate fees", metricId: "near:settled_volume",
    threshold: "500", comparator: "gte", treasuryAction: null,
    deadline: DEADLINE.toString(), ...over,
  });
}

// ---- ABI gate ----

test("gate: decorator table equals the recorded bundle method list", () => {
  assert.deepEqual(Contract.__nearMethods, FIXTURE.methods);
});

test("gate: state fields equal the recorded bundle state", () => {
  assert.deepEqual(Object.keys(new Contract()), FIXTURE.stateFields);
});

test("gate: compiled wasm exports equal the recorded bundle exports", (t) => {
  if (!existsSync(METHODS_H)) {
    t.skip("build/methods.h absent — run `pnpm --filter @widespread/near build`");
    return;
  }
  const exported = readFileSync(METHODS_H, "utf8")
    .split("\n")
    .map((l) => /^DEFINE_NEAR_METHOD\((\w+)\)/.exec(l)?.[1])
    .filter(Boolean)
    .sort();
  assert.deepEqual(exported, [...FIXTURE.wasmExports].sort());
});

// ---- propose ----

test("propose validates comparator and requires a deadline", () => {
  const c = new Contract();
  assert.throws(() => propose(c, { comparator: "eq" }), /comparator must be gte\|lte/);
  assert.throws(() => propose(c, { deadline: null }), /deadline required/);
});

test("propose stores the proposal and zeroed pools; ids increment", () => {
  const c = new Contract();
  const id = propose(c);
  assert.equal(id, "1");
  assert.equal(propose(c), "2");
  const p = c.getProposal({ proposalId: id });
  assert.equal(p.status, "open");
  assert.equal(p.proposer, "prop.testnet");
  assert.equal(p.treasuryAction, null);
  assert.equal(p.resolution, null);
  assert.equal(p.createdAt, "1000000000");
  assert.deepEqual(c.pools({ proposalId: id }), { yes: "0", no: "0" });
  assert.equal(c.listProposals().length, 2);
});

// ---- buyShares ----

test("buyShares: first buy is 1:1, later buys mint pro-rata", () => {
  const c = new Contract();
  const id = propose(c);
  as("a.testnet", { deposit: 100n });
  assert.deepEqual(c.buyShares({ proposalId: id, side: "yes" }), { side: "yes", minted: "100" });
  as("b.testnet", { deposit: 50n });
  assert.equal(c.buyShares({ proposalId: id, side: "yes" }).minted, "50");
  as("a.testnet", { deposit: 30n });
  c.buyShares({ proposalId: id, side: "yes" });
  assert.deepEqual(c.getShares({ proposalId: id, accountId: "a.testnet" }), { yes: "130", no: "0" });
  assert.deepEqual(c.pools({ proposalId: id }), { yes: "180", no: "0" });
});

test("buyShares requires a deposit and an open proposal", () => {
  const c = new Contract();
  const id = propose(c);
  as("a.testnet", { deposit: 0n });
  assert.throws(() => c.buyShares({ proposalId: id, side: "yes" }), /attach NEAR/);
  as("a.testnet", { deposit: 1n });
  assert.throws(() => c.buyShares({ proposalId: "99", side: "yes" }), /proposal not open/);
});

test("buyShares treats any non-'yes' side as NO (bundle behaviour)", () => {
  const c = new Contract();
  const id = propose(c);
  as("a.testnet", { deposit: 7n });
  c.buyShares({ proposalId: id, side: "maybe" });
  assert.deepEqual(c.pools({ proposalId: id }), { yes: "0", no: "7" });
});

// ---- resolve ----

test("resolve: only proposer before deadline, anyone after", () => {
  const c = new Contract();
  const id = propose(c);
  const args = { proposalId: id, metricValue: "600", evidenceHash: "sha256:markets-settled-0.6" };
  as("rando.testnet");
  assert.throws(() => c.resolve(args), /only proposer early/);
  as("rando.testnet", { ts: DEADLINE + 1n });
  const r = c.resolve(args);
  assert.equal(r.outcome, "yes");
  assert.equal(r.resolvedBy, "rando.testnet");
  assert.equal(c.getProposal({ proposalId: id }).status, "resolved");
  assert.throws(() => c.resolve(args), /proposal not open/);
});

test("resolve requires an evidenceHash longer than 16 chars", () => {
  const c = new Contract();
  const id = propose(c);
  as("prop.testnet");
  assert.throws(
    () => c.resolve({ proposalId: id, metricValue: "1", evidenceHash: "sha256:short" }),
    /evidenceHash required/
  );
});

test("resolve: gte / lte comparators decide the outcome", () => {
  const c = new Contract();
  const gte = propose(c, { comparator: "gte", threshold: "500" });
  const lte = propose(c, { comparator: "lte", threshold: "500" });
  as("prop.testnet");
  const ev = "sha256:evidence-hash-xx";
  assert.equal(c.resolve({ proposalId: gte, metricValue: "500", evidenceHash: ev }).outcome, "yes");
  assert.equal(c.resolve({ proposalId: lte, metricValue: "501", evidenceHash: ev }).outcome, "no");
});

test("resolve: YES win executes the treasury action when balance covers it", () => {
  const c = new Contract();
  const id = propose(c, { treasuryAction: { recipient: "dao.testnet", amount: ONE.toString() } });
  const transfers = as("prop.testnet", { balance: 2n * ONE });
  const r = c.resolve({ proposalId: id, metricValue: "999", evidenceHash: "sha256:evidence-hash-xx" });
  assert.equal(r.treasuryPaid, ONE.toString());
  assert.deepEqual(transfers, [{ to: "dao.testnet", amount: ONE }]);
});

test("resolve: treasury action silently skipped on insufficient balance or NO", () => {
  const c = new Contract();
  const action = { recipient: "dao.testnet", amount: ONE.toString() };
  const a = propose(c, { treasuryAction: action });
  const b = propose(c, { treasuryAction: action });
  let transfers = as("prop.testnet", { balance: ONE - 1n });
  const ra = c.resolve({ proposalId: a, metricValue: "999", evidenceHash: "sha256:evidence-hash-xx" });
  assert.equal(ra.treasuryPaid, undefined);
  assert.equal(transfers.length, 0);
  transfers = as("prop.testnet", { balance: 2n * ONE });
  const rb = c.resolve({ proposalId: b, metricValue: "1", evidenceHash: "sha256:evidence-hash-xx" });
  assert.equal(rb.outcome, "no");
  assert.equal(transfers.length, 0);
});

// ---- redeem ----

function tradedAndResolved(c, metricValue) {
  const id = propose(c);
  as("y1.testnet", { deposit: 60n }); c.buyShares({ proposalId: id, side: "yes" });
  as("y2.testnet", { deposit: 20n }); c.buyShares({ proposalId: id, side: "yes" });
  as("n1.testnet", { deposit: 20n }); c.buyShares({ proposalId: id, side: "no" });
  as("prop.testnet");
  c.resolve({ proposalId: id, metricValue, evidenceHash: "sha256:evidence-hash-xx" });
  return id;
}

test("redeem requires a resolved proposal", () => {
  const c = new Contract();
  const id = propose(c);
  as("y1.testnet");
  assert.throws(() => c.redeem({ proposalId: id }), /proposal not resolved/);
});

test("redeem pays winners pro-rata from their pool, once", () => {
  const c = new Contract();
  const id = tradedAndResolved(c, "600"); // YES wins; yes pool 80 over 80 shares
  let transfers = as("y1.testnet");
  assert.deepEqual(c.redeem({ proposalId: id }), { redeemed: "60", outcome: "yes" });
  assert.deepEqual(transfers, [{ to: "y1.testnet", amount: 60n }]);
  transfers = as("y1.testnet");
  assert.deepEqual(c.redeem({ proposalId: id }), {
    redeemed: "0", outcome: "yes", note: "already redeemed",
  });
  assert.equal(transfers.length, 0);
  as("y2.testnet");
  assert.equal(c.redeem({ proposalId: id }).redeemed, "20");
});

test("redeem: losing side gets nothing and is not marked redeemed", () => {
  const c = new Contract();
  const id = tradedAndResolved(c, "600");
  const transfers = as("n1.testnet");
  assert.deepEqual(c.redeem({ proposalId: id }), { redeemed: "0", outcome: "yes" });
  assert.equal(transfers.length, 0);
  assert.equal(c.redeemed[id]["n1.testnet"], undefined);
});

test("redeem: NO outcome pays the NO pool", () => {
  const c = new Contract();
  const id = tradedAndResolved(c, "100");
  as("n1.testnet");
  assert.equal(c.redeem({ proposalId: id }).redeemed, "20");
});

// ---- treasury views ----

test("fundTreasury / treasuryBalance report the account balance", () => {
  const c = new Contract();
  as("payer.testnet", { deposit: ONE, balance: 3n * ONE });
  assert.deepEqual(c.fundTreasury(), { balance: (3n * ONE).toString() });
  assert.equal(c.treasuryBalance(), (3n * ONE).toString());
});

test("views on unknown proposals return defaults", () => {
  const c = new Contract();
  assert.equal(c.getProposal({ proposalId: "9" }), undefined);
  assert.deepEqual(c.getShares({ proposalId: "9", accountId: "x" }), { yes: "0", no: "0" });
  assert.deepEqual(c.pools({ proposalId: "9" }), { yes: undefined, no: undefined });
});
