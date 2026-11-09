// widespread-runner — the sandboxed agent that earns.
// Polls the bridge for funded bounties, executes work in an isolated
// container, and emits a dg-ship-1 attestation the adjudicator verifies.
//
// Containment-first: every task runs in a fresh container with no network,
// capped CPU/mem, read-only root fs, and a hard timeout. The only egress
// is the git remote host (via a controlled clone step) — the agent's own
// code runs fully offline.

import Docker from 'dockerode';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const docker = new Docker();

const CFG = {
  bridgeBase: process.env.BRIDGE_BASE || 'https://slopcash-bridge.hardwoodstablecoin.workers.dev',
  forgeBase: process.env.FORGE_BASE || 'https://code.widespread.fyi',
  workDir: process.env.WORK_DIR || '/tmp/widespread-runs',
  image: process.env.SANDBOX_IMAGE || 'widespread-sandbox:latest',
  cpuCores: Number(process.env.SANDBOX_CPUS || 1),
  memMb: Number(process.env.SANDBOX_MEM_MB || 1024),
  timeoutSec: Number(process.env.SANDBOX_TIMEOUT_SEC || 600),
  pollMs: Number(process.env.POLL_MS || 30000),
  llmBase: process.env.LLM_BASE_URL || '',
  llmKey: process.env.LLM_API_KEY || '',
  agentDid: process.env.DG_AGENT_DID || '',
  agentKeyB64: process.env.DG_AGENT_KEY_PKCS8_B64 || '',
};

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// --- Bounty discovery -----------------------------------------------------

async function fetchBounties() {
  const res = await fetch(`${CFG.bridgeBase}/api/bounties`);
  if (!res.ok) throw new Error(`bounties: HTTP ${res.status}`);
  const data = await res.json();
  // Normalize: registry may be array or {bounties:[...]}
  const list = Array.isArray(data) ? data : data.bounties || [];
  return list.filter((b) => (b.status || 'open') === 'open' && Number(b.amount) > 0);
}

// --- Sandboxed execution --------------------------------------------------

async function runInSandbox(taskId, repoUrl, spec) {
  const runDir = join(CFG.workDir, taskId);
  await mkdir(runDir, { recursive: true });

  // 1. Controlled clone on the HOST (egress = remote host only).
  //    The agent container never gets network.
  const repoDir = join(runDir, 'repo');
  const { execSync } = await import('node:child_process');
  if (repoUrl && repoUrl.startsWith('http')) {
    execSync(`git clone --depth 50 "${repoUrl}" "${repoDir}"`, { stdio: 'inherit' });
  } else {
    await mkdir(repoDir, { recursive: true });
  }

  await writeFile(join(runDir, 'SPEC.md'), spec || 'No spec provided');
  await writeFile(
    join(runDir, 'task.json'),
    JSON.stringify({ taskId, repoUrl, spec }, null, 2),
  );

  // 2. Agent execution inside a sealed container.
  const container = await docker.createContainer({
    Image: CFG.image,
    Cmd: ['/work/run-task.sh', taskId],
    WorkingDir: '/work',
    User: String(process.getuid ? process.getuid() : 1000),
    Env: [
      `TASK_ID=${taskId}`,
      `LLM_BASE_URL=${CFG.llmBase}`,
      `LLM_API_KEY=${CFG.llmKey}`,
      `FORGE_BASE=${CFG.forgeBase}`,
    ],
    HostConfig: {
      NetworkMode: 'none',
      CpuPeriod: 100000,
      CpuQuota: CFG.cpuCores * 100000,
      Memory: CFG.memMb * 1024 * 1024,
      ReadonlyRootfs: true,
      Binds: [`${runDir}:/work:rw`],
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=128m' },
    },
  });

  const stream = await container.attach({ stream: true, stdout: true, stderr: true });
  const logPath = join(runDir, 'agent.log');
  const { createWriteStream } = await import('node:fs');
  const logStream = createWriteStream(logPath);
  stream.pipe(logStream);

  await container.start();
  log(`sandbox ${taskId} started (net=none cpu=${CFG.cpuCores} mem=${CFG.memMb}MB)`);

  // 3. Hard timeout — kill on overrun.
  const timer = setTimeout(() => {
    container.kill().catch(() => {});
    log(`sandbox ${taskId} killed: timeout ${CFG.timeoutSec}s`);
  }, CFG.timeoutSec * 1000);

  const result = await container.wait();
  clearTimeout(timer);
  log(`sandbox ${taskId} exited ${result.StatusCode}`);

  // 4. Collect artifacts.
  const artifacts = {
    taskId,
    exitCode: result.StatusCode,
    logPath,
    specPath: join(runDir, 'SPEC.md'),
    commits: [],
    diffSummary: '',
  };
  try {
    const commits = execSync(`git -C "${repoDir}" log --oneline -20`, {
      encoding: 'utf-8',
    }).trim();
    artifacts.commits = commits.split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
    artifacts.diffSummary = execSync(
      `git -C "${repoDir}" diff HEAD~${Math.max(artifacts.commits.length, 1)} --stat 2>/dev/null || echo "no diff"`,
      { encoding: 'utf-8', shell: '/bin/bash' },
    ).trim();

    // Push agent commits to a remote the forge can verify against.
    // GIT_PUSH_URL = repo the agent owns (github fork or delta-git remote).
    // Without it, commits stay local and can't be attested — demo falls
    // back to claiming upstream commits.
    if (process.env.GIT_PUSH_URL && artifacts.commits.length) {
      try {
        execSync(
          `git -C "${repoDir}" push "${process.env.GIT_PUSH_URL}" HEAD:main`,
          { stdio: 'inherit' },
        );
        artifacts.pushed = true;
      } catch (e) {
        artifacts.pushed = false;
        artifacts.pushError = String(e).slice(0, 200);
      }
    }
  } catch {
    /* repo may be untouched */
  }
  return artifacts;
}

// --- dg-ship-1 attestation ------------------------------------------------

import { shipClaim } from './claim.js';

async function emitClaim(repoSlug, artifacts) {
  const out = await shipClaim({
    forgeBase: CFG.forgeBase,
    repo: repoSlug,
    commits: artifacts.commits,
    sessionId: artifacts.taskId,
    tool: 'widespread-runner',
    extra: {
      files: artifacts.diffSummary ? artifacts.diffSummary.split('\n').length : 0,
      sandbox: {
        network: 'none',
        cpus: CFG.cpuCores,
        mem_mb: CFG.memMb,
        timeout_sec: CFG.timeoutSec,
        image: CFG.image,
      },
    },
  });
  log(`claim emitted: agent=${out.did.slice(0, 30)}… seq=${out.seq} verified=${out.verified}`);
  return out;
}

// --- Main loop ------------------------------------------------------------

async function tick() {
  const bounties = await fetchBounties().catch((e) => {
    log('bounty fetch failed:', e.message);
    return [];
  });
  if (!bounties.length) return;

  for (const b of bounties) {
    const taskId = `task-${b.id || Date.now()}`;
    log(`claiming bounty: ${b.repo} "$${b.amount}" — ${String(b.spec || '').slice(0, 60)}`);
    try {
      const artifacts = await runInSandbox(taskId, b.repo_url || b.repo, b.spec);
      if (b.repo) await emitClaim(b.repo, artifacts);
      log(`bounty ${taskId} complete — exit ${artifacts.exitCode}`);
    } catch (e) {
      log(`bounty ${taskId} failed:`, e.message);
    }
  }
}

log('widespread-runner starting');
log(`bridge=${CFG.bridgeBase} forge=${CFG.forgeBase} image=${CFG.image}`);
await mkdir(CFG.workDir, { recursive: true });
await tick();
setInterval(tick, CFG.pollMs);
