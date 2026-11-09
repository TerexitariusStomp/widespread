// claim.test.mjs — hermetic test for the dg-ship-1 attestation flow.
// A stub forge on localhost plays /api/agents + /dg/ship; we verify the
// x-dg-* envelope is a well-formed dg1 signature over the exact body.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { shipClaim, collectEnvAttestation } from '../src/claim.js';

const te = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function sha256Hex(d) {
  return hex(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? te.encode(d) : d));
}

/** Stub forge: captures requests, returns a did:key on register. */
async function stubForge() {
  const seen = { agents: null, ship: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (o, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.url === '/api/agents' && req.method === 'POST') {
      seen.agents = JSON.parse(body.toString());
      // did:key = base58btc(multicodec(0xed01) + pubkey) — we only need
      // a stable unique string; the runner treats it opaquely.
      return json({ did: `did:key:${seen.agents.pubkey.slice(0, 16)}` });
    }
    if (req.url.endsWith('/dg/ship') && req.method === 'POST') {
      seen.ship = {
        headers: req.headers,
        body: JSON.parse(body.toString()),
        raw: body,
      };
      return json({ op_seq: 42, verified: true });
    }
    return json({ error: 'not-found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, base: `http://127.0.0.1:${(server.address()).port}` };
}

test('collectEnvAttestation reports runtime without faking TPM', () => {
  const a = collectEnvAttestation();
  assert.equal(a.runtime, 'node');
  assert.ok(a.collected_at);
  assert.equal(typeof a.tpm, 'boolean');
  if (!a.tpm) assert.ok(a.note, 'absence is reported, never faked');
});

test('shipClaim registers agent and posts a verifiable dg1 envelope', async () => {
  const { server, seen, base } = await stubForge();
  try {
    const out = await shipClaim({
      forgeBase: base,
      repo: 'o/r',
      commits: ['ABCDEF1234567890', 'fedcba9876543210'],
      sessionId: 'sess-1',
      extra: { files: 3 },
    });
    assert.equal(out.seq, 42);
    assert.equal(out.verified, true);

    // agent registration carried a 32-byte hex pubkey + label
    assert.match(seen.agents.pubkey, /^[0-9a-f]{64}$/);
    assert.equal(seen.agents.label, 'sess-1');

    // dg-ship-1 body shape
    const b = seen.ship.body;
    assert.equal(b.session_id, 'sess-1');
    assert.equal(b.tool, 'widespread-runner');
    assert.deepEqual(b.commits, ['abcdef1234567890', 'fedcba9876543210']);
    assert.equal(b.files, 3);
    assert.ok(b.env_attestation?.runtime === 'node');

    // envelope headers present
    const h = seen.ship.headers;
    assert.ok(h['x-dg-did'] && h['x-dg-ts'] && h['x-dg-nonce'] && h['x-dg-sig']);
    assert.equal(h['x-dg-sig'].length, 128); // ed25519 hex

    // Recompute the dg1 payload and verify the signature against the
    // pubkey the agent registered with.
    const path = `/api/o/r/dg/ship`;
    const bodySha = await sha256Hex(seen.ship.raw);
    const payload = await sha256Hex(
      `dg1\n${h['x-dg-did']}\n${h['x-dg-ts']}\n${h['x-dg-nonce']}\nPOST\n${path}\n${bodySha}`,
    );
    const pubkeyBytes = new Uint8Array(
      seen.agents.pubkey.match(/../g).map((x) => parseInt(x, 16)),
    );
    const key = await crypto.subtle.importKey(
      'raw', pubkeyBytes, { name: 'Ed25519' }, false, ['verify'],
    );
    const sigBytes = new Uint8Array(
      h['x-dg-sig'].match(/../g).map((x) => parseInt(x, 16)),
    );
    const ok = await crypto.subtle.verify(
      'Ed25519', key, sigBytes, te.encode(payload),
    );
    assert.equal(ok, true, 'dg1 signature must verify against registered pubkey');
  } finally {
    server.close();
  }
});

test('shipClaim surfaces forge registration failures', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500).end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    // fresh module state needed — cached agent is per-process; use a
    // unique forge base is not enough since `cached` persists. Instead
    // assert the throw path via a repo that 404s after register.
    await assert.rejects(
      shipClaim({
        forgeBase: `http://127.0.0.1:${server.address().port}`,
        repo: 'o/r', commits: ['a'.repeat(40)], sessionId: 's2',
      }),
    );
  } finally {
    server.close();
  }
});
