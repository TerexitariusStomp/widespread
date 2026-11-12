# Foreguild — messaging playbook

Goal: route attention to our Poidh claim and (after judging opens) our Seer market outcome. Every artifact ends in a vote CTA, not just a link.

## Evidence

R2 `rooted-contrib/serving/posts.parquet` — 5,748,317 posts (bsky 3.55M / nostr 2.1M / hive 95k), 90-day window Jul–Sep 2026, via duckdb. Live X scraped via Brave debug port Nov 10 2026.

| Frame | Proof | Where |
|---|---|---|
| "Getting agents paid" | termix 130L/63RT/62K views; Coinbase x402 226L; agents-hiring-agents 308L/136R | X lead |
| Portable agent reputation | "history and reputation across any Nostr-compatible system" — 24 posts/10 authors/3,484 likes | bsky/nostr lead |
| Anti-AI-slop in OSS | "can't have public repo without LLM PRs" 356L/46RT/28Q | bsky lead; weak on X |
| Numbers-as-proof | OKX "10K agents, 20K tasks" 158L/61K views; Aeron "1,336 payments/177,894 USDG" 59L/27K | stat-first posts |
| Question/AMA hooks | Seer "pick the name" 220 replies/8K views | reply bait |
| "Futarchy" | 6 posts, ~0 likes | say "prediction-market governed treasury" |
| Tension sentence | "AI agents now start ~4 in 10 GitHub PRs. Writing code got fast. Checking it didn't." | hero lede |
| Format | nostr link-posts avg 18L vs text-only 43L+5.8RT; threads avg 467L; images 64L | link in reply, never in post |

Our baseline: X post 2 L/141 views — distribution is the gap, not the message.

## Audience × angle

| Audience | Lead | Proof line | CTA |
|---|---|---|---|
| OSS builders (bsky, nostr) | AI slop drowns review queues; we built the filter that pays | artifact gate (422) + rep-ranked queues + dg-ship-1 receipts | claim link |
| Agent-commerce (X) | Agents getting paid is the bottleneck; we ship receipts | 0.1 → 0.098 NEAR settled, real PayPal batch | claim link in reply |
| Crypto/money (nostr, X) | prediction-market governed treasury; fee only on collected revenue | prop 5 resolved + redeemed on-chain | claim link |
| Skeptics | honest scale: 5 testnet markets, cents so far — verify the mechanism | the 60-sec verify box | claim link |

## Drafts

### bsky/nostr thread (8 posts, link LAST)
1. AI agents write a growing share of new code. Checking didn't get faster. That's the actual problem — not "more agents."
2. We built a job board where escrow only releases on attested evidence. Not a proposal — it runs.
3. Claims must resolve a real forge artifact or they're rejected with HTTP 422. Volume costs the spammer, not the reviewer.
4. Verdicts: deterministic recompute first, a TEE-signed model second, bonded arbitration last. Fail-closed.
5. Agents carry their reputation across every forge — identity is a key, not an account.
6. Treasury decisions run on prediction markets — the first proposal already resolved on-chain and redeemed.
7. Real money has moved: 0.1 escrow → 0.098 release → 0.002 fee, and a PayPal payout batch. All testnet, all verifiable.
8. The operating plan is competing for 0.5 ETH + 4,000 USDC. If you believe receipt-over-review wins, back it: https://foreguild-plan.pages.dev (claim: poidh.xyz/base/bounty/1531)

### X post (stat-first, link in reply)
AI agents now write ~4 in 10 pull requests.
Writing got fast. Checking didn't.
Foreguild pays agents only for work that proves itself — escrow releases on signed evidence, fee only on what's released.
Already live on testnet. ⬇️

Reply: full plan + 60-second verify → https://foreguild-plan.pages.dev · claim → poidh.xyz/base/bounty/1531

### Crypto variant (nostr/X)
Treasury by prediction market: spending, fees, category expansion decided by markets resolving on attested metrics — proposal 5 already resolved and redeemed on-chain. Fee lands only on collected revenue. Verify, then back it on Poidh → (claim link)

### X reply for under @seer_pm's contest post (3.4K views)
Our plan is the one that's already running — every claim resolves to a live endpoint or contract. Verify in 60 seconds, then back it: https://foreguild-plan.pages.dev

## Poidh claim text (wallet-ready)

Title: Foreguild — the operating plan that already runs
Body:
> HTML: https://foreguild-plan.pages.dev · PDF: https://foreguild-plan.pages.dev/plan.pdf
> Every mechanism in this plan resolves to a deployed contract, live endpoint, or real transaction — escrow contract wide-mkt-11561.testnet settled a payout (0.1 → 0.098 release → 0.002 fee), futarchy proposal 5 resolved and redeemed on foreguild-ft-69240.testnet, TEE-signed verdicts, PayPal payout batch FZ7XZVBRXMJFL, 12-source unified task feed (5 competitor platforms mirrored), 559 Poidh bounties readable live, demand broadcast via /api/dispatch + A2A agent card. Revenue: 2% settlement fee + 10% mirror cut on released value only — collected revenue by construction. No volume forecasts; the settled ledger and fee schedule are the numbers.
> Verify in 60 seconds: widespread-bridge.widespread.workers.dev/api/markets · /api/futarchy · /api/feed · /api/poidh

## Deferred
- Own-post engagement tracking: query `social-discovery-db` tables `post_engagement`, `virality_history` (terexmaps D1) after 00:00 UTC quota reset.
- Seer market outcome URL: doesn't exist until markets open post-deadline — update the Act-on-it box then.

## Post-deadline playbook (after Nov 13 ~12:00 UTC)

Deadline is Nov 12 23:59 **AoE** (= Nov 13 ~11:59 UTC). Every plan then becomes an outcome in a Seer market; "voting" = trading on our outcome.

1. **Watch for the markets** — @seer_pm on X + app.seer.pm daily Nov 13–16. Contest markets opened the same way for the naming contest.
2. **CTA switch** — once our outcome is live, all copy swaps "back the Poidh claim" → "back our outcome on Seer: <market url>". The plan site's Act-on-it box already says "trade the outcome on Seer when markets open" — update it with the real market URL then.
3. **Keep the verify chain alive** — the differentiator is that every claim resolves to a live endpoint; don't redeploy/break the bridge during judging. Rival outcomes worth watching: the surge.sh entry (real Seer markets), Depth Guild (measured critique + video), blackstar (working agent), tidelit4 (agent-authored), drdz23 (reproducible Verdikta data).
4. **If our outcome lags** — respond with new shipped evidence (deployed artifacts), not just promotion. The 60-second verify box is the argument.

## Rival intel (78 claims, snapshot Nov 11)

- **S-tier**: `0x21c1…1cd0` (foreguild-verified-work.surge.sh — claims 9396/9423/9425) deployed 2 real Seer markets on Base; Depth Guild (9558) measured Seer thin-liquidity onchain + backtest + video; blackstar-agent.github.io/fao-plan ran a real delivery ledger + executed mirror tasks on live bounties.
- **A-tier**: tidelit4 (9462, agent-authored w/ SHA-256 artifact hashes — we now ship /integrity.txt the same way), drdz23 (9477, reproducible Verdikta dataset), 9363 "Guild Runs Itself" (company-grade simulation), 9401 vercel (NRPAAH metric), 9369 (six-surface Seer map).
- Everything else: ~65 generic revenue-first decks — volume filler.
