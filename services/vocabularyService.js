// Phase 1-B skeleton. Thin read adapters over the existing per-student vocabulary fields
// (vocabTests/vocabResults/vocabLog — see ARCHITECTURE.md §2.5). No new schema, no writes.
// Not yet wired into any UI — VocabEditor/VocabLogEditor in index.html are untouched.
window.SarahServices = window.SarahServices || {};

(function () {
  function getVocabTestsForStudent(studentData) {
    return (studentData && studentData.vocabTests) || [];
  }

  function getVocabResultsForStudent(studentData) {
    return (studentData && studentData.vocabResults) || [];
  }

  // Separate, older pass/fail session log — distinct shape from vocabResults, see
  // ARCHITECTURE.md §2.5.
  function getVocabLogForStudent(studentData) {
    return (studentData && studentData.vocabLog) || [];
  }

  // Matches index.html's vocabPassThreshold(): 90% if the test title contains "누적", else 80%.
  function passThreshold(testTitle) {
    return (testTitle || "").includes("누적") ? 90 : 80;
  }

  // Phase 2 (Teacher Center "최근 시험" card): joins vocabResults with their vocabTests title,
  // normalized the same shape examService's getRecentMockResults/getRecentExamResults use so a
  // caller can merge and sort them together.
  function getRecentVocabResults(studentId, studentName, studentData) {
    const tests = getVocabTestsForStudent(studentData);
    const titleById = {};
    tests.forEach((t) => { titleById[t.id] = t.title; });
    return getVocabResultsForStudent(studentData).map((r) => ({
      kind: "vocab",
      studentId, studentName,
      title: titleById[r.testId] || "단어시험",
      date: r.date || null,
      score: r.score, total: r.total,
    }));
  }

  // Phase 3 (Report Center): monthly stats for the Monthly Report dashboard. Reads only
  // vocabTests/vocabResults (this service's own fields) — no data duplicated from elsewhere.
  function getMonthlyVocabStats(studentData, month) {
    const tests = getVocabTestsForStudent(studentData);
    const titleById = {};
    tests.forEach((t) => { titleById[t.id] = t.title; });
    const results = getVocabResultsForStudent(studentData)
      .filter((r) => r.date && r.date.startsWith(month))
      .map((r) => ({ ...r, title: titleById[r.testId] || "단어시험", pct: r.total ? Math.round((r.score / r.total) * 100) : null }));
    const count = results.length;
    const withPct = results.filter((r) => r.pct != null);
    const avgPct = withPct.length ? Math.round(withPct.reduce((s, r) => s + r.pct, 0) / withPct.length) : null;
    const passed = withPct.filter((r) => r.pct >= passThreshold(r.title)).length;
    const passRate = withPct.length ? Math.round((passed / withPct.length) * 100) : null;
    return { count, avgPct, passRate, results };
  }

  // "누적 학습 단어 수" — unique words across every vocab test ever assigned to this student
  // (not just this month) — a running total, matching how the app already treats vocab tests as
  // cumulative curriculum coverage.
  function getCumulativeWordCount(studentData) {
    const words = new Set();
    getVocabTestsForStudent(studentData).forEach((t) => (t.words || []).forEach((w) => {
      if (w.word) words.add(w.word.trim().toLowerCase());
    }));
    return words.size;
  }

  window.SarahServices.vocabularyService = {
    getVocabTestsForStudent,
    getVocabResultsForStudent,
    getVocabLogForStudent,
    passThreshold,
    getRecentVocabResults,
    getMonthlyVocabStats,
    getCumulativeWordCount,
  };
})();
