// webhook.live.test.mjs — gated end-to-end webhook test.
//
// Boots the REAL Probot app via probot's own `run()` — real HTTP server,
// real webhook signature verification, real app-authenticated Octokit,
// real GitHub API writes — then delivers REAL signed webhook HTTP
// requests and verifies the side effects landed on GitHub.
//
// Requires a GitHub App installed on TerexitariusStomp/widespread-sandbox:
//   E2E_LIVE=1 APP_ID=<id> PRIVATE_KEY=<path-or-pem> WEBHOOK_SECRET=<secret> \
//   GITHUB_TOKEN=<token for assertions> node --test test/webhook.live.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { run } from "probot";
import appFn from "../index.js";

const OWNER = "TerexitariusStomp";
const REPO = "widespread-sandbox";
const repo = { owner: OWNER, repo: REPO };
const PORT = 4177 + (Date.now() % 500); // high random-ish port per run

const LIVE = process.env.E2E_LIVE === "1";
const APP_ID = process.env.APP_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
let privateKey = process.env.PRIVATE_KEY;
const skipReason = !LIVE
  ? "set E2E_LIVE=1"
  : !APP_ID || !WEBHOOK_SECRET || !privateKey
    ? "requires APP_ID, PRIVATE_KEY, WEBHOOK_SECRET (GitHub App creds)"
    : null;

if (privateKey && !privateKey.includes("BEGIN")) {
  privateKey = readFileSync(privateKey, "utf-8");
}

let server;
const baseUrl = `http://127.0.0.1:${PORT}`;

function sign(body) {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

async function deliver(event, payload) {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/api/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": sign(body),
    },
    body,
  });
}

before(async () => {
  if (skipReason) return;
  process.env.APP_ID = APP_ID;
  process.env.PRIVATE_KEY = privateKey;
  process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PORT = String(PORT);
  server = await run(appFn, {
    host: "127.0.0.1",
    port: PORT,
    logLevel: "fatal",
  });
  // wait for the listener
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${baseUrl}/api/github/webhooks`, { method: "GET" });
      if (r.status) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (server?.stop) await server.stop();
  else if (server?.close) await new Promise((r) => server.close(r));
});

test("signed webhook seeds a real bounty", { skip: skipReason ?? false }, async () => {
  const token = process.env.GITHUB_TOKEN;
  assert.ok(token, "GITHUB_TOKEN needed to verify side effects");
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: token });

  const stamp = Date.now();
  const { data: issue } = await octokit.issues.create({
    ...repo, title: `webhook e2e ${stamp}`, body: "webhook-created issue",
  });

  // Deliver a REAL signed issue_comment webhook through the running app.
  const res = await deliver("issue_comment", {
    action: "created",
    repository: {
      name: REPO,
      full_name: `${OWNER}/${REPO}`,
      owner: { login: OWNER },
    },
    issue: {
      number: issue.number, title: issue.title, body: issue.body,
      labels: [], html_url: issue.html_url,
    },
    comment: {
      body: `@widespread $11 for webhook-delivered spec ${stamp} paypal: hook-${stamp}@example.com`,
      user: { login: OWNER },
    },
  });
  assert.ok(res.status < 300, `webhook POST failed: ${res.status} ${await res.text()}`);

  // Poll briefly — webhook handlers complete asynchronously after 200.
  let labels = [];
  for (let i = 0; i < 20; i++) {
    const { data } = await octokit.issues.get({ ...repo, issue_number: issue.number });
    labels = data.labels.map((l) => l.name);
    if (labels.includes("wide:funded")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(labels.includes("wide:funded"), `labels never appeared: ${labels}`);
});
