// Phase 1-C adapter, extended in Phase 2 for the Teacher Center homework board.
//
// Storage shape is still the EXISTING per-student `homework[]` array
// (see emptyData() in index.html / ARCHITECTURE.md §2.3) — HomeworkEditor's core fields
// (id/assignedDate/dueDate/content/done/doneAt/expired/photos) are untouched. Phase 2 adds two
// new, optional, backward-compatible fields written only by the new Teacher Center UI:
//   - category: string|null — "유형" (문법/어휘/독해/듣기/기타), settable when a teacher creates
//     homework (HomeworkEditor's add form). Existing homework predates this field and simply has
//     category: undefined/null, shown as "미분류" — nothing breaks for old data.
//   - checkedAt / checkedBy: set only by the Teacher Center board's "확인" action (see
//     markChecked/unmarkChecked below). This is a NEW concept, deliberately separate from the
//     existing `done` flag: `done` already means "student marked this submitted/complete" (it's
//     toggled from both HomeworkEditor and the student's own homework card — see
//     ARCHITECTURE.md/CLAUDE.md for that nuance), so reusing it for "teacher has reviewed this"
//     would conflate two different facts. checkedAt starts unset for every existing homework item
//     — nothing is retroactively marked checked.
//
// All Firestore writes still go through the caller's existing `updateData(studentId, updater)`
// (App()'s transactional read-modify-write) — this file only computes what the next `homework[]`
// array should look like. It never touches Firestore directly.
window.SarahServices = window.SarahServices || {};

(function () {
  const HOMEWORK_CATEGORIES = ["문법", "어휘", "독해", "듣기", "기타"];

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function toDateStr(ms) {
    if (!ms) return null;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function normalizeHomework(studentId, studentName, hw) {
    const photos = hw.photos || (hw.photo ? [{ url: hw.photo, uploadedAt: null }] : []);
    const today = todayStr();

    // Submission status — driven entirely by the existing `done`/`expired` fields, unchanged.
    let submissionStatus = "not_submitted"; // "submitted" | "not_submitted" | "expired"
    if (hw.expired) submissionStatus = "expired";
    else if (hw.done) submissionStatus = "submitted";

    const overdue = !hw.expired && !hw.done && hw.dueDate && hw.dueDate < today;
    const late = !!(hw.done && hw.doneAt && hw.dueDate && toDateStr(hw.doneAt) > hw.dueDate);

    // Legacy-compatible single-word status, kept for existing Phase 1 callers
    // (getPendingHomework/getAllHomeworkAcrossRoster) — do not change its meaning.
    let status = "pending";
    if (hw.expired) status = "expired";
    else if (hw.done) status = "done";
    else if (overdue) status = "overdue";

    return {
      id: hw.id,
      studentId,
      studentName,
      assignedDate: hw.assignedDate || null,
      dueDate: hw.dueDate || null,
      content: hw.content || "",
      category: hw.category || null,
      done: !!hw.done,
      doneAt: hw.doneAt || null,
      expired: !!hw.expired,
      photoCount: photos.length,
      status, // "pending" | "overdue" | "done" | "expired" (Phase 1 meaning, unchanged)
      submissionStatus, // "submitted" | "not_submitted" | "expired"
      overdue,
      late,
      checked: !!hw.checkedAt,
      checkedAt: hw.checkedAt || null,
      checkedBy: hw.checkedBy || null,
    };
  }

  function getHomeworkForStudent(studentId, studentName, studentData) {
    const hw = (studentData && studentData.homework) || [];
    return hw.map((h) => normalizeHomework(studentId, studentName, h));
  }

  function getAllHomeworkAcrossRoster(roster, studentDataMap) {
    const out = [];
    for (const s of roster || []) {
      const data = (studentDataMap && studentDataMap[s.id]) || null;
      if (!data) continue;
      out.push(...getHomeworkForStudent(s.id, s.name, data));
    }
    return out;
  }

  function getPendingHomework(roster, studentDataMap) {
    return getAllHomeworkAcrossRoster(roster, studentDataMap).filter(
      (h) => h.status === "pending" || h.status === "overdue"
    );
  }

  // Pure array transforms — the caller persists the result via its own updateData(studentId, fn).
  // Single teacher account today (no multi-teacher login), so checkedBy is a fixed label rather
  // than a real identity — matches the app's actual auth model instead of pretending to support
  // multiple teachers.
  function markChecked(homeworkArray, homeworkId, checkedBy) {
    return (homeworkArray || []).map((h) =>
      h.id === homeworkId ? { ...h, checkedAt: Date.now(), checkedBy: checkedBy || "teacher" } : h
    );
  }

  function unmarkChecked(homeworkArray, homeworkId) {
    return (homeworkArray || []).map((h) =>
      h.id === homeworkId ? { ...h, checkedAt: null, checkedBy: null } : h
    );
  }

  // Phase 3 (Report Center): monthly stats for the Monthly Report dashboard, keyed off dueDate
  // (matches how MonthlyReportView's existing hwRate already filters homework by dueDate-in-month
  // — this stays consistent with that, just adds the extra breakdown fields).
  function getMonthlyHomeworkStats(studentData, month) {
    const hw = getHomeworkForStudent("", "", studentData).filter((h) => h.dueDate && h.dueDate.startsWith(month));
    const total = hw.length;
    const submitted = hw.filter((h) => h.submissionStatus === "submitted").length;
    const notSubmitted = hw.filter((h) => h.submissionStatus === "not_submitted").length;
    const late = hw.filter((h) => h.late).length;
    const checked = hw.filter((h) => h.checked).length;
    return {
      total, submitted, notSubmitted, late, checked,
      rate: total ? Math.round((submitted / total) * 100) : null,
    };
  }

  window.SarahServices.homeworkService = {
    HOMEWORK_CATEGORIES,
    normalizeHomework,
    getHomeworkForStudent,
    getAllHomeworkAcrossRoster,
    getPendingHomework,
    markChecked,
    unmarkChecked,
    getMonthlyHomeworkStats,
  };
})();
