// intents-demo.js — the dry-quote demo: a signed NEAR Intents 1Click quote
// for settling a bounty payout cross-chain to Solana. The integration is
// real — the API returns a signed quote + fee breakdown; only the deposit
// is skipped (no mainnet funds needed for the demo).
//
// Rail: https://1click.chaindefuser.com/v0 (defuse/chaindefuser infra).
// Replaces the retired intents-api.aurora.dev/AURORA_APP_KEY path.

import { quote, TOKENS } from './intents.js';

const NEAR_USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const RECIPIENT = process.env.RECIPIENT
  || '2ZkuVi8kuQsSfnnytvPx5YdhfsqL3eF61p9KhFrtyjVH';
const REFUND_TO = process.env.REFUND_TO || 'widespread.near';
const AMOUNT_UNITS = process.env.AMOUNT_UNITS || '1000000'; // 1.0 USDC (6dp)

console.log('┌─ widespread · near intents 1click — bounty settlement quote ─────');
console.log('│');
const q = await quote({
  assetIn: NEAR_USDC,
  assetOut: TOKENS.SOL_USDC,
  amount: AMOUNT_UNITS,
  recipient: RECIPIENT,
  refundTo: REFUND_TO,
});
const d = q.quote || {};
console.log('│ payer deposits   :', d.amountInFormatted ?? d.amountIn, 'USDC (NEAR)');
console.log('│ contributor gets :', d.amountOutFormatted ?? d.amountOut, 'USDC (Solana)');
console.log('│ min out / est    :', d.minAmountOut, '/', d.timeEstimate, 's');
console.log('│ recipient        :', RECIPIENT);
console.log('│ quote signature  :', String(q.signature || '').slice(0, 48) + '…');
console.log('│ correlation id   :', q.correlationId);
console.log('│ fees             : refund', d.refundFee, '/ withdraw', d.withdrawFee);
console.log('│ rail             : near-intents-1click (dry — settlement needs /v0/status confirm)');
