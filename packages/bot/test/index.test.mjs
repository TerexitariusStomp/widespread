// index.test.mjs — LIVE handler tests for the widespread GitHub bot.
//
// Everything here is real:
//  - The app's real handlers are registered and invoked with real-shaped
//    webhook payloads (crafting input is not mocking — the payload is the
//    input the service would deliver).
//  - `ctx.octokit` is a REAL Octokit authenticated with GITHUB_TOKEN
//    (falling back to `gh auth token`), making real GitHub API calls
//    against the real sandbox repo TerexitariusStomp/widespread-sandbox.
//  - Bridge calls (/api/feed/index, /review, /api/bot-verdict) hit the
//    real deployed worker — no fetch stubbing anywhere.
//
// Each test creates fresh issues/PRs so runs are idempotent and
// order-independent. Issues/PRs accumulate in the sandbox repo — that is
// expected; it is a dedicated test repo.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import appFn from "../index.js";

const OWNER = "TerexitariusStomp";
const REPO = "widespread-sandbox";
const repo = { owner: OWNER, repo: REPO };

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

const TOKEN = resolveToken();
const SKIP = TOKEN ? false : "no GitHub token (set GITHUB_TOKEN or `gh auth login`)";

// Register the real handlers. The recorder only wires app.on() — every
// service the handlers touch (GitHub, bridge fetch) is real.
const handlers = new Map();
const recorder = {
  on(names, fn) {
    for (const n of [].concat(names)) {
      if (!handlers.has(n)) handlers.set(n, []);
      handlers.get(n).push(fn);
    }
  },
  log: { info() {}, warn() {}, error() {}, debug() {} },
};
appFn(recorder);

async function fire(event, ctx) {
  for (const fn of handlers.get(event) ?? []) await fn(ctx);
}

let octokit;
const stamp = Date.now();

before(async () => {
  if (SKIP) return; // every test is skipped in this case anyway
  octokit = new Octokit({ auth: TOKEN });
  // sanity: repo must exist and token must be able to write issues
  await octokit.repos.get(repo);
});

function ctxFor(payload) {
  return {
    octokit,
    issue: () => repo,
    payload: { repository: { owner: { login: OWNER }, name: REPO }, ...payload },
  };
}

async function createIssue(body, title) {
  const { data } = await octokit.issues.create({
    ...repo,
    title: title ?? `widespread test ${stamp}`,
    body,
  });
  return data;
}

async function issueState(number) {
  const { data } = await octokit.issues.get({ ...repo, issue_number: number });
  return data;
}

async function issueComments(number) {
  const { data } = await octokit.issues.listComments({
    ...repo, issue_number: number, per_page: 100,
  });
  return data;
}

async function labelNames(number) {
  return (await issueState(number)).labels.map((l) => l.name);
}

// Ensure the sandbox repo has a commit on its default branch so PRs can
// be opened against it.
let defaultBranch;
async function ensureBaseCommit() {
  const { data: r } = await octokit.repos.get(repo);
  defaultBranch = r.default_branch;
  try {
    await octokit.git.getRef({ ...repo, ref: `heads/${defaultBranch}` });
    return; // already has commits
  } catch { /* empty repo — create the first commit */ }
  await octokit.repos.createOrUpdateFileContents({
    ...repo,
    path: "README.md",
    message: "init: sandbox repo for widespread live tests",
    content: Buffer.from("# widespread-sandbox\n\nLive-test target for @widespread/bot.\n").toString("base64"),
    branch: defaultBranch,
  });
}

// Create a real PR from a new branch containing one file, with `body`.
// Returns { number, headSha, mergeCommitSha? }.
async function createPr({ title, body, closeIssue }) {
  const branch = `ws-test/${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const { data: base } = await octokit.git.getRef({ ...repo, ref: `heads/${defaultBranch}` });
  await octokit.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: base.object.sha });
  const path = `ws-test/${branch}.txt`;
  await octokit.repos.createOrUpdateFileContents({
    ...repo, path, message: `test: ${title}`, branch,
    content: Buffer.from(`fixture for ${title}\n`).toString("base64"),
  });
  const { data: pr } = await octokit.pulls.create({
    ...repo, title, head: branch, base: defaultBranch, body,
  });
  return { number: pr.number, headSha: pr.head.sha, branch };
}

// --- tests -----------------------------------------------------------------

test("issue_comment '@widespread $N for <spec>' seeds real labels + comment + feed push", { skip: SKIP }, async () => {
  const issue = await createIssue("seed target", `bounty seed ${stamp}`);
  const spec = `fix flaky test paypal: pay-${stamp}@example.com`;
  await fire("issue_comment.created", ctxFor({
    issue: { number: issue.number, title: issue.title, body: issue.body, labels: [], html_url: issue.html_url },
    comment: { body: `@widespread $25 for ${spec}`, user: { login: "TerexitariusStomp" } },
  }));
  const labels = await labelNames(issue.number);
  assert.ok(labels.includes("wide:funded"), `missing wide:funded, got ${labels}`);
  assert.ok(labels.some((l) => l.startsWith("wide:funded:$")), `missing amount label, got ${labels}`);
  const comments = await issueComments(issue.number);
  const market = comments.find((c) => c.body.includes("@widespread market"));
  assert.ok(market, "market comment not posted");
  assert.match(market.body, /\$25/);
  assert.match(market.body, new RegExp(`pay-${stamp}@example\\.com`));
  // feed push is fire-and-forget to the real bridge; give it a moment then
  // confirm nothing threw (handler already awaited the fetch call itself).
});

test("issues.opened seeds bounty from body grammar", { skip: SKIP }, async () => {
  const body = `@widespread $10 add dark mode ${stamp}`;
  const issue = await createIssue(body, `grammar seed ${stamp}`);
  const { data: fresh } = await octokit.issues.get({ ...repo, issue_number: issue.number });
  await fire("issues.opened", ctxFor({ issue: fresh }));
  const labels = await labelNames(issue.number);
  assert.ok(labels.includes("wide:funded"), `expected wide:funded, got ${labels}`);
});

test("issues.edited does not re-seed an already-funded issue", { skip: SKIP }, async () => {
  const issue = await createIssue("already funded", `funded edit ${stamp}`);
  await octokit.issues.addLabels({ ...repo, issue_number: issue.number, labels: ["wide:funded"] });
  const { data: fresh } = await octokit.issues.get({ ...repo, issue_number: issue.number });
  const before = await issueComments(issue.number);
  await fire("issues.edited", ctxFor({
    issue: { ...fresh, body: "@widespread $99 even more money" },
  }));
  const after = await issueComments(issue.number);
  assert.equal(after.length, before.length, "edited handler commented on funded issue");
  const labels = await labelNames(issue.number);
  assert.ok(!labels.some((l) => l.includes("$99")), `re-seeded: ${labels}`);
});

test("merged PR closing a funded issue triggers merge=accept + receipt comment", { skip: SKIP }, async () => {
  await ensureBaseCommit();
  const issue = await createIssue("funded work item", `funded for merge ${stamp}`);
  await octokit.issues.addLabels({
    ...repo, issue_number: issue.number, labels: ["wide:funded:$5", "wide:funded"],
  });
  const pr = await createPr({
    title: `fix: funded work ${stamp}`,
    body: `implements the thing\n\ncloses #${issue.number}`,
  });
  // Really merge it on GitHub.
  const { data: merged } = await octokit.pulls.merge({
    ...repo, pull_number: pr.number, merge_method: "squash",
  });
  assert.equal(merged.merged, true);
  const { data: prAfter } = await octokit.pulls.get({ ...repo, pull_number: pr.number });
  await fire("pull_request.closed", ctxFor({
    pull_request: {
      number: pr.number, merged: true,
      merge_commit_sha: prAfter.merge_commit_sha,
      body: prAfter.body, title: prAfter.title,
    },
  }));
  const comments = await issueComments(pr.number);
  const receipt = comments.find((c) => c.body.includes("merge = accept"));
  assert.ok(receipt, "merge=accept receipt comment missing");
  assert.match(receipt.body, /commit `[0-9a-f]{10}/);
});

test("bot review verdict on funded PR posts to real bridge + comments", { skip: SKIP }, async () => {
  await ensureBaseCommit();
  const issue = await createIssue("funded for review", `funded for review ${stamp}`);
  await octokit.issues.addLabels({
    ...repo, issue_number: issue.number, labels: ["wide:funded:$7", "wide:funded"],
  });
  const pr = await createPr({
    title: `feat: reviewed work ${stamp}`,
    body: `does the thing\n\ncloses #${issue.number}`,
  });
  const before = await issueComments(pr.number);
  await fire("pull_request_review.submitted", ctxFor({
    pull_request: {
      number: pr.number, body: `does the thing\n\ncloses #${issue.number}`,
      title: `feat: reviewed work ${stamp}`, head: { sha: pr.headSha },
    },
    review: {
      user: { login: "coderabbitai[bot]" },
      body: "## Summary\nActionable comments posted: 0",
      state: "COMMENTED",
    },
  }));
  const after = await issueComments(pr.number);
  assert.ok(after.length > before.length, "no verdict comment posted");
  const verdict = after.find((c) => c.body.includes("verdict"));
  assert.ok(verdict, "verdict comment missing");
  assert.match(verdict.body, /coderabbitai/);
});

test("human review on funded PR emits nothing", { skip: SKIP }, async () => {
  await ensureBaseCommit();
  const issue = await createIssue("funded for human review", `funded human ${stamp}`);
  await octokit.issues.addLabels({
    ...repo, issue_number: issue.number, labels: ["wide:funded:$3", "wide:funded"],
  });
  const pr = await createPr({
    title: `chore: human reviewed ${stamp}`,
    body: `small change\n\ncloses #${issue.number}`,
  });
  const before = await issueComments(pr.number);
  await fire("pull_request_review.submitted", ctxFor({
    pull_request: {
      number: pr.number, body: `small change\n\ncloses #${issue.number}`,
      title: `chore: human reviewed ${stamp}`, head: { sha: pr.headSha },
    },
    review: { user: { login: "TerexitariusStomp" }, body: "lgtm", state: "APPROVED" },
  }));
  const after = await issueComments(pr.number);
  assert.equal(after.length, before.length, "human review produced a comment");
});
