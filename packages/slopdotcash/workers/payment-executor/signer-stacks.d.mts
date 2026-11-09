export type SignerStack = "test" | "production";
export declare const SIGNER_STACKS: Readonly<{
  test: Readonly<{
    evmSecret: "TEST_SIGNER_PRIVATE_KEY";
    solanaSecret: "TEST_SOLANA_SIGNER_SEED";
    journal: string;
  }>;
  production: Readonly<{
    evmSecret: "SIGNER_PRIVATE_KEY";
    solanaSecret: "SOLANA_SIGNER_SEED";
    journal: string;
  }>;
}>;
export declare function signerStack(value: unknown): SignerStack;
export declare function stackServesNetwork(
  stack: SignerStack,
  network: string,
): boolean;
