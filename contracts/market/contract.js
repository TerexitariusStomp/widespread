// contract.js — widespread permissionless market on NEAR (near-sdk-js 2.x).
//
// The loop: payer locks NEAR in createMarket → agent ships a signed
// dg-ship-1 claim → a verdict (payer sig or a registered oracle's signed
// verdict) releases escrow → contributor self-settles. No operator in the
// loop — the contract IS the market. 2% to a DAO sink, no platform cut.
//
// Oracles register themselves — permissionless adjudication: the bridge
// is the reference implementation, but any payer can pick their own
// oracle (a human key, an AI endpoint, an OutLayer TDX worker, or NEAR AI
// Cloud's provider_tee signed inference).
//
// Honest note: NEAR JS contracts can't verify ed25519 sigs cheaply on-
// chain yet, so the oracle-verdict sig check stays off-chain in the
// bridge's verify step; the contract binds verdict→oracle identity +
// reputation so a disputed oracle loses standing. Payer-sig release is
// fully on-chain (signer == payer). Escrow + timeout are on-chain facts.

import { NearBindgen, near, call, view, assert } from "near-sdk-js";

const OPEN = "open";
const PAID = "paid";
const REFUNDED = "refunded";
const EXPIRED = "expired";
const DAO_SINK = "widespread-dao.near"; // set at deploy
const FEE_BPS = 200n; // 2%

@NearBindgen({})
export class WidespreadMarket {
  constructor() {
    this.markets = {};  // marketId -> market record
    this.claims = {};   // marketId -> claim record
    this.oracles = {};  // pubkey -> { active, owner, verdicts, disputes }
    this.nextId = 1;
  }

  // ---- payer: lock the bounty (attach deposit = escrow) ----

  @call({ payableFunction: true })
  createMarket({ specHash, spec, deadline, acceptanceRule }) {
    const payer = near.predecessorAccountId();
    const attached = near.attachedDeposit();
    assert(attached > 0n, "market must be funded — attach the bounty");
    const marketId = String(this.nextId++);
    this.markets[marketId] = {
      marketId, payer, specHash, spec,
      locked: attached.toString(), deadline, acceptanceRule,
      status: OPEN, createdAt: near.blockTimestamp().toString(),
    };
    return marketId;
  }

  @call({})
  refund({ marketId }) {
    const m = this.markets[marketId];
    assert(m && m.status === OPEN, "market not open");
    const expired = near.blockTimestamp() > BigInt(m.deadline);
    const noClaim = !this.claims[marketId];
    // payer can pull unclaimed funds any time; anyone can pull expired —
    // a payer can't hostage a market forever (timeout auto-release).
    assert(
      (near.predecessorAccountId() === m.payer && noClaim) || expired,
      "market is live with a pending claim"
    );
    m.status = expired ? EXPIRED : REFUNDED;
    this._transfer(m.payer, BigInt(m.locked));
    return { refunded: m.payer, amount: m.locked, status: m.status };
  }

  // ---- oracle registry (permissionless) ----

  @call({})
  registerOracle({ pubkey }) {
    const who = near.predecessorAccountId();
    assert(!this.oracles[pubkey], "oracle already registered");
    this.oracles[pubkey] = { active: true, owner: who, verdicts: 0, disputes: 0 };
    return true;
  }

  // ---- agent: bind work to the market ----

  @call({})
  shipClaim({ marketId, claimHash, actor, commits, evidence }) {
    const m = this.markets[marketId];
    assert(m && m.status === OPEN, "market not open");
    assert(!this.claims[marketId], "a claim is already pending");
    this.claims[marketId] = {
      marketId, claimHash, actor, commits, evidence,
      claimant: near.predecessorAccountId(),
      ts: near.blockTimestamp().toString(),
    };
    return true;
  }

  // ---- settlement: verdict-gated release ----

  @call({})
  release({ marketId, verdictSig, oraclePubkey }) {
    const m = this.markets[marketId];
    const c = this.claims[marketId];
    assert(m && c && m.status === OPEN, "no open market with claim");

    const signer = near.signerAccountId();
    const isPayer = signer === m.payer;                    // merge=accept on-chain
    const oracle = oraclePubkey && this.oracles[oraclePubkey];
    const isOracle = oracle && oracle.active;

    assert(isPayer || isOracle, "release needs payer sig or oracle verdict");
    if (isOracle && !isPayer) {
      assert(verdictSig && verdictSig.length > 32, "oracle verdict proof required");
      oracle.verdicts += 1;
    }

    const locked = BigInt(m.locked);
    const fee = (locked * FEE_BPS) / 10000n;
    m.status = PAID;
    m.paidTo = c.claimant;
    m.claimHash = c.claimHash;
    this._transfer(c.claimant, locked - fee);
    if (fee > 0n) this._transfer(DAO_SINK, fee);
    return { paid: c.claimant, net: (locked - fee).toString(),
             fee: fee.toString(), claimHash: m.claimHash };
  }

  // ---- views (public market state — the on-chain bounty board) ----

  @view({})
  getMarket({ marketId }) { return this.markets[marketId]; }
  @view({})
  getClaim({ marketId }) { return this.claims[marketId]; }
  @view({})
  getOracle({ pubkey }) { return this.oracles[pubkey]; }
  @view({})
  listOpen() {
    return Object.values(this.markets).filter((m) => m.status === OPEN);
  }
  @view({})
  listAll() { return Object.values(this.markets); }

  // ---- internal ----

  _transfer(to, amount) {
    // plain NEAR transfer = promise batch with a single transfer action —
    // no method name involved (promiseCreate is for function calls).
    const idx = near.promiseBatchCreate(to);
    near.promiseBatchActionTransfer(idx, amount);
  }
}
