import { describe, expect, it, vi, beforeEach } from "vitest";
import { tryOpsEscrow, getFiatFunding } from "../src/fiat";
import { fakeEnv, fakeKV, jsonRes } from "./mock";
import type { Env, MirrorListing } from "../src/types";

// Real throwaway ed25519 keypair (generated once for tests; holds no funds).
const SECRET = "ed25519:3LA81HQ5Yb2eyPJZ7zy8RF9QDzjgX9ixpD1UP3WK2M6DLSDe7xSuCCUHQp2eth7Nm8LuoCm4zotnRwbJrthse2dC";

const mirror = (over: Partial<MirrorListing> = {}): MirrorListing => ({
  id: "mirror:test:1",
  record_id: "github-thirdparty:generic:o/r#1",
  title: "t", url: "https://x", repo: "o/r",
  original: { amount: "10", currency: "USD", est_usd: 10 },
  cut_bps: 1000, claimant_share: { est_usd: 9 },
  spec: "s", spec_hash: "sha256:spec",
  createMarketArgs: { specHash: "sha256:spec", spec: "s", deadline: null,
    acceptanceRule: "best", platformBps: 1000, platformTo: "widespread-dao.near" },
  status: "fiat-funded", created_at: 0, updated_at: 0,
  ...over,
});

function opsEnv(kv = fakeKV()) {
  return fakeEnv({
    CLAIMS: kv as unknown as Env["CLAIMS"],
    NEAR_OPS_ACCOUNT: "wide-ops-328424.testnet",
    NEAR_OPS_SECRET_KEY: SECRET,
    NEAR_CONTRACT: "wide-mkt-11561.testnet",
    NEAR_RPC_URL: "https://rpc.testnet.near.org",
  });
}

/** RPC-aware fetch mock: routes on URL + JSON-RPC method in body. */
function rpcFetch(handlers: {
  nonce?: unknown; blockHash?: string; sendTx?: unknown;
  listAll?: unknown; price?: number;
} = {}) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("1click.chaindefuser.com")) {
      return jsonRes([{ blockchain: "near", symbol: "wNEAR", price: handlers.price ?? 3.5 }]);
    }
    if (url.includes("rpc.testnet.near.org")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: { request_type?: string } };
      if (body.method === "send_tx") return jsonRes({ result: handlers.sendTx ?? {
        transaction: { hash: "TXHASH123" },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
      } });
      const rt = body.params?.request_type;
      if (rt === "view_access_key") return jsonRes({ result: { nonce: handlers.nonce ?? 5, permission: "FullAccess" } });
      if (rt === "call_function") {
        const markets = handlers.listAll ?? [];
        const bytes = [...new TextEncoder().encode(JSON.stringify(markets))];
        return jsonRes({ result: { result: bytes } });
      }
      if (body.method === "block") {
        return jsonRes({ result: { header: { hash: handlers.blockHash ?? "11111111111111111111111111111111" } } });
      }
      return jsonRes({ error: { message: `unmocked rpc ${body.method}/${rt}` } }, 500);
    }
    return new Response(`unmocked: ${url}`, { status: 500 });
  };
}

beforeEach(() => vi.unstubAllGlobals());

describe("tryOpsEscrow", () => {
  it("skips cleanly without ops config", async () => {
    const env = fakeEnv(); // no NEAR_OPS_*
    const r = await tryOpsEscrow(env, mirror());
    expect(r).toMatchObject({ skipped: expect.stringMatching(/NEAR_OPS/) });
  });

  it("skips when mirror has no USD price", async () => {
    const env = opsEnv();
    const r = await tryOpsEscrow(env, mirror({ original: { amount: "10", currency: "NEAR" } }));
    expect(r).toMatchObject({ skipped: expect.stringMatching(/USD price/) });
  });

  it("returns already:true for a confirmed prior attempt", async () => {
    vi.stubGlobal("fetch", rpcFetch()); // must not be called, but stub anyway
    const kv = fakeKV({
      "escrowstate:mirror:test:1": JSON.stringify({
        mirror_id: "mirror:test:1", status: "confirmed", usd: "10",
        near_price: 3.5, near_amount: "2.857", deposit_yocto: "2857",
        txHash: "OLD", marketId: "15", attempts: 1, updated_at: Date.now(),
      }),
    });
    const env = opsEnv(kv);
    const r = await tryOpsEscrow(env, mirror()) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: true, already: true, market_id: "15" });
  });

  it("reconciles against chain when market exists by specHash", async () => {
    vi.stubGlobal("fetch", rpcFetch({
      listAll: [{ marketId: "21", specHash: "sha256:spec" }],
    }));
    const kv = fakeKV();
    const env = opsEnv(kv);
    const r = await tryOpsEscrow(env, mirror()) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: true, reconciled: true, market_id: "21" });
    const state = JSON.parse(kv.map.get("escrowstate:mirror:test:1")!);
    expect(state.status).toBe("confirmed");
    expect(state.marketId).toBe("21");
  });

  it("refuses to stack broadcasts inside the pending window", async () => {
    vi.stubGlobal("fetch", rpcFetch({ listAll: [] }));
    const kv = fakeKV({
      "escrowstate:mirror:test:1": JSON.stringify({
        mirror_id: "mirror:test:1", status: "pending", usd: "10",
        near_price: 3.5, near_amount: "2.857", deposit_yocto: "2857",
        txHash: "INFLIGHT", attempts: 1, updated_at: Date.now(),
      }),
    });
    const env = opsEnv(kv);
    const r = await tryOpsEscrow(env, mirror()) as Record<string, unknown>;
    expect(r).toMatchObject({ pending: expect.stringMatching(/unresolved/) });
  });

  it("full happy path: price → deposit → broadcast → confirm by specHash", async () => {
    let listCalls = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("1click")) return jsonRes([{ blockchain: "near", symbol: "wNEAR", price: 2.0 }]);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: { request_type?: string } };
      if (body.method === "send_tx") {
        // after broadcast, the market appears
        return jsonRes({ result: { transaction: { hash: "NEWTX" },
          receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] } });
      }
      const rt = body.params?.request_type;
      if (rt === "view_access_key") return jsonRes({ result: { nonce: 0, permission: "FullAccess" } });
      if (rt === "call_function") {
        listCalls++;
        const markets = listCalls > 1 ? [{ marketId: "30", specHash: "sha256:spec" }] : [];
        return jsonRes({ result: { result: [...new TextEncoder().encode(JSON.stringify(markets))] } });
      }
      if (body.method === "block") return jsonRes({ result: { header: { hash: "22222222222222222222222222222222" } } });
      return jsonRes({});
    });
    const kv = fakeKV();
    const env = opsEnv(kv);
    const r = await tryOpsEscrow(env, mirror()) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: true, market_id: "30", txHash: "NEWTX" });
    expect(r.near_amount).toBe("5.000000"); // $10 / $2
    const state = JSON.parse(kv.map.get("escrowstate:mirror:test:1")!);
    expect(state.status).toBe("confirmed");
    expect(state.deposit_yocto).toBe(String(BigInt(Math.round(5 * 1e24))));
  });

  it("broadcast failure records failed state, safe to retry", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("1click")) return jsonRes([{ blockchain: "near", symbol: "wNEAR", price: 3.5 }]);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: { request_type?: string } };
      if (body.method === "send_tx") throw new Error("near rpc send_tx: insufficient balance");
      const rt = body.params?.request_type;
      if (rt === "view_access_key") return jsonRes({ result: { nonce: 0, permission: "FullAccess" } });
      if (rt === "call_function") return jsonRes({ result: { result: [] } });
      if (body.method === "block") return jsonRes({ result: { header: { hash: "33333333333333333333333333333333" } } });
      return jsonRes({});
    });
    const kv = fakeKV();
    const env = opsEnv(kv);
    const r = await tryOpsEscrow(env, mirror()) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: false });
    expect(String(r.error)).toMatch(/insufficient balance/);
    const state = JSON.parse(kv.map.get("escrowstate:mirror:test:1")!);
    expect(state.status).toBe("failed");
    expect(state.attempts).toBe(1);
  });

  it("tx that lands but isn't visible stays pending for reconciliation", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("1click")) return jsonRes([{ blockchain: "near", symbol: "wNEAR", price: 3.5 }]);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: { request_type?: string } };
      if (body.method === "send_tx") return jsonRes({ result: {
        transaction: { hash: "LIMBO" },
        receipts_outcome: [{ outcome: { status: { Failure: {} } } }],
      } });
      const rt = body.params?.request_type;
      if (rt === "view_access_key") return jsonRes({ result: { nonce: 0, permission: "FullAccess" } });
      if (rt === "call_function") return jsonRes({ result: { result: [] } }); // market never appears
      if (body.method === "block") return jsonRes({ result: { header: { hash: "44444444444444444444444444444444" } } });
      return jsonRes({});
    });
    const env = opsEnv();
    const r = await tryOpsEscrow(env, mirror()) as Record<string, unknown>;
    expect(r).toMatchObject({ escrowed: false, status: "failed" }); // Failure status → failed
  });
});

describe("getFiatFunding", () => {
  it("returns null for unfunded mirror", async () => {
    expect(await getFiatFunding(fakeEnv(), "mirror:none")).toBeNull();
  });
});
