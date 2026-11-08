// demo.js — the Encode/Aurora demo: PYUSD bounty payout with an
// on-chain audit anchor, end-to-end on Solana devnet.
//
//   payer locks PYUSD in an escrow keypair (market funded, not promised)
//   → claim verified → release sends PYUSD + sha256(claim|verdict) memo
//     in ONE transaction → receipt = on-chain proof of verified work paid.

import { Keypair } from '@solana/web3.js';
import { writeFileSync } from 'node:fs';
import { conn, PYUSD_MINT, contentHash, payWithMemo, memoIx, solBalance } from './lib.js';
import { Transaction } from '@solana/web3.js';

const log = (...a) => console.log(...a);

// The claim the bridge already verified live (slop/protocol seq 0).
const CLAIM = {
  repo: 'slop/protocol',
  seq: 0,
  claimHash: '6ca71cdb8a677d3a82dc61d3963a80d8b8391a0bb8169de50306615a6e44991e',
  verdict: 'accept',
  amountUi: 5.0,
  contributor: process.env.CONTRIBUTOR || '', // set to a real addr for the demo
};

const out = {};

// 1 · Payer escrow keypair — the market's funds live here.
const escrow = Keypair.generate();
writeFileSync('/tmp/ws-escrow.json', JSON.stringify([...escrow.secretKey]));
out.escrow = escrow.publicKey.toBase58();
log('escrow       ', out.escrow);
log('sol balance  ', await solBalance(escrow.publicKey), 'SOL — needs devnet airdrop + PYUSD');

// 2 · Anchor step one: the claim hash bound to the escrow, on-chain.
const hash = contentHash(CLAIM);
log('content hash ', hash.slice(0, 32) + '…');
const anchorTx = new Transaction().add(memoIx(`widespread:anchor:${hash}`));
anchorTx.feePayer = escrow.publicKey;

// The demo prints what it WOULD send once escrow is funded —
// solana devnet faucet: https://faucet.solana.com  (and PYUSD faucet via Google Cloud).
if (process.env.DRY !== '0') {
  log('\nDRY RUN — escrow unfunded. To go live:');
  log('  solana airdrop 1', out.escrow);
  log('  fund PYUSD at the Paxos devnet mint', PYUSD_MINT.toBase58().slice(0, 20) + '…');
  log('  CONTRIBUTOR=<addr> DRY=0 node src/demo.js');
  out.dry = true;
} else {
  anchorTx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  anchorTx.sign(escrow);
  const a1 = await conn.sendRawTransaction(anchorTx.serialize());
  await conn.confirmTransaction(a1, 'confirmed');
  out.anchorSig = a1;
  log('anchor sig   ', a1);

  // 3 · Verified → release PYUSD with the verdict hash in the same tx.
  const sig = await payWithMemo({
    payer: escrow,
    to: CLAIM.contributor,
    amountUi: CLAIM.amountUi,
    memo: `widespread:payout:${hash.slice(0, 24)}`,
  });
  out.payoutSig = sig;
  log('payout sig   ', sig);
  log('receipt      ', `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

writeFileSync('/tmp/ws-out.json', JSON.stringify(out, null, 2));
log('\nout → /tmp/ws-out.json');
