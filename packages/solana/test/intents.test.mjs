// intents.test.mjs — hermetic tests for the NEAR Intents quote/status reads.
// globalThis.fetch is stubbed: quote payload shape and status parsing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKENS, quote, getStatus } from '../src/intents.js';

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const out = handler(u, body);
    // Handlers may return a bare body, {body, http}, or {body, status:http}.
    const http = typeof out.status === 'number' ? out.status
      : (out.http ?? 200);
    const payload = typeof out.status === 'number' || out.body !== undefined
      ? out.body ?? out : out;
    return new Response(JSON.stringify(payload ?? {}), {
      status: http,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('quote posts EXACT_OUTPUT origin-chain deposit to 1Click', async () => {
  let seen;
  stubFetch((url, body) => {
    if (url.endsWith('/quote')) { seen = body; return { depositAddress: 'dep1', amountOut: '5.0' }; }
    throw new Error(`unexpected ${url}`);
  });
  const q = await quote({
    assetIn: TOKENS.SOL_USDC, assetOut: 'nep141:wrap.near',
    amount: 5, recipient: 'worker.near', destChain: 'solana',
  });
  assert.equal(q.depositAddress, 'dep1');
  assert.equal(seen.swapType, 'EXACT_OUTPUT');
  assert.equal(seen.depositType, 'ORIGIN_CHAIN');
  assert.equal(seen.dry, true);
  assert.equal(seen.recipient, 'worker.near');
  assert.equal(seen.originAsset, TOKENS.SOL_USDC);
  assert.ok(Date.parse(seen.deadline) > Date.now(), 'deadline in future');
});

test('quote surfaces HTTP errors', async () => {
  stubFetch(() => ({ status: 400, body: { error: 'no route' } }));
  await assert.rejects(
    () => quote({ assetIn: 'x', assetOut: 'y', amount: 1, recipient: 'r' }),
    /quote: HTTP 400/,
  );
});

test('getStatus parses the deposit-address status endpoint', async () => {
  stubFetch((url) => {
    assert.ok(url.includes('/status?depositAddress=dep9'));
    return { status: 'SUCCESS' };
  });
  const s = await getStatus('dep9');
  assert.equal(s.status, 'SUCCESS');
});
