// claim.test.mjs — LIVE tests for the dg-ship-1 attestation flow.
// No stubs: shipClaim registers a real ephemeral Ed25519 agent on the
// real delta-git forge (https://code.widespread.fyi) and POSTs a real
// signed dg-ship-1 envelope. The forge verifies the commits against the
// repo's upstream and reports verified/ship in its response.
//
// Repo under test: slop/protocol (remote-backed by github.com/SlopDotCash/
// protocol). We resolve a verifiable commit dynamically from the GitHub
// commits API so the test does not depend on a hardcoded SHA staying
// reachable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { shipClaim, collectEnvAttestation } from '../src/claim.js';

const FORGE = process.env.FORGE_BASE || 'https://code.widespread.fyi';
const REPO = 'slop/protocol';
const UPSTREAM_COMMITS = 'https://api.github.com/repos/SlopDotCash/protocol/commits?per_page=10';

// Resolve a commit the forge can verify. HEAD occasionally comes back
// "commits-unverifiable" (the forge checks the upstream .patch endpoint),
// and some verified commits still report ship:false (the forge declines
// to record a ship entry for them), so walk the recent history until one
// fully verifies + ships. Each attempt is a real signed ship POST —
// bounded to keep the prod op-log noise small.
async function findVerifiableCommit() {
  const res = await fetch(UPSTREAM_COMMITS, {
    headers: { 'user-agent': 'widespread-runner-test', accept: 'application/vnd.github+json' },
  });
  assert.equal(res.ok, true, `github commits: HTTP ${res.status}`);
  const commits = await res.json();
  assert.ok(Array.isArray(commits) && commits.length, 'no upstream commits');
  return commits.map((c) => c.sha);
}

test('collectEnvAttestation reports runtime without faking TPM', () => {
  const a = collectEnvAttestation();
  assert.equal(a.runtime, 'node');
  assert.ok(a.collected_at);
  assert.equal(typeof a.tpm, 'boolean');
  if (!a.tpm) assert.ok(a.note, 'absence is reported, never faked');
});

test('shipClaim registers a real agent and lands a verified dg-ship-1 claim', async () => {
  const shas = await findVerifiableCommit();
  let last = null;
  for (const sha of shas.slice(0, 8)) {
    last = await shipClaim({
      forgeBase: FORGE,
      repo: REPO,
      commits: [sha],
      sessionId: `claim-test-${Date.now().toString(36)}`,
      extra: { files: 1, probe: 'claim.test.mjs' },
    });
    if (last.raw?.verified && last.raw?.ship) break;
  }
  assert.ok(last?.did?.startsWith('did:key:'), `no did returned: ${JSON.stringify(last)}`);
  assert.equal(last.raw?.verified, true,
    `forge did not verify claim: ${JSON.stringify(last.raw).slice(0, 300)}`);
  assert.equal(last.raw?.ship, true, 'forge did not record a ship entry');
  assert.equal(typeof last.raw?.op_seq, 'number');
  assert.equal(last.verified, true);
});

test('shipClaim surfaces forge errors for unknown repos without throwing', async () => {
  const out = await shipClaim({
    forgeBase: FORGE,
    repo: 'widespread/no-such-repo-xyz',
    commits: ['a'.repeat(40)],
    sessionId: `neg-${Date.now().toString(36)}`,
  });
  assert.ok(out.did?.startsWith('did:key:'), 'agent still registers on the real forge');
  assert.equal(out.verified, false);
  assert.ok(out.raw?.error || out.raw?.reason,
    `expected an error/reason from the forge, got ${JSON.stringify(out.raw)}`);
});
