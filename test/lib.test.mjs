// lib.test.mjs — hermetic unit tests for the Solana rail plumbing.
// No RPC: contentHash/memoIx/keypair IO are pure; payWithMemo needs
// devnet and stays in the gated live path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  PYUSD_MINT, MEMO_PROGRAM, DECIMALS,
  contentHash, memoIx, loadKeypair, saveKeypair,
} from '../src/lib.js';

test('contentHash is deterministic and binds all claim fields', () => {
  const a = contentHash({ repo: 'o/r', seq: 3, claimHash: 'abc', verdict: 'accept' });
  const b = contentHash({ repo: 'o/r', seq: 3, claimHash: 'abc', verdict: 'accept' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  // every field perturbs the hash
  for (const mod of [
    { repo: 'o/r2' }, { seq: 4 }, { claimHash: 'abd' }, { verdict: 'reject' },
  ]) {
    assert.notEqual(
      contentHash({ repo: 'o/r', seq: 3, claimHash: 'abc', verdict: 'accept', ...mod }),
      a,
    );
  }
});

test('memoIx targets the memo program with utf8 data', () => {
  const ix = memoIx('widespread:anchor:deadbeef');
  assert.equal(ix.programId.toBase58(), MEMO_PROGRAM.toBase58());
  assert.equal(ix.keys.length, 0);
  assert.equal(ix.data.toString('utf-8'), 'widespread:anchor:deadbeef');
});

test('keypair save/load round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-sol-'));
  try {
    const kp = Keypair.generate();
    const path = join(dir, 'kp.json');
    const pk58 = saveKeypair(path, kp);
    assert.equal(pk58, kp.publicKey.toBase58());
    const loaded = loadKeypair(path);
    assert.deepEqual([...loaded.secretKey], [...kp.secretKey]);
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadKeypair accepts base64 secret keys too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-sol-'));
  try {
    const kp = Keypair.generate();
    const { writeFileSync } = await import('node:fs');
    const path = join(dir, 'kp.b64');
    writeFileSync(path, Buffer.from(kp.secretKey).toString('base64'));
    const loaded = loadKeypair(path);
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PYUSD mint and decimals match the Token-2022 devnet issue', () => {
  assert.ok(PYUSD_MINT instanceof PublicKey);
  assert.equal(DECIMALS, 6);
});
