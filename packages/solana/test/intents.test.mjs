// intents.test.mjs — LIVE tests for the NEAR Intents quote/status reads.
// These hit the real 1Click Swap API (api.1click.dev) — quotes and token
// lists are unauthenticated, so no secrets are required. No mocks: if the
// API is unreachable the tests fail, which is the point.
//
// Route used: wNEAR (nep141:wrap.near) -> USDC with an ETH destination
// address. This is the only route verified to return a quote today; the
// API currently lists no `solana`-blockchain assets, so a solana-destined
// quote 500s server-side.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKENS, quote, getStatus, getTokens } from '../src/intents.js';

// A burn-style ETH address — valid format, nobody's funds at risk. Quotes
// are dry:true previews; nothing is ever deposited.
const RECIPIENT = '0x000000000000000000000000000000000000dead';
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

function liveQuote(overrides = {}) {
  return quote({
    assetIn: 'nep141:wrap.near',
    assetOut: USDC_NEAR,
    amount: 1,
    recipient: RECIPIENT,
    destChain: 'eth',
    refundTo: RECIPIENT,
    ...overrides,
  });
}

test('getTokens returns the live token list including wrap.near', async () => {
  const tokens = await getTokens();
  assert.ok(Array.isArray(tokens) && tokens.length > 0);
  const wnear = tokens.find((t) => t.assetId === 'nep141:wrap.near');
  assert.ok(wnear, 'wrap.near missing from live token list');
  assert.equal(wnear.blockchain, 'near');
});

test('quote returns a real signed dry-run quote echoing the request', async () => {
  const q = await liveQuote();
  assert.ok(q.quote, 'response missing quote object');
  assert.ok(q.signature, 'response missing ed25519 signature');
  // EXACT_OUTPUT: we asked for `amount` units of the destination asset.
  assert.equal(q.quoteRequest.swapType, 'EXACT_OUTPUT');
  assert.equal(q.quoteRequest.depositType, 'ORIGIN_CHAIN');
  assert.equal(q.quoteRequest.dry, true);
  assert.equal(q.quoteRequest.originAsset, 'nep141:wrap.near');
  assert.equal(q.quoteRequest.destinationAsset, USDC_NEAR);
  assert.equal(q.quoteRequest.recipient, RECIPIENT);
  assert.equal(q.quoteRequest.amount, '1');
  // The API must price the output — amountOut is a non-negative integer.
  assert.match(q.quote.amountOut, /^\d+$/);
  assert.ok(Number(q.quote.amountIn) > 0, 'amountIn should be positive');
});

test('quote surfaces HTTP errors from the live API', async () => {
  await assert.rejects(
    () => quote({
      assetIn: 'nep141:does-not-exist.invalid',
      assetOut: USDC_NEAR,
      amount: 1,
      recipient: RECIPIENT,
      destChain: 'eth',
      refundTo: RECIPIENT,
    }),
    /quote: HTTP 4\d\d/,
  );
});

test('getStatus rejects for an unknown deposit address', async () => {
  await assert.rejects(
    () => getStatus(`widespread-test-${Date.now()}-not-real`),
    /not found|HTTP 4\d\d/i,
  );
});

test('TOKENS constants are well-formed nep141 asset ids', () => {
  for (const id of Object.values(TOKENS)) {
    assert.match(id, /^nep141:[a-z0-9._-]+\.[a-z0-9._-]+$/i);
  }
});
