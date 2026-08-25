// Phase 8-A — Student Exam Runtime, assignment half. Owns the `examAssignments` collection: one
// doc per (examPaper, student) assignment. Never duplicates exam content — only references
// `examPaperId`, exactly like examPaperService's sections only reference questionId (CLAUDE.md
// "Project reconstruction" / examPaperService.js's own §13 comments). Never touches
// sarahsEnglishStudents/<id> — that collection is exclusively owned by App()'s transactional
// ensureData()/updateData() in index.html; any student-doc summary field this feature eventually
// wants must be written by the UI layer calling that existing updateData(), never from here.
window.SarahServices = window.SarahServices || {};

(function () {
  const { getDoc, getAllDocs, getDocsWhere, addDocTo, setDocAt } = window.SarahServices.firebaseClient;

  const ASSIGNMENTS_COLLECTION = "examAssignments";

  // Status is driven by the attempt lifecycle (examAttemptService calls updateAssignmentStatus at
  // each step) — forward-only, one step at a time, same shape as questionBankService's
  // STATUS_ORDER/canTransition convention.
  const STATUS_ORDER = ["ASSIGNED", "IN_PROGRESS", "SUBMITTED", "GRADED"];
  function canTransition(from, to) {
    const fi = STATUS_ORDER.indexOf(from);
    const ti = STATUS_ORDER.indexOf(to);
    if (fi === -1 || ti === -1) return false;
    return ti === fi + 1;
  }

  // input: { examPaperId, studentId, title, dueAt, resultsVisibleToStudent? }
  // Guard: refuse a second *open* (ASSIGNED/IN_PROGRESS) assignment of the same paper to the same
  // student — two simultaneously-live assignments referencing the same paper would make "which one
  // is the real one" ambiguous once an attempt exists. Once the earlier one reaches
  // SUBMITTED/GRADED, the same paper CAN be assigned again (e.g. a retest) — this only blocks
  // creating a duplicate *while one is still pending*.
  async function createAssignment(input) {
    if (!input || !input.examPaperId) throw new Error("examPaperId가 필요해요.");
    if (!input.studentId) throw new Error("studentId가 필요해요.");
    const existing = await listAssignments();
    const dupe = existing.find((a) => a.examPaperId === input.examPaperId && a.studentId === input.studentId && (a.status === "ASSIGNED" || a.status === "IN_PROGRESS"));
    if (dupe) throw new Error("이 학생에게 이미 배정되어 진행 중인 같은 시험지가 있어요.");
    const now = Date.now();
    const doc = {
      examPaperId: input.examPaperId,
      studentId: input.studentId,
      title: input.title || "",
      assignedAt: now,
      dueAt: input.dueAt || null,
      status: "ASSIGNED",
      attemptId: null,
      // 결과 공개 여부 — examPaperService/FINALIZE는 그대로 두고 배정 단위로만 관리 (Phase 8-A 승인 결정).
      resultsVisibleToStudent: input.resultsVisibleToStudent === true,
      createdAt: now,
      updatedAt: now,
      createdBy: "teacher",
    };
    const id = await addDocTo(ASSIGNMENTS_COLLECTION, doc);
    return { id, ...doc };
  }

  async function getAssignment(id) {
    const data = await getDoc(ASSIGNMENTS_COLLECTION, id);
    return data ? { id, ...data } : null;
  }

  async function listAssignments() {
    const docs = await getAllDocs(ASSIGNMENTS_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ id, ...data }));
  }

  // Phase 9-D bugfix — where(studentId==) 대신 listAssignments()로 전체를 긁어와 필터링하면
  // firestore.rules의 "본인 studentId만 read" 규칙 아래에서 student/parent 토큰이 permission-
  // denied를 받는다(getDocsWhere 주석 참고). StudentExamListSection(학생 화면)과
  // syncStudentExamSummary(교사 화면) 둘 다 이 함수 하나만 쓰므로, 여기 한 곳만 고치면 양쪽 다
  // 해결된다 — 반환값 모양(배열)은 그대로라 두 호출부 모두 무수정.
  async function listStudentAssignments(studentId) {
    const docs = await getDocsWhere(ASSIGNMENTS_COLLECTION, "studentId", studentId);
    return Object.entries(docs).map(([id, data]) => ({ id, ...data }));
  }

  async function listExamPaperAssignments(examPaperId) {
    return (await listAssignments()).filter((a) => a.examPaperId === examPaperId);
  }

  // patch: extra fields to merge alongside the status change (e.g. { attemptId } when an attempt starts).
  async function updateAssignmentStatus(assignment, nextStatus, patch) {
    if (!canTransition(assignment.status, nextStatus)) {
      throw new Error(`허용되지 않는 상태 전환이에요: ${assignment.status} → ${nextStatus}`);
    }
    const now = Date.now();
    const patchOut = { ...(patch || {}), status: nextStatus, updatedAt: now };
    await setDocAt(ASSIGNMENTS_COLLECTION, assignment.id, patchOut, { merge: true });
    return { ...assignment, ...patchOut };
  }

  window.SarahServices.examAssignmentService = {
    ASSIGNMENTS_COLLECTION,
    canTransition,
    createAssignment,
    getAssignment,
    listAssignments,
    listStudentAssignments,
    listExamPaperAssignments,
    updateAssignmentStatus,
  };
})();
