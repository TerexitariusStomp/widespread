// contract.src.js — widespread permissionless market on NEAR (near-sdk-js 2.x).
//
// SOURCE OF TRUTH: edit THIS file, rebuild with
// `pnpm --filter @widespread/near build`, deploy build/contract.wasm.
//
// The loop: payer locks NEAR in createMarket → agents ship signed dg-ship-1
// claims (UNBOUNDED — no cap on submissions) → a verdict names the winning
// claim → escrow releases to the best VERIFIED work, not the first past the
// post. Losers are recorded with public scores — strong losing work still
// builds reputation. 2% to a DAO sink, no platform cut.
//
// Claims are free for claimants: contract state bytes are absorbed by the
// contract account (~300B/claim), reclaimed when claims expire and are
// batch-deleted. Spam is deterred by consequences, not tolls: bridge-side
// attestation (real forge submissions only), stage-1 evidence recompute,
// forge-native identity, and verdict competition.
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
const DEFAULT_CLAIM_TTL_NS = 7n * 24n * 60n * 60n * 1_000_000_000n; // 7 days
const CLAIM_PAGE = 50;

@NearBindgen({})
export class WidespreadMarket {
  constructor() {
    this.markets = {};  // marketId -> market record
    this.claims = {};   // marketId -> { seq, items: {claimId -> rec}, order: [claimId] }
    this.oracles = {};  // pubkey -> { active, owner, verdicts, disputes }
    this.nextId = 1;
  }

  // ---- payer: lock the bounty (attach deposit = escrow) ----

  @call({ payableFunction: true })
  createMarket({ specHash, spec, deadline, acceptanceRule, payToHat, claimTtlNs, acceptanceHash, platformBps, platformTo }) {
    const payer = near.predecessorAccountId();
    const attached = near.attachedDeposit();
    assert(attached > 0n, "market must be funded — attach the bounty");
    assert((platformBps ?? 0) <= 5000, "platformBps above 50% refused");
    const marketId = String(this.nextId++);
    this.markets[marketId] = {
      marketId, payer, specHash, spec,
      locked: attached.toString(), deadline, acceptanceRule,
      // hidden_tests acceptanceRule: payer commits a hash of hidden checks
      // at funding; stage-1 recompute enforces them before oracle.
      acceptanceHash: acceptanceHash ?? null,
      claimTtlNs: claimTtlNs ?? DEFAULT_CLAIM_TTL_NS.toString(),
      // Intentional Hats binding: when set, release records the earning
      // hat so the bridge can route settlement through the hat's intents
      // leg (foreign address / Poidh claim) instead of only NEAR.
      payToHat: payToHat ?? null,
      // Mirror-market markup: platformBps of `locked` is skimmed at release
      // to platformTo (default DAO sink) — how third-party bounties listed
      // through us earn their spread. 0 = plain market, unchanged.
      platformBps: platformBps ?? 0,
      platformTo: platformTo ?? null,
      status: OPEN, createdAt: near.blockTimestamp().toString(),
    };
    this.claims[marketId] = { seq: 0, items: {}, order: [] };
    return marketId;
  }

  @call({})
  refund({ marketId }) {
    const m = this.markets[marketId];
    assert(m && m.status === OPEN, "market not open");
    // deadline may be null (open-ended market) — BigInt(null) throws, so
    // guard explicitly; null means "never expires", not "expired now".
    const expired = m.deadline != null && near.blockTimestamp() > BigInt(m.deadline);
    const noPending = !this._pendingClaims(marketId).length;
    // payer can pull unclaimed funds any time; anyone can pull expired —
    // a payer can't hostage a market forever (timeout auto-release).
    assert(
      (near.predecessorAccountId() === m.payer && noPending) || expired,
      "market is live with pending claims"
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

  // ---- agent: bind work to the market (UNBOUNDED submissions) ----
  //
  // Claims are free — no deposit, no cap. Each claim carries the bridge's
  // attestation stamp (relayer + attested flag + forge identity) so the
  // verdict only ever competes real, forge-verified submissions.
  // claimTtlNs on the market bounds how long a claim stays pending;
  // cleanupExpired reclaims the state bytes.

  @call({})
  shipClaim({ marketId, claimHash, actor, commits, evidence,
              claimant, forgeId, forgeUserId, relayer, attested }) {
    const m = this.markets[marketId];
    assert(m && m.status === OPEN, "market not open");
    const bag = this._claimsBag(marketId) ??
      (this.claims[marketId] = { seq: 0, items: {}, order: [] });
    const claimId = String(++bag.seq);
    const ttl = BigInt(m.claimTtlNs ?? DEFAULT_CLAIM_TTL_NS.toString());
    const now = near.blockTimestamp();
    bag.items[claimId] = {
      claimId, marketId, claimHash, actor, commits, evidence,
      // payout identity (NEAR acct) vs shippedBy (who called — the relayer)
      claimant: claimant ?? near.predecessorAccountId(),
      shippedBy: near.predecessorAccountId(),
      // anti-sybil key resolved by the bridge from the forge artifact —
      // GitHub numeric user ID / forge DID; NEAR accounts are payout-only.
      forgeId: forgeId ?? null, forgeUserId: forgeUserId ?? null,
      relayer: relayer ?? null,
      attested: attested === true,
      status: "pending",
      claimDeadline: (now + ttl).toString(),
      ts: now.toString(),
    };
    bag.order.push(claimId);
    return claimId;
  }

  @call({})
  withdrawClaim({ marketId, claimId }) {
    const bag = this._claimsBag(marketId);
    const c = bag?.items?.[claimId];
    assert(c && c.status === "pending", "no pending claim");
    const who = near.predecessorAccountId();
    assert(who === c.shippedBy || who === c.claimant, "not your claim");
    c.status = "withdrawn";
    return true;
  }

  /** Anyone can reap expired claims — returns their storage bytes to the
   * contract account. Junk/stale claims never block the market. */
  @call({})
  cleanupExpired({ marketId }) {
    const bag = this._claimsBag(marketId);
    assert(bag, "no claims");
    const now = near.blockTimestamp();
    let reaped = 0;
    for (const id of bag.order) {
      const c = bag.items[id];
      if (c && c.status === "pending" && BigInt(c.claimDeadline) < now) {
        c.status = "expired";
        reaped++;
      }
    }
    return { reaped };
  }

  // ---- settlement: verdict-gated release, winner among ALL claims ----

  @call({})
  release({ marketId, verdictSig, oraclePubkey, winningClaimId }) {
    const m = this.markets[marketId];
    assert(m && m.status === OPEN, "market not open");
    const bag = this._claimsBag(marketId);
    const pending = this._pendingClaims(marketId);
    assert(pending.length > 0, "no pending claims");

    const signer = near.signerAccountId();
    const isPayer = signer === m.payer;                    // merge=accept on-chain
    const oracle = oraclePubkey && this.oracles[oraclePubkey];
    const isOracle = oracle && oracle.active;
    assert(isPayer || isOracle, "release needs payer sig or oracle verdict");

    // Winner selection: oracle/payer names the claim. Payer may accept any
    // claim (their money); oracle verdicts only count ATTESTED claims —
    // real forge-verified submissions, never raw contract spam.
    const winner = winningClaimId
      ? bag.items[String(winningClaimId)]
      : (isPayer ? pending[0] : null);
    assert(winner && winner.status === "pending", "winning claim not pending");
    if (isOracle && !isPayer) {
      assert(verdictSig && verdictSig.length > 32, "oracle verdict proof required");
      assert(winner.attested, "oracle can only settle attested claims");
      oracle.verdicts += 1;
    }

    const locked = BigInt(m.locked);
    const fee = (locked * FEE_BPS) / 10000n;
    const platformCut = (locked * BigInt(m.platformBps ?? 0)) / 10000n;
    const net = locked - fee - platformCut;
    m.status = PAID;
    m.paidTo = winner.claimant;
    m.claimHash = winner.claimHash;
    m.winningClaimId = winner.claimId;
    if (m.payToHat) m.payoutHatId = m.payToHat;
    // losers stay on record — public scores, reputation signal
    for (const c of pending) {
      if (c.claimId !== winner.claimId) c.status = "outcompeted";
    }
    winner.status = "won";
    this._transfer(winner.claimant, net);
    if (fee > 0n) this._transfer(DAO_SINK, fee);
    if (platformCut > 0n) this._transfer(m.platformTo ?? DAO_SINK, platformCut);
    return { paid: winner.claimant, net: net.toString(),
             fee: fee.toString(), platformCut: platformCut.toString(),
             claimHash: m.claimHash,
             winningClaimId: winner.claimId, losers: pending.length - 1 };
  }

  // ---- views (public market state — the on-chain bounty board) ----

  @view({})
  getMarket({ marketId }) { return this.markets[marketId]; }
  /** Compat shim: first pending claim or null (pre-multi-claim callers). */
  @view({})
  getClaim({ marketId }) {
    const pending = this._pendingClaims(marketId);
    return pending.length ? pending[0] : null;
  }
  /** Paginated claims for a market — the competition surface. */
  @view({})
  getClaims({ marketId, from, limit }) {
    const bag = this._claimsBag(marketId);
    if (!bag) return { claims: [], total: 0 };
    const f = Number(from ?? 0), l = Math.min(Number(limit ?? CLAIM_PAGE), 200);
    const pending = bag.order
      .map((id) => bag.items[id])
      .filter((c) => c && c.status === "pending");
    const resolved = bag.order
      .map((id) => bag.items[id])
      .filter((c) => c && c.status !== "pending");
    const all = [...pending, ...resolved];
    return { claims: all.slice(f, f + l), total: all.length,
             pending: pending.length };
  }
  @view({})
  getOracle({ pubkey }) { return this.oracles[pubkey]; }
  @view({})
  listOpen() {
    return Object.values(this.markets).filter((m) => m.status === OPEN);
  }
  @view({})
  listAll() { return Object.values(this.markets); }

  // ---- internal ----

  /** Claims container with lazy migration from the legacy single-claim
   * shape (claims[marketId] was the claim record itself). Legacy claims
   * predate attestation — they came through the bridge's validated path,
   * so they're marked attested to keep existing markets settleable. */
  _claimsBag(marketId) {
    let bag = this.claims[marketId];
    if (bag && bag.items === undefined && bag.claimHash !== undefined) {
      bag = {
        seq: 1,
        items: {
          "1": { ...bag, claimId: "1", status: "pending",
                 shippedBy: bag.claimant, attested: true,
                 claimDeadline: this.markets[marketId]?.deadline ?? "0" },
        },
        order: ["1"],
      };
      this.claims[marketId] = bag;
    }
    return bag ?? null;
  }

  _pendingClaims(marketId) {
    const bag = this._claimsBag(marketId);
    if (!bag) return [];
    return bag.order.map((id) => bag.items[id]).filter((c) => c && c.status === "pending");
  }

  _transfer(to, amount) {
    // plain NEAR transfer = promise batch with a single transfer action —
    // no method name involved (promiseCreate is for function calls).
    const idx = near.promiseBatchCreate(to);
    near.promiseBatchActionTransfer(idx, amount);
  }
}
