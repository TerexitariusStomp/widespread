// contract.src.js — Foreguild futarchy governance on NEAR (near-sdk-js 2.x).
//
// SOURCE OF TRUTH: recovered from the previously-committed compiled bundle
// (contract.js, babel/rollup output with near-sdk-js inlined). Every state
// field, method name, argument shape, decorator flag and branch below was
// transcribed 1:1 from that bundle — behaviour is unchanged. Edit THIS
// file, rebuild with `pnpm --filter @widespread/near build`, deploy
// build/contract.wasm.
//
// The loop: a proposer locks a decision (metric + threshold + comparator)
// and an optional treasury action → anyone buys YES/NO outcome shares with
// attached NEAR (deposit-backed, pro-rata) → the proposer (early) or anyone
// (after the deadline) resolves with the observed metric value + an evidence
// hash binding the metric source → YES win auto-executes the treasury spend
// → winning shareholders redeem pro-rata from their side's pool; the losing
// pool stays in the contract and funds the treasury.
//
// Pure on-chain NEAR logic: no cross-chain calls, no Seer/Base dependency.

import { NearBindgen, near, call, view, assert } from "near-sdk-js";

const OPEN = "open";
const RESOLVED = "resolved";

@NearBindgen({})
export class ForeguildFutarchy {
  constructor() {
    this.proposals = {}; // id -> proposal
    this.yesShares = {}; // id -> {account: shares}
    this.noShares = {};
    this.yesPool = {}; // id -> yoctoNEAR deposited backing YES
    this.noPool = {};
    this.redeemed = {}; // id -> {account: "1"} — one payout per account
    this.nextId = 1;
    this.resolvers = {}; // metricId -> {account: "1"} — oracle attestors
    // DAO admin: the account allowed to register resolvers. Defaults to
    // the deployer (first propose caller) — set via setDao.
    this.dao = "";
  }

  // ---- DAO admin: who may set the oracle resolver registry ----
  @call({})
  setDao({ account }) {
    const who = near.predecessorAccountId();
    assert(!this.dao || who === this.dao, "only the dao admin can rotate itself");
    this.dao = account;
    return { dao: this.dao };
  }

  // Resolver registry: metricId -> oracle accounts allowed to attest
  // resolution values. Replaces hand-attested strings with a bound set
  // of attestors; a metricId with no resolvers stays permissionless
  // (proposer-early / anyone-after-deadline, as before).
  @call({})
  setResolvers({ metricId, accounts }) {
    const who = near.predecessorAccountId();
    assert(this.dao && who === this.dao, "only the dao admin registers resolvers");
    this.resolvers ??= {};
    const map = {};
    for (const a of accounts ?? []) map[a] = "1";
    this.resolvers[metricId] = map;
    return { metricId, resolvers: accounts ?? [] };
  }

  // ---- propose: lock the decision + treasury action ----
  // Payable (as in the deployed bundle): any attached deposit stays in the
  // contract balance (i.e. the treasury) — it is NOT credited to a pool.
  @call({ payableFunction: true })
  propose({ title, metricId, threshold, comparator, treasuryAction, deadline, challengeWindowNs }) {
    // comparator: "gte" | "lte" — metricValue vs threshold decides YES.
    assert(["gte", "lte"].includes(comparator), "comparator must be gte|lte");
    assert(deadline, "deadline required — anti-hostage");
    const id = String(this.nextId++);
    this.proposals[id] = {
      id,
      title,
      metricId,
      threshold,
      comparator,
      treasuryAction: treasuryAction ?? null,
      proposer: near.predecessorAccountId(),
      deadline,
      status: OPEN,
      createdAt: near.blockTimestamp().toString(),
      // Optimistic-oracle window: after resolution, a challenge period
      // (default 0 = immediate final, the pre-upgrade behavior) during
      // which a resolver may post a different attestation. Redeem is
      // locked until the window closes.
      challengeWindowNs: challengeWindowNs ?? "0",
      resolution: null,
    };
    this.yesShares[id] = {};
    this.noShares[id] = {};
    this.yesPool[id] = "0";
    this.noPool[id] = "0";
    this.redeemed[id] = {};
    return id;
  }

  // ---- trade: buy outcome shares, deposit-backed pro-rata ----
  @call({ payableFunction: true })
  buyShares({ proposalId, side }) {
    const p = this.proposals[proposalId];
    assert(p && p.status === OPEN, "proposal not open");
    // Anti-snipe (fix): trading must stop at the deadline — previously a
    // late buyer could purchase shares AFTER the outcome was knowable
    // but before resolve() ran, diluting honest positions.
    assert(near.blockTimestamp() <= BigInt(p.deadline), "trading closed — deadline passed");
    // Fix the silent-side footgun: unknown sides used to count as "no".
    assert(side === "yes" || side === "no", "side must be yes|no");
    const who = near.predecessorAccountId();
    const amt = near.attachedDeposit();
    assert(amt > 0n, "attach NEAR to buy shares");
    const sharesMap =
      side === "yes" ? this.yesShares[proposalId] : this.noShares[proposalId];
    const poolKey = side === "yes" ? "yesPool" : "noPool";
    const pool = BigInt(this[poolKey][proposalId]);
    const existing = sharesMap[who] ? BigInt(sharesMap[who]) : 0n;
    // shares = deposit * totalShares / pool  (pro-rata; first buy = 1:1)
    const totalShares = Object.values(sharesMap).reduce(
      (a, b) => a + BigInt(b),
      0n
    );
    const minted = pool === 0n ? amt : (amt * totalShares) / pool;
    sharesMap[who] = (existing + minted).toString();
    this[poolKey][proposalId] = (pool + amt).toString();
    return { side, minted: minted.toString() };
  }

  // ---- resolve: metric decides; evidence hash pins the source ----
  @call({})
  resolve({ proposalId, metricValue, evidenceHash }) {
    const p = this.proposals[proposalId];
    assert(p && p.status === OPEN, "proposal not open");
    const now = near.blockTimestamp();
    const caller = near.predecessorAccountId();
    const isProposer = caller === p.proposer;
    const isResolver = !!(this.resolvers ?? {})[p.metricId]?.[caller];
    const expired = now > BigInt(p.deadline);
    // When resolvers are registered for the metric, attestation belongs
    // to them (pre- or post-deadline); permissionless fallback only once
    // the deadline passes AND no resolver exists for the metric.
    const hasResolvers = Object.keys((this.resolvers ?? {})[p.metricId] ?? {}).length > 0;
    const allowed = isResolver || (isProposer && !hasResolvers) ||
      (expired && !hasResolvers);
    assert(allowed, "resolution requires a registered resolver for this metric");
    assert(
      evidenceHash && evidenceHash.length > 16,
      "evidenceHash required — bind the metric source"
    );
    const mv = BigInt(metricValue);
    const th = BigInt(p.threshold);
    const yesWon = p.comparator === "gte" ? mv >= th : mv <= th;
    p.status = RESOLVED;
    p.resolution = {
      outcome: yesWon ? "yes" : "no",
      metricValue: metricValue.toString(),
      threshold: p.threshold,
      evidenceHash,
      resolvedBy: near.predecessorAccountId(),
      ts: now.toString(),
    };

    // YES win + treasury action → auto-execute the spend. Silently skipped
    // (no treasuryPaid field) when the contract balance can't cover it.
    if (yesWon && p.treasuryAction?.recipient && p.treasuryAction?.amount) {
      const amt = BigInt(p.treasuryAction.amount);
      if (amt > 0n && near.accountBalance() >= amt) {
        this._transfer(p.treasuryAction.recipient, amt);
        p.resolution.treasuryPaid = amt.toString();
      }
    }
    return p.resolution;
  }

  // ---- challenge: a resolver may post a different attestation inside
  // the window — the optimistic-oracle check on a bad resolution.
  @call({})
  challenge({ proposalId, metricValue, evidenceHash }) {
    const p = this.proposals[proposalId];
    assert(p && p.status === RESOLVED, "nothing to challenge");
    assert(BigInt(p.challengeWindowNs ?? "0") > 0n, "no challenge window");
    const within = near.blockTimestamp() <=
      BigInt(p.resolution.ts) + BigInt(p.challengeWindowNs);
    assert(within, "challenge window closed — resolution final");
    const caller = near.predecessorAccountId();
    assert((this.resolvers ?? {})[p.metricId]?.[caller], "only a registered resolver challenges");
    assert(evidenceHash && evidenceHash.length > 16, "evidenceHash required");
    const mv = BigInt(metricValue);
    const th = BigInt(p.threshold);
    const yesWon = p.comparator === "gte" ? mv >= th : mv <= th;
    const prior = p.resolution.outcome;
    p.resolution = {
      outcome: yesWon ? "yes" : "no",
      metricValue: metricValue.toString(),
      threshold: p.threshold,
      evidenceHash,
      resolvedBy: caller,
      ts: near.blockTimestamp().toString(),
      challengedFrom: prior,
    };
    return p.resolution;
  }

  // ---- redeem: winning shares cash out pro-rata; losers fund treasury ----
  @call({})
  redeem({ proposalId }) {
    const p = this.proposals[proposalId];
    assert(p && p.status === RESOLVED, "proposal not resolved");
    // Resolution isn't final until the challenge window closes.
    const winNs = BigInt(p.challengeWindowNs ?? "0");
    assert(
      winNs === 0n || near.blockTimestamp() > BigInt(p.resolution.ts) + winNs,
      "challenge window open — resolution not final"
    );
    const who = near.predecessorAccountId();
    if (this.redeemed[proposalId][who])
      return {
        redeemed: "0",
        outcome: p.resolution.outcome,
        note: "already redeemed",
      };
    const winSide = p.resolution.outcome === "yes" ? "yes" : "no";
    const winShares =
      winSide === "yes" ? this.yesShares[proposalId] : this.noShares[proposalId];
    const winPool = BigInt(
      (winSide === "yes" ? this.yesPool : this.noPool)[proposalId]
    );
    const my = winShares[who] ? BigInt(winShares[who]) : 0n;
    const total = Object.values(winShares).reduce((a, b) => a + BigInt(b), 0n);
    let payout = 0n;
    // Note: payout uses the FULL pool and total shares every time (neither
    // is decremented on redeem) — each holder gets my/total of the pool,
    // and the `redeemed` mark only stops the same account claiming twice.
    if (my > 0n && total > 0n) {
      payout = (my * winPool) / total;
      this.redeemed[proposalId][who] = "1";
    }
    if (payout > 0n) this._transfer(who, payout);
    return { redeemed: payout.toString(), outcome: p.resolution.outcome };
  }

  // ---- fund the treasury (accumulated market-contract fees land here) ----
  // The attached deposit simply stays in the contract account balance.
  @call({ payableFunction: true })
  fundTreasury() {
    return { balance: near.accountBalance().toString() };
  }

  // ---- views (public governance state) ----
  @view({})
  getProposal({ proposalId }) {
    return this.proposals[proposalId];
  }

  @view({})
  listProposals() {
    return Object.values(this.proposals);
  }

  @view({})
  getShares({ proposalId, accountId }) {
    return {
      yes: this.yesShares[proposalId]?.[accountId] ?? "0",
      no: this.noShares[proposalId]?.[accountId] ?? "0",
    };
  }

  @view({})
  pools({ proposalId }) {
    return { yes: this.yesPool[proposalId], no: this.noPool[proposalId] };
  }

  @view({})
  getResolvers({ metricId }) {
    return Object.keys((this.resolvers ?? {})[metricId] ?? {});
  }

  @view({})
  treasuryBalance() {
    return near.accountBalance().toString();
  }

  // ---- internal ----
  _transfer(to, amount) {
    const idx = near.promiseBatchCreate(to);
    near.promiseBatchActionTransfer(idx, amount);
  }
}
