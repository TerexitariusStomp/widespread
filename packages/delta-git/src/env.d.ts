// Paid-plan bindings that are intentionally absent from the free-tier
// wrangler.jsonc deploy. Declared here (matching the type cf-typegen emits
// when the binding is present) so call sites keep compiling and their
// runtime `env.ARTIFACTS` guards stay the source of truth for availability.
// Re-add the binding in wrangler.jsonc when the account is on Workers Paid;
// this declaration then merges identically with the generated one.
interface Env {
  ARTIFACTS: Artifacts;
}
