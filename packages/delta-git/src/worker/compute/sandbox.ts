// Platform compute — the single chokepoint through which every "real
// effect" module reaches a ForgeSandbox container.
//
// Isolation model: sandbox ids carry the owning namespace slug
// (`job-{ns}-{kind}-{id}` / `ws-{ns}-{id}`). The helpers here are the only
// way first-party code obtains a stub, so cross-space access would require
// deliberately bypassing this file — there is no ambient sandbox registry
// a caller could poke at.
//
// Secrets: user secrets are client-sealed by contract — nothing in this
// file accepts a plaintext secret. Server-side material (short-lived pull
// tokens, the platform mirror key) is handed to the sandbox via
// `writeFile`, never via argv or env vars, and is deleted before the job
// returns.

import { getSandbox, type SandboxOptions } from "@cloudflare/sandbox";
import type { ForgeSandbox } from "@/worker/do/sandbox/forgeSandbox";

/** Jobs are meant to finish and go away; workspaces linger for a user. */
const JOB_SLEEP_AFTER = "10m";
const WS_SLEEP_AFTER = "30m";

/** Hard wall-clock cap for any single platform job. */
export const JOB_TIMEOUT_MS = 30 * 60 * 1000;

function normalizeSlug(slug: string): string {
  // DO names are routed through the id — keep it lowercase-ascii so the
  // same space always resolves to the same sandbox.
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 60);
}

/** A one-shot platform job (CI run, scan, mirror, cert probe, chaos). */
export function jobSandbox(
  env: Env,
  namespaceSlug: string,
  kind: string,
  jobId: string,
  options: SandboxOptions = {}
): ForgeSandbox {
  return getSandbox(
    env.FORGE_SANDBOX,
    `job-${normalizeSlug(namespaceSlug)}-${normalizeSlug(kind)}-${normalizeSlug(jobId)}`,
    { sleepAfter: JOB_SLEEP_AFTER, normalizeId: true, ...options }
  );
}

/** A user dev workspace — keyed to the environment record id. */
export function workspaceSandbox(
  env: Env,
  namespaceSlug: string,
  workspaceId: string
): ForgeSandbox {
  return getSandbox(
    env.FORGE_SANDBOX,
    `ws-${normalizeSlug(namespaceSlug)}-${normalizeSlug(workspaceId)}`,
    { sleepAfter: WS_SLEEP_AFTER, normalizeId: true }
  );
}

/**
 * Run a job to completion inside a fresh ForgeSandbox instance.
 *
 * The caller decides what happens with the result; this helper only runs
 * the spec and reports. Fails soft — a broken sandbox or nonzero exit
 * returns `{ok:false}` rather than throwing, so callers can record honest
 * job state.
 */
