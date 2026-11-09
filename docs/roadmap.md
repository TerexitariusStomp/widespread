# Roadmap

## Paxos PYUSD rail — removed pre-launch

The Paxos PYUSD payout rail (`packages/bridge/src/paxos.ts`, plus the
PYUSD-on-Solana settlement branch in `mirrorclaims.ts` and the `PAXOS_*`
env bindings) was removed during the pre-launch refactor: Paxos requires
KYB (know-your-business) approval before it can act as transmitter of
record, and no users exist yet to depend on the rail.

Mirror-claim payouts are USD-only via PayPal Payouts until a licensed
transmitter is re-integrated.

Restore reference: tag `pre-refactor`, path `packages/bridge/src/paxos.ts`.
