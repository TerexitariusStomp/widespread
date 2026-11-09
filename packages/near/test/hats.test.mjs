// hats.test.mjs — IntentionalHats contract tests on a REAL nearcore
// sandbox. Org→hat tree, scoped capabilities, foreign-sig requests (the
// MPC leg runs for real: v1.signer doesn't exist on sandbox, so the
// promise callback lands as a real "failed" status), and payout receipts.
// No runtime stubs — every call is a real transaction, every view a real
// RPC query.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { deployContract, account, call, view, waitForView, stopSandbox } from "./sandbox.mjs";

const GAS = 300_000_000_000_000n;

async function fixture() {
  const contract = await deployContract("hats");
  const alice = await account("alice");
  const rando = await account("rando");
  const bob = await account("bob");
  return { contract, alice, rando, bob };
}

async function org(contract, alice, name = "acme") {
  const { orgId, topHatId } = await call(alice, contract, "createOrg", { name });
  return { orgId, topHatId };
}

test("createOrg mints org + top hat worn by creator with * scope", async () => {
  const { contract, alice } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const hat = await view(contract, "getHat", { hatId: topHatId });
  assert.equal(hat.wearer, alice.accountId);
  assert.deepEqual(hat.permissions, ["*"]);
  assert.equal(hat.parentHatId, null);
  assert.equal((await view(contract, "getOrg", { orgId })).name, "acme");
});

test("createHat: parent wearer mints child; stranger cannot", async () => {
  const { contract, alice, rando } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "worker",
    permissions: ["market:claim"],
  });
  assert.equal((await view(contract, "getHat", { hatId: child })).adminHatId, topHatId);
  assert.equal((await view(contract, "getHat", { hatId: child })).accountableTo, topHatId);
  await assert.rejects(
    call(rando, contract, "createHat",
      { orgId, parentHatId: child, name: "x" }),
    /lacks authority/);
});

test("revocation is accountability-based: parent revokes child, child cannot revoke parent", async () => {
  const { contract, alice, bob } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "worker", permissions: [],
  });
  // hand the child hat to bob
  await call(alice, contract, "assignHat", { hatId: child, wearer: bob.accountId });
  // bob (child wearer) cannot revoke the top hat
  await assert.rejects(
    call(bob, contract, "revokeHat", { hatId: topHatId }),
    /cannot revoke/);
  // alice (top wearer) revokes the child
  assert.equal(await call(alice, contract, "revokeHat",
    { hatId: child, reason: "misuse" }), true);
  assert.equal((await view(contract, "getHat", { hatId: child })).status, "revoked");
  // revoked hat rejects further use
  await assert.rejects(
    call(bob, contract, "setStance", { hatId: child, prefs: {} }),
    /revoked/);
});

test("setForeign is wearer-only; requestForeignSig enforces sign:<chain> scope", async () => {
  const { contract, alice, rando } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "solver",
    permissions: ["sign:solana"],
  });
  // stranger cannot set foreign identity
  await assert.rejects(
    call(rando, contract, "setForeign",
      { hatId: child, chain: "solana", path: "m/44'" }),
    /only the wearer/);
  // wearer sets it, then requests a sig — real MPC promise to v1.signer
  await call(alice, contract, "setForeign",
    { hatId: child, chain: "solana", path: "m/44'/501'", keyType: "ed25519" });
  const sigId = await call(alice, contract, "requestForeignSig",
    { hatId: child, payload: [1, 2, 3] });
  assert.equal(typeof sigId, "string");
  // The request recorded real state; the v1.signer account does not exist
  // on the sandbox, so the promiseThen callback lands as a real failure.
  const sig = await waitForView(contract, "getSig", { sigId },
    (s) => s && s.status !== "requested", { timeoutMs: 30000 });
  assert.equal(sig.status, "failed"); // v1.signer-prod.testnet absent on sandbox
  assert.ok(sig.error);
});

test("requestForeignSig rejects missing scope", async () => {
  const { contract, alice } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "noob",
    permissions: ["market:claim"],
  });
  await call(alice, contract, "setForeign",
    { hatId: child, chain: "solana", path: "p" });
  await assert.rejects(
    call(alice, contract, "requestForeignSig", { hatId: child, payload: [9] }),
    /lacks scope: sign:solana/);
});

test("sigCallback resolves the real promise result (MPC failure path)", async () => {
  const { contract, alice } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "s", permissions: ["*"],
  });
  await call(alice, contract, "setForeign",
    { hatId: child, chain: "near", path: "p" });
  // `*` scope covers sign:near — the request goes out; the callback is
  // scheduled by the contract itself and records the real outcome.
  const sigId = await call(alice, contract, "requestForeignSig",
    { hatId: child, payload: [7] });
  const sig = await waitForView(contract, "getSig", { sigId },
    (s) => s && s.status !== "requested", { timeoutMs: 30000 });
  assert.ok(["signed", "failed"].includes(sig.status),
    `unexpected sig status ${sig.status}`);
});

test("requestPayout: treasury:pay scope or top hat required", async () => {
  const { contract, alice, bob } = await fixture();
  const cfo = await account("cfo");
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "treasury",
    permissions: ["treasury:pay"],
  });
  await call(alice, contract, "assignHat", { hatId: child, wearer: cfo.accountId });
  const pid = await call(cfo, contract, "requestPayout", {
    hatId: child, assetIn: "USDC", assetOut: "PYUSD",
    destChain: "solana", recipient: "So1ana",
  });
  assert.equal((await view(contract, "getPayout", { payoutId: pid })).status, "requested");
  // confirm by requester
  assert.equal(await call(cfo, contract, "confirmPayout",
    { payoutId: pid, txHash: "0xabc" }), true);
  assert.equal((await view(contract, "getPayout", { payoutId: pid })).status, "settled");
  // no-scope hat cannot request
  const weak = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "weak",
    permissions: ["market:claim"],
  });
  await call(alice, contract, "assignHat", { hatId: weak, wearer: bob.accountId });
  await assert.rejects(
    call(bob, contract, "requestPayout", {
      hatId: weak, assetIn: "a", assetOut: "b", destChain: "c", recipient: "d",
    }), /treasury:pay/);
});

test("hasScope reflects permissions", async () => {
  const { contract, alice } = await fixture();
  const { orgId, topHatId } = await org(contract, alice);
  const child = await call(alice, contract, "createHat", {
    orgId, parentHatId: topHatId, name: "h",
    permissions: ["verify:adjudicate"],
  });
  assert.equal(await view(contract, "hasScope",
    { hatId: child, scope: "verify:adjudicate" }), true);
  assert.equal(await view(contract, "hasScope",
    { hatId: child, scope: "treasury:pay" }), false);
  assert.equal(await view(contract, "hasScope",
    { hatId: topHatId, scope: "anything" }), true); // *
});

// nearcore keeps the event loop alive — tear the sandbox down or the
// test process never exits.
after(async () => { await stopSandbox(); });
