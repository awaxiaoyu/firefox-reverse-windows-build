import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const sidebar = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(sidebar, "node_modules/.settings-auth-test-"));
let root = null;
let reactAct = null;
try {
  await build({
    absWorkingDir: sidebar,
    entryPoints: ["content/SettingsPane.jsx"],
    outdir: temp,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["react", "react-dom"],
    outExtension: { ".js": ".mjs" },
    logLevel: "error",
  });
  const reactModule = await import("react");
  const React = reactModule.default;
  reactAct = reactModule.act;
  const { createRoot } = await import("react-dom/client");
  const { default: SettingsPane } = await import(pathToFileURL(join(temp, "SettingsPane.mjs")));
  let profile = {
    id: "profile-oauth",
    name: "Codex",
    provider: "openai-codex",
    authType: "oauth",
    apiKey: "",
    model: "gpt-6.1-sol",
    baseUrl: "",
    protocol: "openai-responses",
  };
  let credential = null;
  let importedFiles = null;
  const store = {
    listModelProfiles: () => [{ ...profile }],
    getActiveModelProfileId: () => profile.id,
    setActiveModelProfileId: () => ({ ...profile }),
    updateModelProfile: (_id, patch) => (profile = { ...profile, ...patch }),
    setOAuthCredential: (_id, value) => { credential = value; },
    getConfirmTools: () => false,
    getGlobalSystemPrompt: () => "",
    getPromptCacheMode: () => "auto",
    getPromptCacheTtl: () => "default",
    getContextStrategy: () => "projected",
  };
  const importedProfile = { ...profile, id: "profile-imported", name: "Imported account" };
  const providerAuth = {
    loginProvider: async provider => {
      assert.equal(provider, "openai-codex");
      return { access: "oauth-access", refresh: "oauth-refresh", expires: Date.now() + 3600_000, email: "user@example.com" };
    },
    importCliProxyFiles: async files => {
      importedFiles = files;
      profile = importedProfile;
      return { imported: [{ profile: importedProfile }], skipped: [] };
    },
  };
  root = createRoot(document.getElementById("root"));
  await reactAct(async () => {
    root.render(React.createElement(SettingsPane, {
      store,
      providerAuth,
      providers: [{
        id: "openai-codex",
        label: "OpenAI Codex（ChatGPT 订阅）",
        oauth: true,
        defaultModel: "gpt-6.1-sol",
        models: ["gpt-6.1-sol"],
      }],
    }));
  });

  assert(document.body.textContent.includes("导入账号文件"), "OAuth account controls render");
  assert.equal(document.querySelector('input[type="password"]'), null, "OAuth profile does not show an API key field");
  await reactAct(async () => {
    [...document.querySelectorAll("button")].find(button => button.textContent.includes("登录 OpenAI Codex"))
      .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(credential.refresh, "oauth-refresh", "login result is saved through the credential store");
  assert.equal(profile.authType, "oauth", "login keeps the profile in OAuth mode");

  const input = document.querySelector('input[type="file"][multiple]');
  const file = { name: "codex-user.json", text: async () => "{}" };
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await reactAct(async () => {
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  assert.equal(importedFiles[0], file, "selected JSON files reach the importer");
  assert(document.body.textContent.includes("已导入 1 个账号配置"), "successful import updates the visible profile");
  console.log("settings auth selftest: 5 passed");
} finally {
  if (root) await reactAct(() => root.unmount());
  await rm(temp, { recursive: true, force: true });
}
process.exit(0);
