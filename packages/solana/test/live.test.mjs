// live.test.mjs — gated live Solana devnet test.
// Runs ONLY with E2E_LIVE=1. Requires a FUNDED devnet keypair at
// .devnet-keypair.json (airdrop is a manual step — this test never
// requests one). It checks the SOL balance first and skips with a clear
// message when unfunded.
//
// What it does for real: builds a transaction containing a memo
// instruction + a 0-PYUSD... actually a minimal PYUSD transfer is unsafe
// on an unfunded/fresh ATA, so the live leg sends ONLY the memo
// instruction as a real signed transaction — proving keypair load,
// blockhash fetch, signing, and confirmation against devnet — then, if
// the payer holds PYUSD, exercises payWithMemo for a 0.000001 PYUSD
// self-transfer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transaction } from '@solana/web3.js';
import {
  conn, loadKeypair, memoIx, payWithMemo, solBalance, contentHash,
} from '../src/lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const KP_PATH = join(here, '..', '.devnet-keypair.json');
const LIVE = process.env.E2E_LIVE === '1';

const skipReason = !LIVE
  ? 'set E2E_LIVE=1 to run live devnet tests'
  : !existsSync(KP_PATH)
    ? `.devnet-keypair.json not found at ${KP_PATH}`
    : null;

test('devnet keypair loads and has a confirmed balance', { skip: skipReason ?? false }, async () => {
  const kp = loadKeypair(KP_PATH);
  assert.ok(kp.publicKey);
  const bal = await solBalance(kp.publicKey);
  assert.ok(bal > 0, `devnet balance is ${bal} SOL — fund via faucet first`);
});

test('memo-only transaction confirms on devnet', { skip: skipReason ?? false }, async () => {
  const kp = loadKeypair(KP_PATH);
  const bal = await solBalance(kp.publicKey);
  if (bal < 0.001) {
    // node:test has no dynamic skip; assert with an explicit message.
    assert.fail(`devnet balance ${bal} SOL too low for fees — fund the keypair first`);
  }
  const memo = `widespread:test:${Date.now()}:${contentHash({ repo: 'live/test', seq: 1, claimHash: 'e2e', verdict: 'accept' }).slice(0, 16)}`;
  const tx = new Transaction().add(memoIx(memo));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  const status = await conn.getSignatureStatus(sig);
  assert.equal(status.value?.confirmationStatus, 'confirmed');
});

test('payWithMemo executes a real PYUSD self-transfer', { skip: skipReason ?? false }, async () => {
  const kp = loadKeypair(KP_PATH);
  const bal = await solBalance(kp.publicKey);
  assert.ok(bal > 0.005, `need >0.005 SOL for fees, have ${bal}`);

  // The PYUSD leg requires the payer to actually hold devnet PYUSD —
  // there is no faucet for it, so an empty ATA means "not funded yet".
  const { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } =
    await import('@solana/spl-token');
  const { PYUSD_MINT } = await import('../src/lib.js');
  const ata = getAssociatedTokenAddressSync(
    PYUSD_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );
  const info = await conn.getAccountInfo(ata);
  assert.ok(info, `payer has no PYUSD ATA (${ata.toBase58()}) — acquire devnet PYUSD first`);

  const memo = `widespread:live:${Date.now()}:${contentHash({
    repo: 'live/test', seq: 1, claimHash: 'e2e', verdict: 'accept',
  }).slice(0, 16)}`;
  const sig = await payWithMemo({
    payer: kp, to: kp.publicKey.toBase58(), amountUi: 0.000001, memo,
  });
  assert.match(sig, /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
});
