// intents.js — NEAR Intents quote/status reads (1Click Swap API).
// Quote-only surface: callers get indicative prices and can poll a
// deposit's status, but this module never submits deposits or executes
// settlement — that leg is intentionally absent.

// NEAR Intents 1Click Swap API (defuse/chaindefuser infra) — the current
// public rail. Replaces the legacy intents-api.aurora.dev endpoint which
// required an AURORA_APP_KEY; 1Click quotes are unauthenticated.
const API = 'https://1click.chaindefuser.com/v0';

export const TOKENS = {
  SOL_USDC: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  SOL_USDT: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
};

export async function getTokens() {
  const r = await fetch(`${API}/tokens`);
  if (!r.ok) throw new Error(`tokens: HTTP ${r.status}`);
  return r.json();
}

// Request an indicative quote: assetIn → assetOut to `recipient` on
// `destChain`. dry:true — a preview only, never a deposit instruction.
export async function quote({ assetIn, assetOut, amount, recipient, destChain, refundTo }) {
  const r = await fetch(`${API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dry: true,
      swapType: 'EXACT_OUTPUT',
      depositType: 'ORIGIN_CHAIN',
      originAsset: assetIn,
      destinationAsset: assetOut,
      amount: String(amount),
      slippageTolerance: 100,
      refundTo: refundTo || 'widespread.near',
      refundType: 'ORIGIN_CHAIN',
      recipient: recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }),
  });
  if (!r.ok) throw new Error(`quote: HTTP ${r.status} ${await r.text()}`);
  return r.json(); // → indicative output, fees
}

// Read-only settlement status for a deposit address — a single status
// lookup, no polling loop.
export async function getStatus(depositAddress) {
  const r = await fetch(`${API}/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  if (!r.ok) throw new Error(`status: HTTP ${r.status}`);
  return r.json();
}
