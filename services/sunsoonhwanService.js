// 선순환은 별도 앱이다. 여기서는 반 코드 안내만 저장하며 계정·학생 데이터는 보내지 않는다.
window.SarahServices = window.SarahServices || {};
(function () {
  const APP_URL = "https://sunsoonghwan-2026.web.app/preview/";
  const DEFAULTS = { classCode: "", showStudent: true, showParent: true };
  let cached = null, pending = null;
  const listeners = new Set();
  function normalizeCode(value) {
    const code = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(code) ? code : "";
  }
  function normalizeSettings(value) {
    const v = value || {};
    return { classCode: normalizeCode(v.classCode), showStudent: v.showStudent !== false, showParent: v.showParent !== false };
  }
  function getCached() { return { ...(cached || DEFAULTS) }; }
  function primeSettings(value) {
    cached = normalizeSettings(value);
    listeners.forEach((fn) => fn(getCached()));
    return getCached();
  }
  async function loadSettings() {
    if (cached) return getCached();
    if (!pending) pending = window.SarahServices.firebaseClient.getDoc("sarahsEnglishMeta", "main")
      .then((doc) => primeSettings(doc && doc.sunsoonhwan))
      .finally(() => { pending = null; });
    return pending;
  }
  async function saveSettings(value) {
    if (String(value.classCode || "").trim() && !normalizeCode(value.classCode)) throw new Error("선순환 앱에서 발급한 8자리 반 코드를 입력해 주세요.");
    const next = normalizeSettings(value);
    await window.SarahServices.firebaseClient.setDocAt("sarahsEnglishMeta", "main", { sunsoonhwan: next }, { merge: true });
    return primeSettings(next);
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function formatCode(code) { const c = normalizeCode(code); return c ? c.slice(0, 4) + " " + c.slice(4) : ""; }
  window.SarahServices.sunsoonhwanService = { APP_URL, normalizeCode, formatCode, normalizeSettings, getCached, primeSettings, loadSettings, saveSettings, subscribe };
})();
