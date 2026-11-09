// Review-bot verdict parser — pure functions, shared by index.js and tests.
// Any PR bot's public verdict becomes a wide-verdict oracle input.

// Review-ish apps whose check-run success counts as a verdict. CI checks
// (build/test) are evidence for the adjudicator, not acceptance by themselves.
const REVIEWISH = /coderabbit|greptile|copilot|qodo|bugbot|review|coderabbitai/i;

/** Parse a review bot's public verdict → {bot, score, verdict} or null. */
function parseBotVerdict({ login = "", body = "", state = "", conclusion = "", appSlug = "" }) {
  const who = `${login} ${appSlug}`.toLowerCase();
  const isBot = who.includes("[bot]") || REVIEWISH.test(who);
  if (!isBot) return null;
  const name = (login || appSlug || "bot").replace(/\[bot\]/gi, "").toLowerCase();
  // CodeRabbit summary: "Actionable comments posted: N"
  const cr = body.match(/actionable comments posted:\s*(\d+)/i);
  if (cr) {
    const n = Number(cr[1]);
    return { bot: name || "coderabbit", score: `${5 - n}/5`, verdict: n === 0 ? "accept" : "reject" };
  }
  // Greptile-style confidence score "X/5"
  const gt = body.match(/confidence[^\d]{0,20}(\d)\s*\/\s*5/i);
  if (gt) {
    const s = Number(gt[1]);
    return { bot: name || "greptile", score: `${s}/5`, verdict: s >= 4 ? "accept" : "reject" };
  }
  // Native review states (Copilot, generic reviewers)
  if (state === "APPROVED") return { bot: name, score: "approved", verdict: "accept" };
  if (state === "CHANGES_REQUESTED") return { bot: name, score: "changes_requested", verdict: "reject" };
  // Check runs — only review-ish apps; plain CI success is not acceptance.
  if (conclusion === "success" && REVIEWISH.test(who)) return { bot: name, score: "check:success", verdict: "accept" };
  if (conclusion === "failure" && REVIEWISH.test(who)) return { bot: name, score: "check:failure", verdict: "reject" };
  return null;
}

export { parseBotVerdict, REVIEWISH };
