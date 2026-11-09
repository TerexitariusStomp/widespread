// seer-market.mjs — create a Seer Opportunity Market on Base for Foreguild
// treasury governance. Uses @seer-pm/sdk (MIT) create-market helpers + viem.
//
// Requires: BASE_PRIVATE_KEY (funded with ETH for gas + sUSDS collateral
// for market liquidity — Seer Base markets use sUSDS as collateral).
// Run:  BASE_PRIVATE_KEY=0x... node scripts/seer-market.mjs
//
// Creates a categorical market: "Foreguild Q4 treasury allocation" with
// YES/NO outcomes — resolved by oracle against verified Widespread metrics
// (settled volume on wide-mkt-11561.testnet).

import { createWalletClient, createPublicClient, http, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  getCreateMarketExecution,
  getMarketFactoryAddress,
  MISC_CATEGORY,
} from "@seer-pm/sdk/create-market";

const pk = process.env.BASE_PRIVATE_KEY;
if (!pk) {
  console.error("set BASE_PRIVATE_KEY (funded Base wallet with sUSDS)");
  process.exit(1);
}
const account = privateKeyToAccount(pk);
const pub = createPublicClient({ chain: base, transport: http() });
const wallet = createWalletClient({ account, chain: base, transport: http() });

const props = {
  marketType: "categorical",
  marketName: "Foreguild Q4 treasury: allocate fees to audit-bounty vertical if settled volume >= 0.5 NEAR",
  outcomes: ["Yes — allocate", "No — hold"],
  openingTime: Math.floor(Date.now() / 1000),
  chainId: 8453,
  minBond: 1000000000000000n, // 0.001 ETH — Reality.eth bond
  category: MISC_CATEGORY,
};

const execution = getCreateMarketExecution(props, getMarketFactoryAddress("base"));
console.log("creating Seer market on Base from", account.address);
console.log("factory:", getMarketFactoryAddress("base"));
const hash = await wallet.writeContract(execution);
console.log("tx:", hash);
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("status:", receipt.status, "block:", receipt.blockNumber.toString());
console.log("market events → https://opportunity.seer.pm/markets");
