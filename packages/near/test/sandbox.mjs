// sandbox.mjs — real NEAR sandbox harness via near-workspaces.
// Boots an actual nearcore process (near-sandbox binary), creates real
// accounts, deploys the real compiled contract.wasm, and exposes typed
// call/view helpers. One sandbox per test-file process (node --test runs
// each file in its own process); the worker is torn down on process exit.

import { Worker } from "near-workspaces";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const GAS = 300_000_000_000_000n; // 300 Tgas — NEAR per-tx ceiling
export const YOCTO = 10n ** 24n; // 1 NEAR

let workerPromise = null;

/** The shared sandbox worker for this test process. */
export function sandbox() {
  if (!workerPromise) {
    workerPromise = Worker.init({ network: "sandbox" })
      .then((w) => w);
  }
  return workerPromise;
}

/** Tear down nearcore so the test process can exit. near-workspaces keeps
 * the spawned nearcore process + RPC client alive, which otherwise leaves
 * the event loop pending forever. Call from an `after()` hook. */
export async function stopSandbox() {
  if (!workerPromise) return;
  const w = await workerPromise;
  workerPromise = null;
  try { await w.tearDown(); } catch { /* already gone */ }
}

const wasmCache = new Map();

/** Deploy contracts/<name>/build/contract.wasm to a fresh dev account.
 * Returns the contract's NearAccount — call `acct.view(method, args)` for
 * views and `otherAcct.call(acct, method, args, opts)` for transactions. */
export async function deployContract(name) {
  const w = await sandbox();
  if (!wasmCache.has(name)) {
    const wasm = join(here, `../contracts/${name}/build/contract.wasm`);
    wasmCache.set(name, readFileSync(wasm));
  }
  return w.rootAccount.devDeploy(wasmCache.get(name));
}

const accountCache = new Map();

/** Named subaccount of root — deterministic ids are fine because each
 * test file gets a fresh sandbox. Accounts are cached per process so
 * repeated fixture() calls reuse the same real account instead of
 * failing on duplicate creation. */
export async function account(name) {
  if (!accountCache.has(name)) {
    const w = await sandbox();
    accountCache.set(name, await w.rootAccount.createSubAccount(name));
  }
  return accountCache.get(name);
}

/** Convenience: call a contract method as `who` with optional deposit. */
export function call(who, contract, method, args = {}, opts = {}) {
  return who.call(contract, method, args, { gas: GAS, ...opts });
}

/** View a contract method. */
export function view(contract, method, args = {}) {
  return contract.view(method, args);
}

/** Current block timestamp in ns — matches near.blockTimestamp(). */
export function nowNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

/** Poll a view until `pred` passes or the deadline hits — used for
 * async promise callbacks (e.g. hats sigCallback after the MPC leg). */
export async function waitForView(contract, method, args, pred, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await contract.view(method, args);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitForView ${method} timed out; last=${JSON.stringify(last)}`);
}
