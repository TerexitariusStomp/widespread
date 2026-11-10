// goldset.test.ts — adjudicator calibration harness.
//
// Runs eval/goldset.jsonl through adjudicate() and reports verdict-level
// + per-criterion agreement. Env-gated like the live tests — GOLDSET_LIVE=1
// plus a model backend (NEAR_AI_API_KEY for TEE-signed calls, or Workers
// AI remote). Without it, the suite skips with instructions: the gold set
// exists for calibration runs, not CI noise.
//
// Interpretation (per the LLM-judge literature): agreement rate on binary
// rubric criteria is the metric that matters — holistic verdict agreement
// is reported too, but per-criterion is the calibrating signal.

import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { adjudicate } from "../src/adjudicator";
import type { Env } from "../src/types";

const LIVE = process.env.GOLDSET_LIVE === "1" ||
  !!(env as { NEAR_AI_API_KEY?: string }).NEAR_AI_API_KEY;

interface GoldCase {
  id: string; desc: string;
  input: Parameters<typeof adjudicate>[1];
  expected: "accept" | "reject" | "cannot_assess";
  criterion_expect?: Record<string, boolean>;
}

const cases: GoldCase[] = readFileSync(
  path.join(import.meta.dirname, "goldset.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as GoldCase);

describe.skipIf(!LIVE)("adjudicator gold set", () => {
  it.each(cases.map((c) => [c.id, c] as const))(
    "%s → %s", async (_id, c) => {
      const adj = await adjudicate(env as Env, c.input);
      const critReport = (adj.criteria ?? []).map(
        (cr) => `${cr.criterion}=${cr.pass}`).join(" ");
      // Verdict agreement — cannot_assess counts as agreement only when
      // expected; a reject-vs-cannot_assess swap is a calibration signal.
      expect.soft(adj.verdict,
        `${c.id}: got ${adj.verdict} (${critReport})`).toBe(c.expected);
      // Per-criterion agreement where labeled
      for (const [crit, want] of Object.entries(c.criterion_expect ?? {})) {
        const got = adj.criteria?.find((cr) => cr.criterion === crit);
        expect.soft(got?.pass, `${c.id}: criterion ${crit}`).toBe(want);
      }
    });
});
