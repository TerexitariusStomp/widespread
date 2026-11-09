// mock.ts — shared test doubles: KV-backed CLAIMS, Env factory, fetch router.
import type { Env } from "../src/types";

export function fakeKV(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    async get(key: string, type?: string) {
      const v = map.get(key);
      if (v == null) return null;
      if (type === "json") return JSON.parse(v);
      return v;
    },
    async put(key: string, value: string) { map.set(key, value); },
    async delete(key: string) { map.delete(key); },
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...map.keys()]
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

export function fakeEnv(over: Partial<Env> = {}): Env {
  return {
    CLAIMS: fakeKV() as unknown as Env["CLAIMS"],
    ATTEST_SECRET: "test-attest-secret",
    NEAR_CONTRACT: "wide-mkt-11561.testnet",
    NEAR_RPC_URL: "https://rpc.testnet.near.org",
    ...over,
  } as Env;
}

/** Route fetch calls by URL substring → Response factory. Unmatched → 500. */
export function fetchRouter(routes: [string, () => Response | Promise<Response>][]) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [match, fn] of routes) {
      if (url.includes(match)) return fn();
    }
    return new Response(`unmocked fetch: ${url}`, { status: 500 });
  };
}

export const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
