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

near.accountBalance ??= () => 0n;

// Decorators are metadata-only for our purposes — pass through, but record
// each decorated method on the class as `__nearMethods` ({ name, kind,
// payableFunction, privateFunction }) so gate tests can compare the
// source's method table against a recorded fixture. The payable/private
// checks the real `call` wrapper enforces are NOT applied here.
function record(proto, name, entry) {
  const cls = proto.constructor;
  if (!Object.prototype.hasOwnProperty.call(cls, "__nearMethods")) cls.__nearMethods = [];
  cls.__nearMethods.push({ name, ...entry });
}
export function NearBindgen() { return (cls) => cls; }
export function call({ privateFunction = false, payableFunction = false } = {}) {
  return (t, k, d) => { record(t, k, { kind: "call", payableFunction, privateFunction }); return d; };
}
export function view() {
  return (t, k, d) => { record(t, k, { kind: "view", payableFunction: false, privateFunction: false }); return d; };
}
export function initialize() {
  return (t, k, d) => { record(t, k, { kind: "init", payableFunction: false, privateFunction: false }); return d; };
}
