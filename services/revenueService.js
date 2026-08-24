// Phase 1-B skeleton. Thin read/aggregation adapter over the existing per-student
// `tuitionRecords` field (see ARCHITECTURE.md §2.8) — the same source RevenueOverviewSection
// (index.html) already aggregates from, re-expressed as a reusable pure function so a future
// Business/Revenue screen doesn't have to reimplement the aggregation. No new schema, no writes.
// Not yet wired into any UI — RevenueOverviewSection/TuitionEditor in index.html are untouched.
window.SarahServices = window.SarahServices || {};

(function () {
  function getTuitionRecordsForStudent(studentData) {
    return (studentData && studentData.tuitionRecords) || {};
  }

  // studentDataMap: { [studentId]: studentDocBody }. Returns totals for one "YYYY-MM" across
  // every student that has a tuitionRecords entry for that month.
  function getMonthSummary(studentDataMap, month) {
    let total = 0;
    let paid = 0;
    const unpaidStudentIds = [];
    for (const [studentId, data] of Object.entries(studentDataMap || {})) {
      const rec = getTuitionRecordsForStudent(data)[month];
      if (!rec) continue;
      const amount = rec.amount || 0;
      total += amount;
      if (rec.paid) {
        paid += amount;
      } else {
        unpaidStudentIds.push(studentId);
      }
    }
    return { month, total, paid, unpaid: total - paid, unpaidStudentIds };
  }

  window.SarahServices.revenueService = {
    getTuitionRecordsForStudent,
    getMonthSummary,
  };
})();
