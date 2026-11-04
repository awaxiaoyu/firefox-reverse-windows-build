import assert from "node:assert/strict";
import { ConfigStore } from "../modules/ConfigStore.sys.mjs";
import {
  createProviderAuthorizationUrl,
  importCliProxyFiles,
  parseCliProxyCredential,
  parseProviderCallback,
} from "../modules/ProviderAuth.sys.mjs";

const loginRows = [];
const loginManager = {
  findLogins: () => loginRows.slice(),
  addLogin: login => loginRows.push(login),
  removeLogin: login => loginRows.splice(loginRows.indexOf(login), 1),
  modifyLogin: (oldLogin, newLogin) => loginRows.splice(loginRows.indexOf(oldLogin), 1, newLogin),
};
const store = new ConfigStore(undefined, loginManager);
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

function cliCredential(type, extra = {}) {
  return {
    type,
    access_token: `access-${type}`,
    refresh_token: `refresh-${type}`,
    expired: "2026-10-30T12:00:00Z",
    ...extra,
  };
}

for (const [type, provider] of [
  ["codex", "openai-codex"],
  ["claude", "anthropic"],
  ["gemini-cli", "google-gemini-cli"],
  ["antigravity", "google-antigravity"],
]) {
  check(`CLIProxyAPI ${type} provider mapping`, () => {
    assert.equal(parseCliProxyCredential(cliCredential(type)).provider, provider);
  });
}

check("CLIProxyAPI project id and expiry are preserved", () => {
  const parsed = parseCliProxyCredential(cliCredential("gemini", { project_id: "project-a", email: "a@example.com" }));
  assert.equal(parsed.credential.projectId, "project-a");
  assert.equal(parsed.credential.expires, Date.parse("2026-10-30T12:00:00Z"));
});
check("filename fallback only accepts known type prefixes", () => {
  assert.equal(parseCliProxyCredential(cliCredential("unknown"), "codex-a@example.com.json").provider, "openai-codex");
  assert.throws(() => parseCliProxyCredential(cliCredential("unknown"), "account.json"), /无法识别/);
});
check("disabled credentials are skipped", () => {
  assert.throws(() => parseCliProxyCredential(cliCredential("codex", { disabled: true })), /disabled/);
});
check("missing expiry is rejected", () => {
  const invalid = cliCredential("codex");
  delete invalid.expired;
  assert.throws(() => parseCliProxyCredential(invalid), /expired/);
});

check("OAuth state is validated before token exchange", () => {
  assert.deepEqual(parseProviderCallback("http://localhost/callback?code=abc&state=right", "right"), {
    code: "abc",
    state: "right",
  });
  assert.throws(() => parseProviderCallback("http://localhost/callback?code=abc&state=wrong", "right"), /state/);
});
check("authorization URL carries PKCE, state, and provider scopes", () => {
  const url = new URL(createProviderAuthorizationUrl("openai-codex", { state: "state", challenge: "challenge" }));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state");
  assert.match(url.searchParams.get("scope"), /offline_access/);
});

const makeFile = (name, value) => ({ name, text: async () => JSON.stringify(value) });
const first = await importCliProxyFiles([
  makeFile("codex-user.json", cliCredential("codex", { account_id: "acct-1", email: "user@example.com" })),
  makeFile("claude-user.json", cliCredential("claude", { account_id: "acct-2", email: "user@example.com" })),
  makeFile("disabled.json", cliCredential("gemini", { disabled: true })),
], store);
check("mixed import creates valid accounts and reports rejected files", () => {
  assert.equal(first.imported.length, 2);
  assert.equal(first.skipped.length, 1);
  assert.equal(store.getActiveModelProfileId(), first.imported.at(-1).profile.id);
});
check("OAuth tokens stay in LoginManager instead of profile prefs", () => {
  const savedProfiles = store.b.getString("extensions.firefox-reverse.agent.modelProfiles.v1", "");
  assert.equal(savedProfiles.includes("refresh-codex"), false);
  assert.equal(loginRows.length, 2);
  assert.equal(store.getOAuthCredential(first.imported[0].profile.id).refresh, "refresh-codex");
});
const repeated = await importCliProxyFiles([
  makeFile("codex-user.json", cliCredential("codex", { account_id: "acct-1", email: "user@example.com", refresh_token: "rotated-refresh" })),
], store);
check("re-import updates the matching account without creating a duplicate", () => {
  assert.equal(repeated.imported.length, 1);
  assert.equal(store.listModelProfiles().filter(profile => profile.provider === "openai-codex").length, 1);
  assert.equal(loginRows.length, 2);
  assert.equal(store.getOAuthCredential(repeated.imported[0].profile.id).refresh, "rotated-refresh");
});
const duplicate = store.duplicateModelProfile(repeated.imported[0].profile.id);
check("duplicating an OAuth profile copies its LoginManager credential", () => {
  assert.equal(duplicate.authType, "oauth");
  assert.equal(store.getOAuthCredential(duplicate.id).refresh, "rotated-refresh");
  assert.equal(loginRows.length, 3);
});
store.deleteModelProfile(duplicate.id);
check("deleting an OAuth profile also removes its LoginManager credential", () => {
  const codexId = repeated.imported[0].profile.id;
  store.createModelProfile({ name: "Keep", provider: "deepseek" }, { activate: false });
  assert.equal(store.deleteModelProfile(codexId), true);
  assert.equal(store.getOAuthCredential(codexId), null);
});

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exitCode = failed ? 1 : 0;
