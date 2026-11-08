// aurora-demo.js — the dry-quote demo: a signed Aurora Intents quote
// for settling a bounty payout cross-chain to Solana. The integration
// is real — the API returns a signed quote + fee breakdown; only the
// deposit is skipped (no mainnet funds needed for the demo).

import { quote, TOKENS } from './intents.js';

const RECIPIENT = process.env.RECIPIENT
  || '2ZkuVi8kuQsSfnnytvPx5YdhfsqL3eF61p9KhFrtyjVH';
const AMOUNT_UI = Number(process.env.AMOUNT || 5);
const USDC_BASE = String(AMOUNT_UI * 1_000_000); // USDC has 6 decimals

console.log('┌─ widespread · aurora intents — bounty settlement quote ──────────');
console.log('│');
const q = await quote({
  assetIn: 'nep141:usdt.tether-token.near',
  assetOut: TOKENS.SOL_USDC,
  amount: USDC_BASE,
  recipient: RECIPIENT,
  destChain: 'sol',
});
const d = q.quote || q;
console.log('│ payer deposits   :', (d.amountInFormatted ?? d.amountIn) || '—', 'USDT (NEAR)');
console.log('│ contributor gets :', d.amountOutFormatted ?? d.amountOut, 'USDC (Solana)');
console.log('│ recipient        :', RECIPIENT);
console.log('│ quote signature  :', String(q.signature || '').slice(0, 48) + '…');
console.log('│ correlation id   :', q.correlationId);
console.log('│ deadline         :', q.quoteRequest?.deadline || '—');
if (q.quoteRequest?.depositAddress) {
  console.log('│ deposit address  :', q.quoteRequest.depositAddress);
}
console.log('│');
console.log('│ deposit USDT → solvers settle → contributor\'s Solana wallet');
console.log('│ gets USDC. settlement confirms via getExecutionStatus —');
console.log('│ payout is only credited AFTER status = settled.');
console.log('└──────────────────────────────────────────────────────────────────');
