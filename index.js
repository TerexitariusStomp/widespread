/**
 * widespread-bot — the forge-native surface on GitHub.
 * @widespread $N for <spec>  → labels + spec comment + escrow link
 * merge of a PR with `closes #N`  → merge=accept → triggers bridge review → payout
 * receipt writeback → the payout lands in the PR's own thread permanently.
 */
const BRIDGE = process.env.WIDE_BRIDGE || "https://widespread-bridge.widespread.workers.dev";
const FORGE = process.env.WIDE_FORGE || "https://code.widespread.fyi";
// Review-ish apps whose check-run success counts as a verdict. CI checks
// (build/test) are evidence for the adjudicator, not acceptance by themselves.
const REVIEWISH = /coderabbit|greptile|copilot|qodo|bugbot|review|coderabbitai/i;
const seen = new Set(); // `${repo}#${issue}:${bot}:${sha}` — one verdict per head

module.exports = (app) => {
  app.log.info("widespread-bot up");

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

  /** PR → linked wide:funded issue → {issueNum, amount, paypal}. */
  async function fundedIssue(ctx, prBody) {
    const ref = (prBody || "").match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    if (!ref) return null;
    const issueNum = Number(ref[1]);
    const issue = await ctx.octokit.issues.get({ ...ctx.issue(), issue_number: issueNum }).catch(() => null);
    const funded = (issue?.data?.labels ?? []).find((l) => /wide:funded/i.test(l.name || ""));
    if (!funded) return null;
    const amount = ((funded.name || "").match(/\$?([\d.]+)/) || [])[1] ?? "1.00";
    // payout binding: paypal:/payout: email in issue body or the market comment
    let paypal = (issue.data.body || "").match(/(?:paypal|payout):\s*(\S+@\S+)/i)?.[1] ?? "";
    if (!paypal) {
      const comments = await ctx.octokit.issues.listComments({ ...ctx.issue(), issue_number: issueNum, per_page: 10 }).catch(() => ({ data: [] }));
      paypal = (comments.data.map((c) => c.body || "").join("\n").match(/(?:paypal|payout):\s*(\S+@\S+)/i) || [])[1] ?? "";
    }
    return { issueNum, amount, paypal };
  }

  /** A parsed verdict on a funded PR → signed oracle verdict + payout. */
  async function emitVerdict(ctx, { pr, market, verdict }) {
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    const key = `${repo}#${market.issueNum}:${verdict.bot}:${pr.head?.sha ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const res = await fetch(`${BRIDGE}/api/bot-verdict`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo, pr: pr.number, issue: market.issueNum,
        bot: verdict.bot, score: verdict.score, verdict: verdict.verdict,
        head_sha: pr.head?.sha ?? "", amount: market.amount, paypal_email: market.paypal || undefined,
      }),
    }).catch((e) => ({ ok: false, json: async () => ({ error: String(e) }) }));
    const out = await res.json().catch(() => ({}));
    app.log.info({ repo, pr: pr.number, ...verdict, out: out.status }, "bot verdict");
    if (verdict.verdict === "accept" && pr.number) {
      await ctx.octokit.issues.createComment({ ...ctx.issue(), issue_number: pr.number,
        body: `@widespread **${verdict.bot} verdict: ${verdict.score}** → \`${out.status ?? "pending"}\`` +
              (out.record?.oracle_verdict_sig ? `\noracle_sig \`${out.record.oracle_verdict_sig.slice(0, 16)}…\`` : "") +
              `\nreceipt → ${BRIDGE}/api/bot-verdicts` }).catch(() => {});
    }
  }

  // PR review submitted (Copilot APPROVED, reviewer bots, etc.)
  app.on("pull_request_review.submitted", async (ctx) => {
    const pr = ctx.payload.pull_request, review = ctx.payload.review;
    const market = await fundedIssue(ctx, `${pr.body || ""} ${pr.title || ""}`);
    if (!market) return;
    const v = parseBotVerdict({ login: review.user?.login, body: review.body || "", state: review.state });
    if (v) await emitVerdict(ctx, { pr, market, verdict: v });
  });

  // PR conversation comment by a bot (Greptile summary, CodeRabbit notes)
  app.on("issue_comment.created", async (ctx) => {
    if (!ctx.payload.issue?.pull_request) return; // PR comments only
    const pr = await ctx.octokit.pulls.get({ ...ctx.issue(), pull_number: ctx.payload.issue.number }).catch(() => null);
    if (!pr) return;
    const market = await fundedIssue(ctx, `${pr.data.body || ""} ${pr.data.title || ""}`);
    if (!market) return;
    const v = parseBotVerdict({ login: ctx.payload.comment.user?.login, body: ctx.payload.comment.body || "" });
    if (v) await emitVerdict(ctx, { pr: pr.data, market, verdict: v });
  });

  // Check suite completed (review-ish apps only — CI alone isn't acceptance)
  app.on(["check_suite.completed", "check_run.completed"], async (ctx) => {
    const suite = ctx.payload.check_suite;
    const conclusion = suite?.conclusion ?? ctx.payload.check_run?.conclusion;
    const appSlug = suite?.app?.slug ?? ctx.payload.check_run?.app?.slug ?? "";
    const login = suite?.app?.name ?? ctx.payload.check_run?.app?.name ?? "";
    const prs = suite?.pull_requests ?? ctx.payload.check_run?.pull_requests ?? [];
    for (const pref of prs) {
      const pr = await ctx.octokit.pulls.get({ ...ctx.issue(), pull_number: pref.number }).catch(() => null);
      if (!pr) continue;
      const market = await fundedIssue(ctx, `${pr.data.body || ""} ${pr.data.title || ""}`);
      if (!market) continue;
      const headSha = pr.data.head?.sha ?? "";
      const v = parseBotVerdict({ login, appSlug, conclusion, body: "" });
      if (v) await emitVerdict(ctx, { pr: { ...pr.data, head: { sha: headSha } }, market, verdict: v });
    }
  });

  // ---- @widespread $N for <spec> on issues/comments → seed a market ----
  app.on(["issue_comment.created"], async (ctx) => {
    const body = ctx.payload.comment.body || "";
    const m = body.match(/@widespread\s+\$?([\d.]+)\s+(?:for\s+)?([\s\S]+)/i);
    if (!m) return;
    const [_, amount, specRaw] = m;
    const paypal = (specRaw.match(/paypal:\s*(\S+@\S+)/i) || [])[1] ?? "";
    const spec = specRaw.replace(/\s*paypal:\s*\S+@\S+/i, "").trim();
    const issue = ctx.payload.issue;
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    // label + spec comment = the forge-native market record
    await ctx.octokit.issues.addLabels({ ...ctx.issue(), labels: [`wide:funded:$${amount}`] });
    await ctx.octokit.issues.createComment({ ...ctx.issue(),
      body: `@widespread market — **$${amount}** for \`${spec.slice(0, 140)}\`\n` +
            `market_id: \`${repo}#${issue.number}\` · specHash pinned · escrow → ${BRIDGE}/api/markets` +
            (paypal ? `\npayout: ${paypal}` : "") });
    app.log.info({ repo, amount }, "bounty seeded");
  });

  // ---- PR merge = accept → trigger the bridge review → payout ----
  app.on("pull_request.closed", async (ctx) => {
    const pr = ctx.payload.pull_request;
    if (!pr.merged) return;
    const repo = `${ctx.payload.repository.owner.login}/${ctx.payload.repository.name}`;
    // find a wide-funded issue this PR closes
    const body = (pr.body || "") + " " + (pr.title || "");
    const ref = body.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
    if (!ref) return;
    const issueNum = ref[1];
    const issue = await ctx.octokit.issues.get({ ...ctx.issue(), issue_number: Number(issueNum) });
    const funded = (issue.data.labels || []).some((l) => /wide:funded/i.test(l.name || l));
    if (!funded) return;
    // merge=accept: trigger bridge adjudication on the merge commit
    const res = await fetch(`${BRIDGE}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, seq: 0, commits: [pr.merge_commit_sha], accept: true, merge_sha: pr.merge_commit_sha }),
    }).catch((e) => ({ ok: false, text: () => String(e) }));
    const out = await res.json?.().catch?.(() => ({}));
    // receipt lands in the PR thread — permanent repo history
    await ctx.octokit.issues.createComment({ ...ctx.issue(), issue_number: pr.number,
      body: `@widespread **merge = accept**\n` +
            `commit \`${pr.merge_commit_sha.slice(0, 10)}\` → review: \`${out.status ?? out.adjudication ?? "pending"}\`\n` +
            `receipt → ${BRIDGE}/api/markets` });
    app.log.info({ repo, sha: pr.merge_commit_sha }, "merge=accept triggered");
  });
};
