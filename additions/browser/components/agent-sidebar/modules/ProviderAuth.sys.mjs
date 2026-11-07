const PROVIDERS = Object.freeze({
  "openai-codex": {
    label: "Codex",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    redirectUri: "http://localhost:1455/auth/callback",
    callbackPort: 1455,
    callbackPath: "/auth/callback",
    scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  },
  anthropic: {
    label: "Claude",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    redirectUri: "http://localhost:54545/callback",
    callbackPort: 54545,
    callbackPath: "/callback",
    scopes: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  },
  "google-gemini-cli": {
    label: "Gemini CLI",
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    redirectUri: "http://127.0.0.1:8085/oauth2callback",
    callbackPort: 8085,
    callbackPath: "/oauth2callback",
    scopes: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
  },
  "google-antigravity": {
    label: "Antigravity",
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    redirectUri: "http://127.0.0.1:51121/oauth-callback",
    callbackPort: 51121,
    callbackPath: "/oauth-callback",
    scopes: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/aicode",
  },
});

const CLIPROXY_TYPES = Object.freeze({
  codex: "openai-codex",
  claude: "anthropic",
  gemini: "google-gemini-cli",
  "gemini-cli": "google-gemini-cli",
  antigravity: "google-antigravity",
});

const DEFAULT_MODELS = Object.freeze({
  "openai-codex": "gpt-6.1-sol",
  anthropic: "claude-opus-4-7",
  "google-gemini-cli": "gemini-3.1-pro-preview",
  "google-antigravity": "gemini-3.1-pro",
});

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createPkce() {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function createProviderAuthorizationUrl(providerId, { state, challenge }) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`不支持 OAuth provider：${providerId}`);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    scope: provider.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (providerId === "openai-codex") {
    params.set("id_token_add_organizations", "true");
    params.set("codex_cli_simplified_flow", "true");
    params.set("originator", "firefox-reverse");
  } else if (providerId === "anthropic") {
    params.set("code", "true");
  } else {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  return `${provider.authorizeUrl}?${params}`;
}

export function parseProviderCallback(value, expectedState) {
  const url = new URL(value);
  const params = url.searchParams;
  if (params.get("error")) {
    throw new Error(params.get("error_description") || params.get("error"));
  }
  if (!params.get("code")) throw new Error("OAuth 回调没有 authorization code");
  if (!expectedState || params.get("state") !== expectedState) {
    throw new Error("OAuth state 不匹配，已拒绝此次登录回调");
  }
  return { code: params.get("code"), state: params.get("state") };
}

function createCallbackServer(providerId, expectedState) {
  const provider = PROVIDERS[providerId];
  // XPCOM aliases in Firefox chrome modules are often lexical globals rather
  // than properties on globalThis.  Prefer those aliases, then retain the
  // property/Components fallbacks used by test harnesses and older shells.
  const classes = (typeof Cc !== "undefined" ? Cc : null) || globalThis.Cc || globalThis.Components?.classes;
  const interfaces = (typeof Ci !== "undefined" ? Ci : null) || globalThis.Ci || globalThis.Components?.interfaces;
  const results = (typeof Cr !== "undefined" ? Cr : null) || globalThis.Cr || globalThis.Components?.results;
  if (!classes || !interfaces) throw new Error("Firefox loopback OAuth 服务不可用");

  const server = classes["@mozilla.org/network/server-socket;1"].createInstance(interfaces.nsIServerSocket);
  try {
    server.init(provider.callbackPort, true, -1);
  } catch (error) {
    throw new Error(`OAuth 回调端口 ${provider.callbackPort} 无法监听：${error.message || error}`);
  }

  let settle;
  let timer;
  const activeTransports = new Set();
  const callback = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (error, value) => {
    if (!settle) return;
    const current = settle;
    settle = null;
    clearTimeout(timer);
    try { server.close(); } catch {}
    for (const transport of activeTransports) {
      try { transport.close(results?.NS_BINDING_ABORTED ?? results?.NS_OK ?? 0); } catch {}
    }
    activeTransports.clear();
    if (error) current.reject(error);
    else current.resolve(value);
  };
  timer = setTimeout(() => finish(new Error("OAuth 登录等待超时，请重新登录")), 5 * 60 * 1000);

  server.asyncListen({
    QueryInterface: globalThis.ChromeUtils?.generateQI?.(["nsIServerSocketListener"]),
    onSocketAccepted(_socket, transport) {
      activeTransports.add(transport);
      try {
        const input = transport.openInputStream(0, 0, 0);
        const output = transport.openOutputStream(0, 0, 0);
        const pump = classes["@mozilla.org/network/input-stream-pump;1"].createInstance(interfaces.nsIInputStreamPump);
        let request = "";
        let handled = false;
        const respond = (status, title, message) => {
          if (handled) return;
          handled = true;
          const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${message}</p><p>You can return to Firefox Reverse.</p><script>history.replaceState(null,"",location.pathname)</script>`;
          const response = `HTTP/1.1 ${status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
          output.write(response, response.length);
          output.close();
          transport.close(results?.NS_OK ?? 0);
        };
        const listener = {
          QueryInterface: globalThis.ChromeUtils?.generateQI?.(["nsIStreamListener"]),
          onStartRequest() {},
          onDataAvailable(_request, stream, _offset, count) {
            if (handled) return;
            const binary = classes["@mozilla.org/binaryinputstream;1"].createInstance(interfaces.nsIBinaryInputStream);
            binary.setInputStream(stream);
            request += binary.readBytes(count);
            const end = request.indexOf("\r\n");
            if (end < 0) return;
            const match = /^GET\s+(\S+)\s+HTTP\//.exec(request.slice(0, end));
            if (!match) {
              respond("400 Bad Request", "Invalid OAuth callback", "Unexpected callback request.");
              finish(new Error("OAuth 回调请求无效"));
              return;
            }
            const target = new URL(match[1], provider.redirectUri);
            if (target.pathname !== provider.callbackPath) {
              respond("404 Not Found", "Not found", "This path is not an OAuth callback.");
              return;
            }
            if (target.searchParams.get("state") !== expectedState) {
              respond("400 Bad Request", "Login failed", "The OAuth response was rejected.");
              return;
            }
            try {
              const parsed = parseProviderCallback(target.href, expectedState);
              respond("200 OK", "Login complete", "Sign-in completed.");
              finish(null, parsed);
            } catch (error) {
              respond("400 Bad Request", "Login failed", "The OAuth response was rejected.");
              finish(error);
            }
          },
          onStopRequest() { activeTransports.delete(transport); },
        };
        pump.init(input, -1, -1, 0, 0, false);
        pump.asyncRead(listener);
      } catch (error) {
        try { transport.close(results?.NS_OK ?? 0); } catch {}
        activeTransports.delete(transport);
        finish(error);
      }
    },
    onStopListening() {},
  });

  return { callback, close: () => finish(new Error("OAuth 登录已取消")) };
}

async function readJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回了无效 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new Error(`${label} 失败（HTTP ${response.status}）：${body.error_description || body.error || text.slice(0, 500)}`);
  }
  return body;
}

async function exchangeCode(providerId, { code, state, verifier }) {
  const provider = PROVIDERS[providerId];
  let init;
  if (providerId === "anthropic") {
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: provider.clientId,
        code,
        state,
        redirect_uri: provider.redirectUri,
        code_verifier: verifier,
      }),
    };
  } else {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: provider.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: provider.redirectUri,
    });
    if (provider.clientSecret) body.set("client_secret", provider.clientSecret);
    init = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body };
  }
  const token = await readJson(await fetch(provider.tokenUrl, init), `${provider.label} token exchange`);
  if (!token.access_token || !token.refresh_token || !Number.isFinite(Number(token.expires_in))) {
    throw new Error(`${provider.label} token response 缺少 access_token、refresh_token 或 expires_in`);
  }
  const credential = {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + Number(token.expires_in) * 1000,
    ...(token.id_token ? { idToken: token.id_token } : {}),
    ...(token.account?.uuid ? { accountId: token.account.uuid } : {}),
    ...(token.account?.email_address ? { email: token.account.email_address } : {}),
    ...(token.organization?.uuid ? { orgId: token.organization.uuid } : {}),
    ...(token.organization?.name ? { orgName: token.organization.name } : {}),
  };
  if (providerId === "openai-codex") {
    Object.assign(credential, jwtIdentity(credential.access, credential.idToken));
  } else if (providerId.startsWith("google-")) {
    try {
      const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
        headers: { Authorization: `Bearer ${credential.access}` },
      });
      if (response.ok) {
        const user = await response.json();
        credential.email ||= user.email;
        credential.accountId ||= user.id;
      }
    } catch {}
  }
  return credential;
}

function jwtIdentity(token, idToken = "") {
  for (const candidate of [token, idToken]) {
    try {
      const payload = JSON.parse(atob(candidate.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      const auth = payload["https://api.openai.com/auth"] || {};
      const profile = payload["https://api.openai.com/profile"] || {};
      if (auth.chatgpt_account_id || profile.email) {
        return {
          ...(auth.chatgpt_account_id ? { accountId: auth.chatgpt_account_id } : {}),
          ...(profile.email ? { email: profile.email } : {}),
        };
      }
    } catch {}
  }
  return {};
}

async function refreshCredential(providerId, credential) {
  const provider = PROVIDERS[providerId];
  let init;
  if (providerId === "anthropic") {
    init = {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: provider.clientId,
        refresh_token: credential.refresh,
      }),
    };
  } else {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: provider.clientId,
      refresh_token: credential.refresh,
    });
    if (provider.clientSecret) body.set("client_secret", provider.clientSecret);
    init = { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body };
  }
  const token = await readJson(await fetch(provider.tokenUrl, init), `${provider.label} token refresh`);
  if (!token.access_token || !Number.isFinite(Number(token.expires_in))) {
    throw new Error(`${provider.label} refresh response 缺少 access_token 或 expires_in`);
  }
  const next = {
    ...credential,
    access: token.access_token,
    refresh: token.refresh_token || credential.refresh,
    expires: Date.now() + Number(token.expires_in) * 1000,
  };
  if (token.id_token) next.idToken = token.id_token;
  if (providerId === "openai-codex") Object.assign(next, jwtIdentity(next.access, next.idToken));
  return next;
}

async function discoverGoogleProject(providerId, credential) {
  if (credential.projectId) return credential;
  const antigravity = providerId === "google-antigravity";
  const baseUrl = antigravity
    ? "https://daily-cloudcode-pa.googleapis.com"
    : "https://cloudcode-pa.googleapis.com";
  const metadata = antigravity
    ? { ideType: "ANTIGRAVITY" }
    : { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
  const headers = {
    Authorization: `Bearer ${credential.access}`,
    "Content-Type": "application/json",
    "User-Agent": antigravity ? "antigravity/hub/2.13.0 (aidev_client)" : "GeminiCLI/0.46.0/FirefoxReverse (windows; x64; terminal)",
    ...(antigravity ? {} : { "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI" }),
  };
  const loaded = await readJson(await fetch(`${baseUrl}/v1internal:loadCodeAssist`, {
    method: "POST", headers, body: JSON.stringify({ metadata }),
  }), `${antigravity ? "Antigravity" : "Gemini CLI"} project discovery`);
  if (typeof loaded.cloudaicompanionProject === "string") {
    credential.projectId = loaded.cloudaicompanionProject;
    return credential;
  }
  if (!antigravity && loaded.currentTier) {
    throw new Error("此 Gemini CLI 账号要求先配置 Google Cloud Project");
  }
  if (antigravity && !loaded.allowedTiers?.some(item => item.id === "free-tier")) {
    const reason = loaded.ineligibleTiers?.find(item => item.tierId === "free-tier")?.reasonMessage;
    throw new Error(reason || "Antigravity 未返回 Cloud Code Assist project");
  }
  const tier = antigravity ? "free-tier" : (loaded.allowedTiers?.find(item => item.isDefault)?.id || "legacy-tier");
  let onboard = await readJson(await fetch(`${baseUrl}/v1internal:onboardUser`, {
    method: "POST", headers, body: JSON.stringify({ tierId: tier, metadata }),
  }), "Gemini CLI project provisioning");
  if (onboard.response?.cloudaicompanionProject?.id) {
    credential.projectId = onboard.response.cloudaicompanionProject.id;
    return credential;
  }
  if (!onboard.name) throw new Error("Google project provisioning 未返回 operation");
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    onboard = await readJson(await fetch(`${baseUrl}/v1internal/${onboard.name}`, { headers }), "Google project provisioning");
    const operation = onboard;
    const projectId = operation.response?.cloudaicompanionProject?.id;
    if (operation.done && projectId) {
      credential.projectId = projectId;
      return credential;
    }
    if (operation.done) throw new Error("Gemini CLI project provisioning 未返回 project id");
  }
  throw new Error("Google project provisioning 超时");
}

const refreshFlights = new Map();

export async function getFreshOAuthCredential(store, profileId, { forceRefresh = false } = {}) {
  let credential = store.getOAuthCredential(profileId);
  if (!credential?.access || !credential.refresh) {
    throw new Error("当前模型配置没有可用 OAuth 凭据，请重新登录或导入账号文件");
  }
  if (!forceRefresh && Number(credential.expires) > Date.now() + 60_000) return credential;
  const profile = store.listModelProfiles().find(item => item.id === profileId);
  if (!profile || !PROVIDERS[profile.provider]) throw new Error("OAuth provider 配置不存在");
  if (refreshFlights.has(profileId)) return refreshFlights.get(profileId);
  const flight = refreshCredential(profile.provider, credential).then(next => {
    const currentProfile = store.listModelProfiles().find(item => item.id === profileId);
    const currentCredential = store.getOAuthCredential(profileId);
    if (
      currentProfile?.authType !== "oauth" ||
      currentProfile.provider !== profile.provider ||
      currentCredential?.access !== credential.access ||
      currentCredential?.refresh !== credential.refresh
    ) {
      throw new Error("OAuth 配置已更换或删除，已取消旧凭据刷新");
    }
    store.setOAuthCredential(profileId, next);
    return next;
  }).finally(() => refreshFlights.delete(profileId));
  refreshFlights.set(profileId, flight);
  return flight;
}

export async function loginProvider(providerId, openAuthorizationUrl) {
  if (!PROVIDERS[providerId]) throw new Error(`不支持 OAuth provider：${providerId}`);
  const { verifier, challenge } = await createPkce();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const listener = createCallbackServer(providerId, state);
  try {
    openAuthorizationUrl(createProviderAuthorizationUrl(providerId, { state, challenge }));
    const callback = await listener.callback;
    let credential = await exchangeCode(providerId, { ...callback, verifier });
    if (providerId === "google-gemini-cli" || providerId === "google-antigravity") {
      credential = await discoverGoogleProject(providerId, credential);
    }
    return credential;
  } finally {
    listener.close();
  }
}

export function parseCliProxyCredential(raw, filename = "") {
  const json = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("JSON 顶层必须是对象");
  const type = String(json.type || "").trim().toLowerCase();
  const basename = String(filename).split(/[\\/]/).pop()?.replace(/\.json$/i, "").toLowerCase() || "";
  const inferred = Object.entries(CLIPROXY_TYPES).find(([name]) => basename === name || basename.startsWith(`${name}-`))?.[1];
  const provider = CLIPROXY_TYPES[type] || inferred;
  if (!provider) throw new Error(`无法识别 CLIProxyAPI type：${json.type || "缺失"}`);
  if (json.disabled === true) throw new Error("凭据已标记 disabled");
  if (typeof json.access_token !== "string" || !json.access_token || typeof json.refresh_token !== "string" || !json.refresh_token) {
    throw new Error("缺少 access_token 或 refresh_token");
  }
  const expires = Date.parse(String(json.expired || ""));
  if (!Number.isFinite(expires)) throw new Error("expired 缺失或无法解析");
  const credential = {
    access: json.access_token,
    refresh: json.refresh_token,
    expires,
    ...(typeof json.id_token === "string" ? { idToken: json.id_token } : {}),
    ...(typeof json.email === "string" && json.email ? { email: json.email } : {}),
    ...(typeof json.account_id === "string" && json.account_id ? { accountId: json.account_id } : {}),
    ...(typeof (json.project_id || json.projectId) === "string" ? { projectId: json.project_id || json.projectId } : {}),
  };
  return { provider, credential };
}

function sameAccount(left, right) {
  if (left.accountId && right.accountId) return left.accountId === right.accountId;
  if (left.email && right.email) return left.email.toLowerCase() === right.email.toLowerCase();
  return !!left.refresh && left.refresh === right.refresh;
}

export async function importCliProxyFiles(files, store) {
  const imported = [];
  const skipped = [];
  for (const file of files) {
    let created = null;
    try {
      const { provider, credential } = parseCliProxyCredential(await file.text(), file.name || "");
      const match = store.listModelProfiles().find(profile => {
        if (profile.provider !== provider || profile.authType !== "oauth") return false;
        const existing = store.getOAuthCredential(profile.id);
        return existing && sameAccount(existing, credential);
      });
      const label = PROVIDERS[provider].label;
      const name = credential.email ? `${label} · ${credential.email}` : `${label} 账号`;
      let profile;
      if (match) {
        store.setOAuthCredential(match.id, credential);
        profile = store.updateModelProfile(match.id, {
          name,
          provider,
          authType: "oauth",
          apiKey: "",
          model: match.model || DEFAULT_MODELS[provider],
        });
      } else {
        created = store.createModelProfile({
          name,
          provider,
          authType: "oauth",
          apiKey: "",
          model: DEFAULT_MODELS[provider],
        }, { activate: false });
        try {
          store.setOAuthCredential(created.id, credential);
        } catch (error) {
          store.deleteModelProfile(created.id);
          created = null;
          throw error;
        }
        profile = created;
      }
      imported.push({ profile, provider, email: credential.email || "" });
    } catch (error) {
      if (created) store.deleteModelProfile(created.id);
      skipped.push({ file: file.name || "JSON", reason: error.message || String(error) });
    }
  }
  if (imported.length) store.setActiveModelProfileId(imported[imported.length - 1].profile.id);
  return { imported, skipped };
}
