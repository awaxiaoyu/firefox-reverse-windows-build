import assert from "node:assert/strict";
import { LlmClient } from "../modules/LlmClient.sys.mjs";
import { getFreshOAuthCredential } from "../modules/ProviderAuth.sys.mjs";

let failed = 0;
function check(name, callback) {
  try {
    callback();
    console.log(`OK   ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}: ${error.message || error}`);
  }
}

const codex = new LlmClient({
  protocol: "openai-responses",
  providerId: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  chatPath: "/responses",
  apiKey: "access-codex",
  model: "gpt-6.1-sol",
});
codex.oauthCredential = { accountId: "chatgpt-account-1" };
let built = codex.buildRequest([{ role: "user", content: "hello" }], { stream: true });
check("Codex uses the ChatGPT Responses endpoint and OAuth headers", () => {
  assert.equal(built.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(built.init.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(built.init.headers["chatgpt-account-id"], "chatgpt-account-1");
  assert.equal(built.init.headers.originator, "firefox-reverse");
});

const claude = new LlmClient({
  protocol: "anthropic",
  providerId: "anthropic",
  baseUrl: "https://api.anthropic.com",
  chatPath: "/v1/messages",
  apiKey: "access-claude",
  model: "claude-opus-4-7",
});
claude.oauthCredential = { email: "user@example.com" };
built = claude.buildRequest([{ role: "user", content: "hello" }]);
check("Claude OAuth uses bearer auth and the OAuth beta header", () => {
  assert.equal(built.init.headers.Authorization, "Bearer access-claude");
  assert.equal(built.init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal("x-api-key" in built.init.headers, false);
});

for (const [providerId, baseUrl, model] of [
  ["google-gemini-cli", "https://cloudcode-pa.googleapis.com", "gemini-3.1-pro-preview"],
  ["google-antigravity", "https://daily-cloudcode-pa.googleapis.com", "gemini-3.1-pro"],
]) {
  const client = new LlmClient({
    protocol: "gemini",
    providerId,
    baseUrl,
    chatPath: "/v1internal:streamGenerateContent",
    apiKey: `access-${providerId}`,
    model,
  });
  client.oauthCredential = { projectId: "project-test" };
  client.projectId = "project-test";
  built = client.buildRequest([{ role: "user", content: "hello" }], { stream: true });
  const body = JSON.parse(built.init.body);
  check(`${providerId} uses its Cloud Code Assist request envelope`, () => {
    assert.equal(built.url, `${baseUrl}/v1internal:streamGenerateContent?alt=sse`);
    assert.equal(built.init.headers.Authorization, `Bearer access-${providerId}`);
    assert.equal(body.project, "project-test");
    assert.equal(body.model, model);
    assert.equal(body.request.contents[0].parts[0].text, "hello");
  });
  if (providerId === "google-antigravity") {
    check("Antigravity supplies its session and request identifiers", () => {
      assert.ok(body.request.sessionId);
      assert.ok(body.requestId);
      assert.equal(body.userAgent, "antigravity");
    });
  }
}

const originalFetch = globalThis.fetch;
let refreshCalls = 0;
globalThis.fetch = async (url, init) => {
  refreshCalls++;
  assert.equal(String(url), "https://auth.openai.com/oauth/token");
  assert.equal(new URLSearchParams(init.body).get("refresh_token"), "old-refresh");
  return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const stored = { access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 };
const refreshStore = {
  getOAuthCredential: () => stored,
  listModelProfiles: () => [{ id: "refresh-test-profile", provider: "openai-codex", authType: "oauth" }],
  setOAuthCredential: (_id, value) => Object.assign(stored, value),
};
const [refreshedA, refreshedB] = await Promise.all([
  getFreshOAuthCredential(refreshStore, "refresh-test-profile"),
  getFreshOAuthCredential(refreshStore, "refresh-test-profile"),
]);
check("concurrent requests share one OAuth refresh and persist token rotation", () => {
  assert.equal(refreshCalls, 1);
  assert.equal(refreshedA.access, "new-access");
  assert.equal(refreshedB.refresh, "new-refresh");
  assert.equal(stored.refresh, "new-refresh");
});

let finishStaleRefresh;
let currentCredential = { access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 };
let savedStaleRefresh = false;
globalThis.fetch = () => new Promise(resolve => { finishStaleRefresh = resolve; });
const staleRefresh = getFreshOAuthCredential({
  getOAuthCredential: () => currentCredential,
  listModelProfiles: () => [{ id: "stale-refresh-profile", provider: "openai-codex", authType: "oauth" }],
  setOAuthCredential: (_id, value) => { savedStaleRefresh = true; currentCredential = value; },
}, "stale-refresh-profile");
currentCredential = { access: "new-login-access", refresh: "new-login-refresh", expires: Date.now() + 3600_000 };
finishStaleRefresh(new Response(JSON.stringify({ access_token: "stale-access", expires_in: 3600 }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
}));
await assert.rejects(staleRefresh, /已更换或删除/);
check("late token refresh cannot overwrite credentials from a newer login", () => {
  assert.equal(savedStaleRefresh, false);
  assert.equal(currentCredential.access, "new-login-access");
});

let authReads = 0;
let requestCount = 0;
globalThis.fetch = async (_url, init) => {
  requestCount++;
  if (requestCount === 1) {
    assert.equal(init.headers.Authorization, "Bearer expired-access");
    return new Response("expired", { status: 401 });
  }
  assert.equal(init.headers.Authorization, "Bearer refreshed-access");
  return new Response(JSON.stringify({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const retryClient = new LlmClient({
  protocol: "openai-responses",
  providerId: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  chatPath: "/responses",
  model: "gpt-6.1-sol",
  oauth: {
    getCredential: async ({ forceRefresh } = {}) => {
      authReads++;
      return { access: forceRefresh ? "refreshed-access" : "expired-access", accountId: "acct" };
    },
  },
});
const reply = await retryClient.chat([{ role: "user", content: "hello" }]);
check("one 401 triggers one forced refresh and retries the request", () => {
  assert.equal(authReads, 2);
  assert.equal(requestCount, 2);
  assert.equal(reply.content, "ok");
});
globalThis.fetch = originalFetch;

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exitCode = failed ? 1 : 0;
