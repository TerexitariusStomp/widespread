import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBotVerdict } from "../verdict.js";

test("coderabbit: 0 actionable → accept 5/5", () => {
  const v = parseBotVerdict({
    login: "coderabbitai[bot]",
    body: "## Summary\nActionable comments posted: 0",
  });
  assert.deepEqual(v, { bot: "coderabbitai", score: "5/5", verdict: "accept" });
});

test("coderabbit: 3 actionable → reject 2/5", () => {
  const v = parseBotVerdict({
    login: "coderabbitai[bot]",
    body: "Actionable comments posted: 3",
  });
  assert.equal(v.verdict, "reject");
  assert.equal(v.score, "2/5");
});

test("greptile confidence 5/5 → accept", () => {
  const v = parseBotVerdict({
    login: "greptile-apps[bot]",
    body: "Greptile confidence score: 5/5 — looks good",
  });
  assert.equal(v.verdict, "accept");
  assert.equal(v.score, "5/5");
});

test("greptile confidence 2/5 → reject", () => {
  const v = parseBotVerdict({
    login: "greptile-apps[bot]",
    body: "confidence: 2/5 needs work",
  });
  assert.equal(v.verdict, "reject");
});

test("copilot APPROVED review → accept", () => {
  const v = parseBotVerdict({ login: "copilot-pull-request-reviewer[bot]", state: "APPROVED", body: "" });
  assert.equal(v.verdict, "accept");
  assert.equal(v.score, "approved");
});

test("CHANGES_REQUESTED → reject", () => {
  const v = parseBotVerdict({ login: "coderabbitai[bot]", state: "CHANGES_REQUESTED", body: "fix this" });
  assert.equal(v.verdict, "reject");
});

test("review-ish check success → accept; plain CI ignored", () => {
  assert.equal(
    parseBotVerdict({ appSlug: "greptile", conclusion: "success" }).verdict, "accept",
  );
  assert.equal(parseBotVerdict({ appSlug: "github-actions", conclusion: "success" }), null);
});

test("human comments and non-review bots → null", () => {
  assert.equal(parseBotVerdict({ login: "shredder", body: "lgtm" }), null);
  assert.equal(parseBotVerdict({ login: "dependabot[bot]", body: "bump lodash" }), null);
  assert.equal(parseBotVerdict({}), null);
});
