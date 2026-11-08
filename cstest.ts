import * as cs from "chainsig.js";
export async function t() {
  const S = (cs as any).Solana;
  const s = new S({ networkId: "testnet" });
  return s.deriveAddressAndPublicKey("intentional-hats-632291.testnet", "solana-1");
}
