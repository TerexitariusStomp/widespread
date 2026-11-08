// near.ts — shared NEAR JSON-RPC view-call helper.
export async function nearView(
  env: { NEAR_RPC_URL?: string },
  accountId: string,
  method: string,
  args: object
): Promise<unknown> {
  const rpc = env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "wide",
      method: "query",
      params: {
        request_type: "call_function", finality: "final",
        account_id: accountId, method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const out = (await res.json()) as { result?: { result?: number[] } };
  const bytes = out.result?.result;
  return bytes ? JSON.parse(String.fromCharCode(...bytes)) : null;
}
