// lib.js — Solana devnet plumbing for the widespread rail.
// PYUSD (Token-2022) is PayPal's own dollar — the demo uses the devnet
// mint so every claim→payout is real on-chain evidence at zero cost.

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
// PYUSD devnet mint (Token-2022) — Paxos testnet issue.
export const PYUSD_MINT = new PublicKey(
  'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM',
);
export const DECIMALS = 6; // PYUSD uses 6 decimals on Solana.
export const MEMO_PROGRAM = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

export const conn = new Connection(RPC, 'confirmed');

export function loadKeypair(path) {
  const raw = readFileSync(path, 'utf-8').trim();
  const arr = raw.startsWith('[') ? JSON.parse(raw) : [...Buffer.from(raw, 'base64')];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

export function saveKeypair(path, kp) {
  writeFileSync(path, JSON.stringify([...kp.secretKey]));
  return kp.publicKey.toBase58();
}

// sha256("widespread" | repo | seq | claimHash | verdict) → hex
export function contentHash({ repo, seq, claimHash, verdict }) {
  return createHash('sha256')
    .update(`widespread|${repo}|${seq}|${claimHash}|${verdict}`)
    .digest('hex');
}

// On-chain memo — the audit anchor binding claim→verdict→payout.
export function memoIx(text) {
  return new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM,
    data: Buffer.from(text, 'utf-8'),
  });
}

// Transfer PYUSD (Token-2022) with a memo in the same transaction —
// payout and its audit hash are one atomic on-chain record.
export async function payWithMemo({ payer, to, amountUi, memo }) {
  const toPk = new PublicKey(to);
  const srcAta = getAssociatedTokenAddressSync(
    PYUSD_MINT, payer.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );
  const dstAta = getAssociatedTokenAddressSync(
    PYUSD_MINT, toPk, false, TOKEN_2022_PROGRAM_ID,
  );
  const ix = [memoIx(memo)];
  // create the recipient ATA if it doesn't exist yet
  const dstInfo = await conn.getAccountInfo(dstAta);
  if (!dstInfo) {
    ix.push(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, dstAta, toPk, PYUSD_MINT, TOKEN_2022_PROGRAM_ID,
      ),
    );
  }
  const units = BigInt(Math.round(amountUi * 10 ** DECIMALS));
  ix.push(
    createTransferCheckedInstruction(
      srcAta, PYUSD_MINT, dstAta, payer.publicKey, units, DECIMALS,
      [], TOKEN_2022_PROGRAM_ID,
    ),
  );
  const tx = new Transaction().add(...ix);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

export async function solBalance(pk) {
  return (await conn.getBalance(pk)) / 1e9;
}
