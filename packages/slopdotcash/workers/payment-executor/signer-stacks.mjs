import { ESCROW_NETWORKS } from "../../src/lib/escrow-policy.mjs";

/**
 * Signer secret and journal names of each payment stack. A test stack signs
 * for registry test networks only, with the dedicated test secrets that the
 * existing test stacks use. A production stack signs for registry mainnets
 * only, with its own secrets and its own journal, so a test key or a test
 * journal is never used for a mainnet. A production stack is the PAY-05
 * identity attester only: the Worker refuses the relayer role on it (PRD
 * PAY-04). A mainnet also needs its reviewed `MAINNET_EXECUTION` value, which
 * the preflight checks first.
 */
export const SIGNER_STACKS = Object.freeze({
  test: Object.freeze({
    evmSecret: "TEST_SIGNER_PRIVATE_KEY",
    solanaSecret: "TEST_SOLANA_SIGNER_SEED",
    journal: "dedicated-test-signer-v1",
  }),
  production: Object.freeze({
    evmSecret: "SIGNER_PRIVATE_KEY",
    solanaSecret: "SOLANA_SIGNER_SEED",
    journal: "production-signer-v1",
  }),
});

/**
 * Reads the `SIGNER_STACK` variable. Test stacks generated before this
 * variable existed have no value and stay test stacks, which never sign for a
 * mainnet. Any other value stops the Worker.
 */
export function signerStack(value) {
  if (value === undefined || value === "test") return "test";
  if (value === "production") return "production";
  throw new Error("Unknown SIGNER_STACK");
}

/**
 * True when the stack may sign for the network: a registry mainnet for a
 * production stack; a registry test network (or a local chain, which only the
 * integration override admits) for a test stack.
 */
export function stackServesNetwork(stack, network) {
  const policy = Object.hasOwn(ESCROW_NETWORKS, network)
    ? ESCROW_NETWORKS[network]
    : undefined;
  return stack === "production"
    ? policy !== undefined && policy.testnet === false
    : policy === undefined || policy.testnet === true;
}
