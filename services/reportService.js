// Phase 1-B skeleton, extended in Phase 3 (Report Center).
//
// Re-verified against the actual current index.html code before this Phase 3 extension (per
// project rule: code first, then update docs — see CLAUDE.md "Project reconstruction"). Confirmed
// current shapes:
//   data.dailyReports = { "YYYY-MM-DD": { text, published, updatedAt } }
//     — written by DailyReportGenerator (index.html). `text` is a single free-text field, auto-
//     drafted from logs/vocabLog/homework by buildDailyReportText() and meant to be copy-pasted
//     into a text message to the parent. There is NO structured lesson/rating/status data in the
//     existing shape — Phase 3 adds that (see below), additively, alongside the untouched
//     text/published/updatedAt fields. Existing entries that only have text/published/updatedAt
//     remain fully valid and readable; the new fields simply won't be present on them.
//   data.monthlyReports = { "YYYY-MM": { ratings, attendance, content, good, improve, comment,
//     nextMonth, neltComment, published } } — written by MonthlyReportView. `ratings` already
//     covers 6 categories (vocab/grammar/reading/writing/attitude/homework, REPORT_CATEGORIES) on
//     a 4-point scale (REPORT_RATINGS) — this is a *manual monthly* rating, separate from Phase
//     3's new *daily* ratings (focus/participation/comprehension/homeworkDiligence) below; the two
//     do not overlap and neither replaces the other.
//
// Phase 3 additive fields (dailyReports[date]):
//   status              — "DRAFT" | "COMPLETED" | "REVIEWED" (see DAILY_REPORT_STATUSES).
//   lessonInfo          — { textbook, unit, classDuration, actualDuration }
//   lessonContent       — { grammar, reading, vocabulary, writing, listening, other } (free text)
//   ratings             — { focus, participation, comprehension, homeworkDiligence } (1-5 each)
//   teacherComment      — { good, improve, next, note }
// None of these are required — a report can still be saved with just the old text/published
// fields exactly as before (the existing "메시지 초안" card in DailyReportGenerator keeps doing
// exactly that, untouched).
window.SarahServices = window.SarahServices || {};

(function () {
  const DAILY_REPORT_STATUSES = ["DRAFT", "COMPLETED", "REVIEWED"];
  const DAILY_RATING_KEYS = [
    { key: "focus", label: "집중도" },
    { key: "participation", label: "참여도" },
    { key: "comprehension", label: "이해도" },
    { key: "homeworkDiligence", label: "숙제 성실도" },
  ];

  function getDailyReportsForStudent(studentData) {
    return (studentData && studentData.dailyReports) || {};
  }

  function getDailyReport(studentData, date) {
    return getDailyReportsForStudent(studentData)[date] || null;
  }

  function getPublishedDailyReports(studentData) {
    const all = getDailyReportsForStudent(studentData);
    return Object.fromEntries(Object.entries(all).filter(([, r]) => r && r.published));
  }

  // Backward-compat status resolution: old entries have no `status` field at all, only
  // `published` — treat published:true as effectively COMPLETED for display so nothing looks
  // "unset" just because it predates Phase 3, without ever writing a status onto old data.
  function getReportStatus(entry) {
    if (!entry) return "DRAFT";
    if (entry.status) return entry.status;
    return entry.published ? "COMPLETED" : "DRAFT";
  }

  function getMonthlyDailyReportEntries(studentData, month) {
    return Object.entries(getDailyReportsForStudent(studentData))
      .filter(([date]) => date.startsWith(month))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  // Daily ratings averaged over the month — only over entries that actually have a `ratings`
  // object (old/blank entries are skipped, not counted as 0).
  function getMonthlyLearningBehavior(studentData, month) {
    const rated = getMonthlyDailyReportEntries(studentData, month)
      .map(([, r]) => r)
      .filter((r) => r && r.ratings);
    const out = { sampleSize: rated.length };
    DAILY_RATING_KEYS.forEach(({ key }) => {
      const vals = rated.map((r) => r.ratings[key]).filter((v) => typeof v === "number");
      out[key] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    });
    return out;
  }

  // Phase 4 STEP 1 fix: live "수업 횟수" (distinct 학습기록/logs dates this month) — the single
  // shared computation both MonthlyReportDashboard (teacher) and ParentMonthlySummary (parent)
  // now call, instead of each recomputing it inline. This intentionally does NOT compute
  // "결석" — the old MonthlyReportView snapshot's `absent` was derived from
  // `student.monthlyInstances[month].length`, which is only one-off/moved sessions, not the full
  // recurring weekly schedule (that needs patternForMonth() + week-counting math this function
  // does not attempt to redo). Rather than reintroduce a similarly approximate "결석" number,
  // this only reports what logs actually prove happened.
  function getMonthlyClassCount(studentData, month) {
    const logs = (studentData && studentData.logs) || [];
    const dates = new Set(logs.filter((l) => (l.date || "").startsWith(month)).map((l) => l.date));
    return dates.size || null;
  }

  function getMonthlyReportsForStudent(studentData) {
    return (studentData && studentData.monthlyReports) || {};
  }

  function getMonthlyReport(studentData, month) {
    return getMonthlyReportsForStudent(studentData)[month] || null;
  }

  function getPublishedMonthlyReports(studentData) {
    const all = getMonthlyReportsForStudent(studentData);
    return Object.fromEntries(Object.entries(all).filter(([, r]) => r && r.published));
  }

  window.SarahServices.reportService = {
    DAILY_REPORT_STATUSES,
    DAILY_RATING_KEYS,
    getDailyReportsForStudent,
    getDailyReport,
    getPublishedDailyReports,
    getReportStatus,
    getMonthlyClassCount,
    getMonthlyDailyReportEntries,
    getMonthlyLearningBehavior,
    getMonthlyReportsForStudent,
    getMonthlyReport,
    getPublishedMonthlyReports,
  };
})();
