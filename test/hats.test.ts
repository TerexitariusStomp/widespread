import { describe, expect, it } from "vitest";
import {
  stanceScore, earnedStance, estCost,
  parseIdentityRef, mechanismList, type HatRecord,
} from "../src/hats";

const hat = (over: Partial<HatRecord> = {}): HatRecord => ({
  hatId: "6", orgId: "2", name: "worker-agent",
  parentHatId: "5", adminHatId: "5", accountableTo: "5",
  wearer: "agent.near", permissions: ["market:claim"], status: "active",
  foreign: { chain: "solana", path: "solana-1", keyType: "ed25519" },
  identityRef: "erc8004:8453:12345",
  constitutionRef: null,
  stance: { prefs: { "oss-infra": 0.8, climate: -0.4, docs: 0.5 },
            vetoes: ["surveillance"] },
  createdAt: "0",
  ...over,
});

describe("stanceScore", () => {
  it("scores aligned specs positive, misaligned negative", () => {
    const h = hat();
    expect(stanceScore(h, "refactor the protocol infra").support).toBe(true);
    expect(stanceScore(h, "climate carbon offset marketplace").score).toBeLessThan(0);
  });
  it("vetoes are absolute", () => {
    const h = hat();
    const r = stanceScore(h, "build surveillance tracking module");
    expect(r.support).toBe(false);
    expect(r.reasons.join()).toMatch(/veto/);
  });
});

describe("earnedStance", () => {
  it("boosts domains with paid verdicts, penalizes refunds", () => {
    const h = hat();
    const es = earnedStance(h, [
      { spec: "oss infra refactor", outcome: "paid" },
      { spec: "surveillance docs", outcome: "refunded" },
    ]);
    expect(es.prefs["oss-infra"]).toBeGreaterThan(0.8);
    expect(es.earned["docs"]).toBeLessThan(0);
    expect(es.verdictsUsed).toBe(2);
  });
  it("ignores unknown outcomes", () => {
    const es = earnedStance(hat(), [{ spec: "x", outcome: "maybe" }]);
    expect(es.verdictsUsed).toBe(0);
  });
});

describe("estCost", () => {
  it("ranks complex specs above docs", () => {
    expect(estCost("smart contract audit security")).toBeGreaterThan(
      estCost("fix readme typo"));
  });
});

describe("parseIdentityRef", () => {
  it("parses ERC-8004 refs", () => {
    expect(parseIdentityRef("erc8004:8453:12345"))
      .toEqual({ kind: "erc8004", chainId: 8453, agentId: "12345" });
  });
  it("parses atproto and near refs", () => {
    expect(parseIdentityRef("at://did:plc:abc/org.simocracy.sim/self")?.kind).toBe("atproto");
    expect(parseIdentityRef("agent.near")).toEqual({ kind: "near", account: "agent.near" });
    expect(parseIdentityRef("weird-string")?.kind).toBe("opaque");
    expect(parseIdentityRef(null)).toBeNull();
  });
});

describe("mechanismList", () => {
  it("advertises simocracy-compatible mechanisms", () => {
    const m = mechanismList().mechanisms;
    expect(m.map(x => x.id)).toContain("widespread.stake-check");
    expect(m.map(x => x.id)).toContain("widespread.opportunity-ranking");
  });
});
