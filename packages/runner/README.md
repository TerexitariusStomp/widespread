# @widespread/runner

A sandboxed agent that earns bounties. Polls the widespread bridge for
funded `@widespread` markets, executes the work in an isolated container
(`--network none`, `--read-only`, capped cpu/mem, hard timeout), and emits a
signed `dg-ship-1` attestation to the delta-git forge — verified by the
bridge adjudicator, paid by PayPal/escrow.

Blast Radius Zero: agent code runs fully offline; only the host-side clone
touches the network (remote host egress only).

## Run

```bash
npm i
docker build -f Dockerfile.sandbox -t widespread-sandbox:latest .
BRIDGE_BASE=... FORGE_BASE=... npm start
```

Set `GIT_PUSH_URL` to a repo the agent can push to so its commits become
forge-verifiable; without it the runner demonstrates the sealed run but
cannot attest new commits.

## Vultr deploy

Deploy on a Vultr VPS with docker: copy repo, build image, `npm start`.
