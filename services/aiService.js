// Phase 1-B skeleton. Centralizes the aiWorker HTTPS-call pattern that index.html
// (NELT_WORKER_URL) and passage-transform.html (WORKER_URL) each already implement inline —
// see functions/index.js and CLAUDE.md's "AI backend" section for the 6 modes this endpoint
// supports (default question-gen, transform, monthlyReport, examkey, examVariant, nelt).
//
// Not yet wired into any UI — index.html and passage-transform.html keep their own inline
// fetch() calls untouched for now; this exists so a future caller (e.g. a new Exam Studio
// screen) doesn't have to duplicate the endpoint URL and error handling a third time.
window.SarahServices = window.SarahServices || {};

(function () {
  const AI_WORKER_URL = "https://us-central1-sarah-s-english.cloudfunctions.net/aiWorker";

  async function callAiWorker(payload) {
    const res = await fetch(AI_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`aiWorker request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  }

  window.SarahServices.aiService = {
    AI_WORKER_URL,
    callAiWorker,
  };
})();
