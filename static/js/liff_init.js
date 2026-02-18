/**
 * 共用 LIFF 初始化工具函式
 */
const LiffHelper = {
  profile: null,
  idToken: null,

  async init(liffId) {
    await liff.init({ liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: window.location.href });
      return false;
    }
    this.profile = await liff.getProfile();
    this.idToken = liff.getIDToken();
    return true;
  },

  getProfile() { return this.profile; },
  getIdToken() { return this.idToken; },

  _safeDecodeURIComponent(s) {
    if (typeof s !== "string") return s;
    try { return decodeURIComponent(s); } catch { return s; }
  },

  /** 從 URL 取得 query string 參數 */
  getParam(key) {
    const url = new URL(window.location.href);
    // Normal query params (e.g. /schedule?group=123)
    const direct = url.searchParams.get(key);
    if (direct) return direct;

    // LIFF often stores the original path/query inside `liff.state`.
    // Example: /schedule?liff.state=%3Fgroup%3D123  (or /schedule?liff.state=/schedule?group=123)
    const stateRaw = url.searchParams.get("liff.state");
    if (!stateRaw) return null;

    const state = this._safeDecodeURIComponent(stateRaw);
    // state might be "?group=123" or "/schedule?group=123" or "group=123"
    const qIndex = state.indexOf("?");
    const queryPart = qIndex >= 0 ? state.slice(qIndex + 1) : (state.startsWith("?") ? state.slice(1) : state);
    const sp = new URLSearchParams(queryPart);
    return sp.get(key);
  },
};
