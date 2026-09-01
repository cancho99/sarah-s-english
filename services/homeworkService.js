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
    // externalPhotos items keep the actual photo bytes out of this array (see
    // HOMEWORK_PHOTOS_COLLECTION below) — photoCount comes from the stored count instead of the
    // (empty) local array, so every existing count-based consumer keeps working unchanged.
    const photoCount = hw.externalPhotos ? (hw.photoCount || 0) : photos.length;
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
      photoCount,
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
    const submitted = hw.filter((h) => h.done).length;
    const notSubmitted = hw.filter((h) => !h.done).length;
    const late = hw.filter((h) => h.late).length;
    const checked = hw.filter((h) => h.checked).length;
    return {
      total, submitted, notSubmitted, late, checked,
      rate: total ? Math.round((submitted / total) * 100) : null,
    };
  }

  // 2026-08-27 성능 개선 — homework[].photos에 base64 사진을 그대로 박아넣던 방식은 학생 문서
  // 하나가 수백KB~1MB에 육박하게 만들었고(CLAUDE.md "1MB-per-student-document" 참고), Today/
  // Students/Reports 등 거의 모든 화면이 ensureData()로 로스터 전체 학생 문서를 통째로 미리
  // 불러오면서 이 사진 바이트까지 매번 같이 내려받는 게 실제 로딩 지연의 큰 원인으로 확인됐다.
  // 새 사진은 이 별도 컬렉션(학생당 문서 1개, key=homeworkId)에 저장하고, 학생 문서 쪽엔
  // {externalPhotos:true, photoCount} 표시만 남긴다 — 기존에 이미 저장된 사진(photos[] 안의
  // 실제 base64)은 전혀 옮기거나 건드리지 않는다(무마이그레이션, 데이터 그대로 유지).
  const HOMEWORK_PHOTOS_COLLECTION = "homeworkPhotos";

  async function getExternalPhotos(studentId) {
    const doc = await window.SarahServices.firebaseClient.getDoc(HOMEWORK_PHOTOS_COLLECTION, studentId);
    return doc || {};
  }
  async function saveExternalPhotos(studentId, homeworkId, photosArray) {
    await window.SarahServices.firebaseClient.setDocAt(HOMEWORK_PHOTOS_COLLECTION, studentId, { [homeworkId]: photosArray }, { merge: true });
  }

  window.SarahServices.homeworkService = {
    HOMEWORK_CATEGORIES,
    HOMEWORK_PHOTOS_COLLECTION,
    getExternalPhotos,
    saveExternalPhotos,
    normalizeHomework,
    getHomeworkForStudent,
    getAllHomeworkAcrossRoster,
    getPendingHomework,
    markChecked,
    unmarkChecked,
    getMonthlyHomeworkStats,
  };
})();
