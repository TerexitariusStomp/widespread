// sandbox.docker.test.mjs — LIVE containment test against real Docker.
// Runs the actual widespread-sandbox image with the same isolation flags
// the runner uses (network none, read-only rootfs, all caps dropped) and
// asserts the seals hold from inside the container. Skips cleanly when
// docker or the image is unavailable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const IMAGE = process.env.SANDBOX_IMAGE || 'widespread-sandbox:latest';

async function dockerAvailable() {
  try {
    await execFileP('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function imagePresent() {
  try {
    await execFileP('docker', ['image', 'inspect', IMAGE], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_OK = await dockerAvailable();
const IMAGE_OK = DOCKER_OK && (await imagePresent());
const SKIP = !DOCKER_OK
  ? 'docker daemon not available'
  : !IMAGE_OK
    ? `image ${IMAGE} not built (docker build -f Dockerfile.sandbox -t ${IMAGE} .)`
    : false;

function runContainer(cmd) {
  return execFileP('docker', [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    IMAGE,
    'sh', '-c', cmd,
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
}

test('sealed container executes and reports node runtime', { skip: SKIP }, async () => {
  const { stdout } = await runContainer('echo sealed-ok && node --version');
  assert.match(stdout, /sealed-ok/);
  assert.match(stdout, /v\d+\.\d+\.\d+/);
});

test('read-only rootfs rejects writes outside tmpfs', { skip: SKIP }, async () => {
  const { stdout } = await runContainer(
    'touch /etc/widespread-probe 2>/dev/null && echo WRITABLE || echo READONLY; ' +
    'touch /tmp/widespread-probe && echo TMP-OK',
  );
  assert.match(stdout, /READONLY/);
  assert.match(stdout, /TMP-OK/);
});

test('network-none blocks outbound connectivity', { skip: SKIP }, async () => {
  const { stdout } = await runContainer(
    'node -e "fetch(\\"http://example.com\\",{signal:AbortSignal.timeout(3000)})' +
    '.then(()=>console.log(\\"NET-OPEN\\")).catch(()=>console.log(\\"NET-NONE\\"))"',
  );
  assert.match(stdout, /NET-NONE/);
});
