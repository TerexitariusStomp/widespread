// futarchy.test.mjs — ForeguildFutarchy tests.
//
// ABI gate: the contract SOURCE's decorator table is parsed directly and
// compared against the fixture recorded from the previously-deployed
// bundle — a mismatch means the rebuilt ABI drifted. No contract runtime
// is loaded for the gate.
//
// Behavioral tests run on a REAL nearcore sandbox (near-workspaces):
// propose → buyShares → resolve → redeem with real deposits, real
// deadlines (real block timestamps), and real transfer receipts.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { deployContract, account, call, view, nowNs, stopSandbox } from "./sandbox.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../contracts/futarchy/contract.src.js"), "utf8");
const METHODS_H = join(here, "../contracts/futarchy/build/methods.h");
const FIXTURE = JSON.parse(
  readFileSync(join(here, "./fixtures/futarchy-methods.json"), "utf8"));

// ---- ABI gate (static source analysis — no runtime needed) ----

/** Parse `@call({…})` / `@view({…})` decorators + the method name that
 * follows each one, in source order. */
function decoratorTable(src) {
  const out = [];
  const re = /@(call|view)\(([^)]*)\)\s*\n\s*(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({
      name: m[3],
      kind: m[1],
      payableFunction: /payableFunction:\s*true/.test(m[2]),
      privateFunction: /privateFunction:\s*true/.test(m[2]),
    });
  }
  return out;
}

/** Constructor `this.x = …` assignments, in order — the contract's
 * persistent state fields. */
function stateFields(src) {
  const ctor = /constructor\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)?.[1] ?? "";
  const seen = new Set();
  const out = [];
  for (const m of ctor.matchAll(/this\.(\w+)\s*=/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

test("gate: decorator table equals the recorded bundle method list", () => {
  assert.deepEqual(decoratorTable(SRC), FIXTURE.methods);
});

test("gate: state fields equal the recorded bundle state", () => {
  assert.deepEqual(stateFields(SRC), FIXTURE.stateFields);
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

// ---- behavioral tests on the real sandbox ----

const HOUR_NS = 3600n * 1_000_000_000n;

async function fixture() {
  const contract = await deployContract("futarchy");
  const prop = await account("prop");
  const rando = await account("frando");
  return { contract, prop, rando };
}

function proposeArgs(over = {}) {
  return {
    title: "allocate fees", metricId: "near:settled_volume",
    threshold: "500", comparator: "gte", treasuryAction: null,
    // real future deadline — proposer can resolve early, others cannot
    deadline: (nowNs() + HOUR_NS).toString(),
    ...over,
  };
}

test("propose validates comparator and requires a deadline", async () => {
  const { contract, prop } = await fixture();
  await assert.rejects(
    call(prop, contract, "propose", proposeArgs({ comparator: "eq" })),
    /comparator must be gte\|lte/);
  await assert.rejects(
    call(prop, contract, "propose", proposeArgs({ deadline: null })),
    /deadline required/);
});

test("propose stores the proposal and zeroed pools; ids increment", async () => {
  const { contract, prop } = await fixture();
  const id = await call(prop, contract, "propose", proposeArgs());
  assert.equal(id, "1");
  assert.equal(await call(prop, contract, "propose", proposeArgs()), "2");
  const p = await view(contract, "getProposal", { proposalId: id });
  assert.equal(p.status, "open");
  assert.equal(p.proposer, prop.accountId);
  assert.equal(p.treasuryAction, null);
  assert.equal(p.resolution, null);
  assert.equal(typeof p.createdAt, "string");
  assert.deepEqual(await view(contract, "pools", { proposalId: id }),
    { yes: "0", no: "0" });
  assert.equal((await view(contract, "listProposals")).length, 2);
});

test("buyShares: deposits mint pro-rata shares, pools track deposits", async () => {
  const { contract, prop } = await fixture();
  const a = await account("ba");
  const b = await account("bb");
  const id = await call(prop, contract, "propose", proposeArgs());
  const r1 = await call(a, contract, "buyShares",
    { proposalId: id, side: "yes" }, { attachedDeposit: 100n });
  assert.deepEqual(r1, { side: "yes", minted: "100" });
  const r2 = await call(b, contract, "buyShares",
    { proposalId: id, side: "yes" }, { attachedDeposit: 50n });
  assert.equal(r2.minted, "50");
  await call(a, contract, "buyShares",
    { proposalId: id, side: "yes" }, { attachedDeposit: 30n });
  assert.deepEqual(await view(contract, "getShares",
    { proposalId: id, accountId: a.accountId }), { yes: "130", no: "0" });
  assert.deepEqual(await view(contract, "pools", { proposalId: id }),
    { yes: "180", no: "0" });
});

test("buyShares requires a deposit and an open proposal", async () => {
  const { contract, prop } = await fixture();
  const a = await account("ca");
  const id = await call(prop, contract, "propose", proposeArgs());
  await assert.rejects(
    call(a, contract, "buyShares", { proposalId: id, side: "yes" }),
    /attach NEAR/);
  await assert.rejects(
    call(a, contract, "buyShares", { proposalId: "99", side: "yes" },
      { attachedDeposit: 1n }),
    /proposal not open/);
});

test("buyShares treats any non-'yes' side as NO (bundle behaviour)", async () => {
  const { contract, prop } = await fixture();
  const a = await account("da");
  const id = await call(prop, contract, "propose", proposeArgs());
  await call(a, contract, "buyShares",
    { proposalId: id, side: "maybe" }, { attachedDeposit: 7n });
  assert.deepEqual(await view(contract, "pools", { proposalId: id }),
    { yes: "0", no: "7" });
});

test("resolve: only proposer before deadline, anyone after (real clock)", async () => {
  const { contract, prop, rando } = await fixture();
  const id = await call(prop, contract, "propose", proposeArgs());
  const args = { proposalId: id, metricValue: "600",
    evidenceHash: "sha256:markets-settled-0.6" };
  await assert.rejects(call(rando, contract, "resolve", args),
    /only proposer early/);

  // A proposal whose deadline is already past — real expired state.
  const past = await call(prop, contract, "propose",
    proposeArgs({ deadline: (nowNs() - 1n).toString() }));
  const r = await call(rando, contract, "resolve",
    { proposalId: past, metricValue: "600",
      evidenceHash: "sha256:markets-settled-0.6" });
  assert.equal(r.outcome, "yes");
  assert.equal(r.resolvedBy, rando.accountId);
  assert.equal((await view(contract, "getProposal",
    { proposalId: past })).status, "resolved");
  await assert.rejects(call(rando, contract, "resolve",
    { proposalId: past, metricValue: "600",
      evidenceHash: "sha256:markets-settled-0.6" }), /proposal not open/);
});

test("resolve requires an evidenceHash longer than 16 chars", async () => {
  const { contract, prop } = await fixture();
  const id = await call(prop, contract, "propose", proposeArgs());
  await assert.rejects(
    call(prop, contract, "resolve",
      { proposalId: id, metricValue: "1", evidenceHash: "sha256:short" }),
    /evidenceHash required/);
});

test("resolve: gte / lte comparators decide the outcome", async () => {
  const { contract, prop } = await fixture();
  const gte = await call(prop, contract, "propose",
    proposeArgs({ comparator: "gte", threshold: "500" }));
  const lte = await call(prop, contract, "propose",
    proposeArgs({ comparator: "lte", threshold: "500" }));
  const ev = "sha256:evidence-hash-xx";
  assert.equal((await call(prop, contract, "resolve",
    { proposalId: gte, metricValue: "500", evidenceHash: ev })).outcome, "yes");
  assert.equal((await call(prop, contract, "resolve",
    { proposalId: lte, metricValue: "501", evidenceHash: ev })).outcome, "no");
});

test("resolve: YES win executes the treasury action when balance covers it", async () => {
  const { contract, prop } = await fixture();
  const dao = await account("dao");
  // Fund the contract so the action is affordable: buy YES shares first.
  const funder = await account("tfunder");
  const id = await call(prop, contract, "propose",
    proposeArgs({ treasuryAction: { recipient: dao.accountId, amount: "100" } }));
  await call(funder, contract, "buyShares",
    { proposalId: id, side: "yes" }, { attachedDeposit: 200n });
  const before = BigInt((await dao.balance()).total);
  const r = await call(prop, contract, "resolve",
    { proposalId: id, metricValue: "999", evidenceHash: "sha256:evidence-hash-xx" });
  assert.equal(r.treasuryPaid, "100");
  // Real transfer receipt — poll the recipient balance.
  const deadline = Date.now() + 15000;
  let after = BigInt((await dao.balance()).total);
  while (after - before < 100n && Date.now() < deadline) {
    await new Promise((r2) => setTimeout(r2, 500));
    after = BigInt((await dao.balance()).total);
  }
  assert.equal(after - before, 100n);
});

test("resolve: treasury action silently skipped on insufficient balance or NO", async () => {
  const { contract, prop } = await fixture();
  const dao = await account("dao2");
  // Sandbox accounts start with 200 NEAR — an action above that can never
  // be covered by this contract's balance, so it must be skipped.
  const action = { recipient: dao.accountId, amount: "1000000000000000000000000000" }; // 1000 NEAR
  const a = await call(prop, contract, "propose",
    proposeArgs({ treasuryAction: action }));
  const b = await call(prop, contract, "propose",
    proposeArgs({ treasuryAction: { recipient: dao.accountId, amount: "50" } }));
  // Fund b's contract? Same contract — deposits are shared. Keep b's
  // amount tiny and force a NO outcome instead.
  const ra = await call(prop, contract, "resolve",
    { proposalId: a, metricValue: "999", evidenceHash: "sha256:evidence-hash-xx" });
  assert.equal(ra.treasuryPaid, undefined);
  const rb = await call(prop, contract, "resolve",
    { proposalId: b, metricValue: "1", evidenceHash: "sha256:evidence-hash-xx" });
  assert.equal(rb.outcome, "no");
  assert.equal(rb.treasuryPaid, undefined);
});

async function tradedAndResolved(contract, prop, metricValue) {
  const y1 = await account("ry1");
  const y2 = await account("ry2");
  const n1 = await account("rn1");
  const id = await call(prop, contract, "propose", proposeArgs());
  await call(y1, contract, "buyShares",
    { proposalId: id, side: "yes" }, { attachedDeposit: 60n });
  await call(y2, contract, "buyShares",
    { proposalId: id, side: "yes" }, { attachedDeposit: 20n });
  await call(n1, contract, "buyShares",
    { proposalId: id, side: "no" }, { attachedDeposit: 20n });
  await call(prop, contract, "resolve",
    { proposalId: id, metricValue, evidenceHash: "sha256:evidence-hash-xx" });
  return { id, y1, y2, n1 };
}

test("redeem requires a resolved proposal", async () => {
  const { contract, prop } = await fixture();
  const y1 = await account("uy1");
  const id = await call(prop, contract, "propose", proposeArgs());
  await assert.rejects(call(y1, contract, "redeem", { proposalId: id }),
    /proposal not resolved/);
});

test("redeem pays winners pro-rata from their pool, once", async () => {
  const { contract, prop } = await fixture();
  const { id, y1, y2 } = await tradedAndResolved(contract, prop, "600");
  // YES wins; yes pool 80 over 80 shares → y1 gets 60, y2 gets 20.
  assert.deepEqual(await call(y1, contract, "redeem", { proposalId: id }),
    { redeemed: "60", outcome: "yes" });
  assert.deepEqual(await call(y1, contract, "redeem", { proposalId: id }), {
    redeemed: "0", outcome: "yes", note: "already redeemed",
  });
  assert.equal((await call(y2, contract, "redeem", { proposalId: id })).redeemed, "20");
});

test("redeem: losing side gets nothing and is not marked redeemed", async () => {
  const { contract, prop } = await fixture();
  const { id, n1 } = await tradedAndResolved(contract, prop, "600");
  assert.deepEqual(await call(n1, contract, "redeem", { proposalId: id }),
    { redeemed: "0", outcome: "yes" });
  assert.equal((await view(contract, "getProposal",
    { proposalId: id })).resolution.outcome, "yes");
});

test("redeem: NO outcome pays the NO pool", async () => {
  const { contract, prop } = await fixture();
  const { id, n1 } = await tradedAndResolved(contract, prop, "100");
  assert.equal((await call(n1, contract, "redeem", { proposalId: id })).redeemed, "20");
});

test("fundTreasury / treasuryBalance report the account balance", async () => {
  const { contract, prop } = await fixture();
  const funder = await account("funder");
  await call(funder, contract, "fundTreasury", {}, { attachedDeposit: 5n });
  const bal = await view(contract, "treasuryBalance");
  assert.ok(BigInt(bal) > 0n);
  const r = await call(funder, contract, "fundTreasury", {}, { attachedDeposit: 1n });
  assert.equal(BigInt(r.balance), BigInt(bal) + 1n);
});

test("views on unknown proposals return defaults", async () => {
  const { contract } = await fixture();
  // getProposal returns undefined for unknown ids; JSON.stringify(undefined)
  // is itself undefined, so the SDK emits an empty result and nearcore
  // returns zero bytes — near-workspaces surfaces that as "".
  assert.equal(await view(contract, "getProposal", { proposalId: "9" }), "");
  assert.deepEqual(await view(contract, "getShares",
    { proposalId: "9", accountId: "x" }), { yes: "0", no: "0" });
});

// nearcore keeps the event loop alive — tear the sandbox down or the
// test process never exits.
after(async () => { await stopSandbox(); });
