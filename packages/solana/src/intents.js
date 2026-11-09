// intents.js — NEAR Intents quote/status reads (1Click Swap API).
// Quote-only surface: callers get indicative prices and can poll a
// deposit's status, but this module never submits deposits or executes
// settlement — that leg is intentionally absent.
//
// Transport is @defuse-protocol/one-click-sdk-typescript (generated-code
// axios forced onto the fetch adapter so Worker/Node/tests share one
// path). Quotes/tokens/status are unauthenticated; ONECLICK_JWT is only
// needed for authenticated routes.

import axios from "axios";
import {
  ApiError,
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";

axios.defaults.adapter = "fetch";

export const TOKENS = {
  SOL_USDC: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
  SOL_USDT: 'nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near',
};

export async function getTokens(env) {
  if (env?.ONECLICK_JWT) OpenAPI.TOKEN = env.ONECLICK_JWT;
  return OneClickService.getTokens();
}

// Request an indicative quote: assetIn → assetOut to `recipient` on
// `destChain`. dry:true — a preview only, never a deposit instruction.
export async function quote({ assetIn, assetOut, amount, recipient, destChain, refundTo }, env) {
  if (env?.ONECLICK_JWT) OpenAPI.TOKEN = env.ONECLICK_JWT;
  const deadline = new Date(Date.now() + 3600e3)
    .toISOString().replace(/\.\d{3}Z$/, 'Z');
  const request = {
    dry: true,
    swapType: QuoteRequest.swapType.EXACT_OUTPUT,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    originAsset: assetIn,
    destinationAsset: assetOut,
    amount: String(amount),
    slippageTolerance: 100,
    refundTo: refundTo || 'widespread.near',
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline,
  };
  try {
    return await OneClickService.getQuote(request); // → indicative output, fees
  } catch (e) {
    if (e instanceof ApiError) {
      throw new Error(`quote: HTTP ${e.status} ${JSON.stringify(e.body)}`);
    }
    throw e;
  }
}

// Read-only settlement status for a deposit address — a single status
// lookup, no polling loop.
export async function getStatus(depositAddress, env) {
  if (env?.ONECLICK_JWT) OpenAPI.TOKEN = env.ONECLICK_JWT;
  return OneClickService.getExecutionStatus(depositAddress);
}
