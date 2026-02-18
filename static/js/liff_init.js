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

  /** 從 URL 取得 query string 參數 */
  getParam(key) {
    const url = new URL(window.location.href);
    return url.searchParams.get(key);
  },
};
