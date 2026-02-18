/**
 * 共用 LIFF 初始化工具函式
 */
const LiffHelper = {
  profile: null,
  idToken: null,
  accessToken: null,

  async init(liffId) {
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: window.location.href });
      return false;
    }
    this.profile = await liff.getProfile();
    this.idToken = liff.getIDToken();
    this.accessToken = liff.getAccessToken();
    return true;
  },

  async recoverAuth(liffId) {
    try {
      // Re-init may refresh browser-side LIFF state on desktop/webview.
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return false;
      }
      this.profile = await liff.getProfile();
      this.idToken = liff.getIDToken();
      this.accessToken = liff.getAccessToken();
      if (this.idToken || this.accessToken) return true;

      // Logged in but no id token: force re-login.
      liff.login({ redirectUri: window.location.href });
      return false;
    } catch {
      return false;
    }
  },

  getProfile() { return this.profile; },
  getIdToken() { return this.idToken; },
  getAccessToken() { return this.accessToken; },

  _safeDecodeURIComponent(s) {
    if (typeof s !== "string") return s;
    try { return decodeURIComponent(s); } catch { return s; }
  },

  _decodeMulti(s, rounds = 2) {
    let out = s;
    for (let i = 0; i < rounds; i += 1) {
      const next = this._safeDecodeURIComponent(out);
      if (next === out) break;
      out = next;
    }
    return out;
  },

  _readFromQueryBlob(blob, key) {
    if (!blob || typeof blob !== "string") return null;

    const candidates = [blob, this._decodeMulti(blob, 2)];
    for (const raw of candidates) {
      const text = String(raw || "").trim();
      if (!text) continue;

      // Full URL case
      try {
        const fullUrl = new URL(text);
        const value = fullUrl.searchParams.get(key);
        if (value) return value;
      } catch {
        // ignore non-URL inputs
      }

      const noHash = text.startsWith("#") ? text.slice(1) : text;
      const qIndex = noHash.indexOf("?");
      const queryPart = qIndex >= 0 ? noHash.slice(qIndex + 1) : noHash.replace(/^\?/, "");
      if (!queryPart) continue;
      const sp = new URLSearchParams(queryPart);
      const value = sp.get(key);
      if (value) return value;
    }

    return null;
  },

  /** 從 URL 取得 query string 參數 */
  getParam(key) {
    const url = new URL(window.location.href);

    // Normal query params (e.g. /schedule?group=123)
    const direct = url.searchParams.get(key);
    if (direct) return direct;

    // Some LIFF browsers preserve params in hash.
    const hashVal = this._readFromQueryBlob(url.hash, key);
    if (hashVal) return hashVal;

    // LIFF often stores the original path/query inside `liff.state`.
    // Example: /schedule?liff.state=%3Fgroup%3D123  (or /schedule?liff.state=/schedule?group=123)
    const stateRaw = url.searchParams.get("liff.state") || url.searchParams.get("liff_state");
    const stateVal = this._readFromQueryBlob(stateRaw, key);
    if (stateVal) return stateVal;

    return null;
  },
};
