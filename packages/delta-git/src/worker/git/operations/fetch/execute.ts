import type { ServeUploadPackPlan } from "./types";
import type { RewriteOptions } from "@/worker/git/pack/rewrite/shared";

import { rewritePackResult, type PackRewriteResult } from "@/worker/git/pack/rewrite";

export async function resolvePackStreamResult(
  env: Env,
  plan: ServeUploadPackPlan,
  options?: RewriteOptions
): Promise<PackRewriteResult> {
  return await rewritePackResult(env, plan.snapshot, plan.neededOids, options);
}

