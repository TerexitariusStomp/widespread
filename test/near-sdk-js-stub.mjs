// near-sdk-js stub — just enough surface for contract.src.js to load and
// run under plain Node. `near` is a shared mutable context on globalThis
// so the harness and the bundled contract see the same object.

export const near = (globalThis.__NEAR_CTX ??= {});

// Default no-op surfaces used by the hats contract (MPC sig requests,
// promise chaining, logging). Tests override per-call via setNear or by
// setting near.__promiseResults / near.__calls.
near.log ??= () => {};
near.currentAccountId ??= () => "contract.testnet";
near.promiseBatchActionFunctionCall ??= () => {};
near.promiseThen ??= () => 0;
near.promiseResult ??= () => (near.__promiseResults ?? []).shift() ?? null;
near.__calls ??= [];
const _fnCall = near.promiseBatchActionFunctionCall;
near.promiseBatchActionFunctionCall = (...a) => { near.__calls.push({ fn: a }); return _fnCall(...a); };

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// Decorators are metadata-only for our purposes — pass through.
export function NearBindgen() { return (cls) => cls; }
export function call() { return (_t, _k, d) => d; }
export function view() { return (_t, _k, d) => d; }
