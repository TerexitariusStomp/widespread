// deploy.js — deploy build/contract.wasm (from `pnpm --filter @widespread/near build`).
// Usage: node deploy.js [account-id.testnet]
// Account: NEAR_ACCOUNT + NEAR_PRIVATE_KEY (ed25519:…) env if both set;
// otherwise reuse/create a testnet account whose key lives in CREDS below.
// NEAR_NODE_URL overrides the testnet RPC.
// Key saved to ~/.intentional-hats.json
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";

const CREDS = path.join(os.homedir(), ".intentional-hats.json");
const WASM = new URL("./build/contract.wasm", import.meta.url);
if (!existsSync(WASM)) {
  console.error("build/contract.wasm missing — run `pnpm --filter @widespread/near build` first");
  process.exit(1);
}
const wasm = readFileSync(WASM);

const cfg = {
  nodeUrl: process.env.NEAR_NODE_URL || "https://near-testnet.drpc.org",
  helperUrl: "https://helper.testnet.near.org",
};

async function main() {
  let accountId, keyPair;
  if (process.env.NEAR_ACCOUNT && process.env.NEAR_PRIVATE_KEY) {
    accountId = process.env.NEAR_ACCOUNT;
    keyPair = KeyPair.fromString(process.env.NEAR_PRIVATE_KEY);
    console.log(`using ${accountId} from NEAR_ACCOUNT/NEAR_PRIVATE_KEY`);
  } else if (existsSync(CREDS)) {
    const c = JSON.parse(readFileSync(CREDS, "utf8"));
    accountId = c.accountId;
    keyPair = KeyPair.fromString(c.secretKey);
    console.log(`reusing ${accountId}`);
  } else {
    accountId =
      process.argv[2] ||
      `intentional-hats-${Math.floor(Math.random() * 1e6)}.testnet`;
    keyPair = KeyPair.fromRandom("ed25519");
    const res = await fetch(
      `${cfg.helperUrl}/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          newAccountId: accountId,
          newAccountPublicKey: keyPair.getPublicKey().toString(),
        }),
      });
    if (!res.ok) {
      const t = await res.text();
      if (!t.includes("already")) {
        console.error(`account create failed: ${res.status} ${t}`);
        process.exit(1);
      }
      console.log(`account ${accountId} exists — funding via faucet`);
    }
    writeFileSync(CREDS, JSON.stringify({
      accountId, secretKey: keyPair.toString(),
    }));
    console.log(`created ${accountId}`);
  }

  const account = new Account(accountId, cfg.nodeUrl, new KeyPairSigner(keyPair));
  console.log("deploying contract.wasm …");
  await account.deployContract(wasm);
  console.log(`deployed → https://testnet.nearblocks.io/address/${accountId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
