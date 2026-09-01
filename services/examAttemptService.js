// Phase 8-A — Student Exam Runtime, attempt half. Owns the `examAttempts` collection: one doc per
// actual sitting of an assignment. Like examAssignmentService, never touches
// sarahsEnglishStudents/<id> directly — any student-doc summary field (§10 of the Phase 8 plan) is
// the UI layer's job via App()'s existing updateData(), not this file's.
//
// Grading is a pure function (computeGrading) with no Firestore/network calls, kept separate from
// the Firestore-writing gradeAttempt() wrapper on purpose — it's independently testable against
// plain objects. Subjective-format questions are never auto-graded this Phase (no AI call, no
// free-text matching): they land in `results[qId].correct = null` and count toward
// `ungradedCount`, excluded from `score`/correctCount/wrongCount, left for a future teacher
// manual-grading UI (Phase 8-A approval decision — not built yet, just structurally allowed for).
window.SarahServices = window.SarahServices || {};

(function () {
  const { getDoc, getAllDocs, addDocTo, setDocAt, deleteDocAt } = window.SarahServices.firebaseClient;
  const AS = window.SarahServices.examAssignmentService;

  const ATTEMPTS_COLLECTION = "examAttempts";

  function flattenQuestionIds(paper) {
    const ids = [];
    (paper.sections || []).forEach((s) => (s.questionRefs || []).forEach((r) => ids.push(r.questionId)));
    return ids;
  }

  async function getAttempt(id) {
    const data = await getDoc(ATTEMPTS_COLLECTION, id);
    return data ? { id, ...data } : null;
  }

  async function listAllAttempts() {
    const docs = await getAllDocs(ATTEMPTS_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ id, ...data }));
  }

  async function listStudentAttempts(studentId) {
    return (await listAllAttempts()).filter((a) => a.studentId === studentId);
  }

  // Phase 8-B addition — ExamAssignmentManager's list view needs 제출여부/점수 per row without an
  // N+1 fetch per assignment; just exposes the already-existing internal full-collection read
  // (same getAllDocs-then-filter convention every other list function in this app uses).
  async function listAttempts() {
    return listAllAttempts();
  }

  // Idempotent resume — if the assignment already points at an IN_PROGRESS attempt, hand that back
  // instead of creating a second one. Mirrors index.html's existing activeTestSession/activeMock
  // resume-on-reload pattern already used elsewhere in StudentDash (§7 of the Phase 8 plan:
  // "새로고침해도 답안 유지" / "문제 1→5→2로 이동해도 기존 답안 유지"). Refuses to start a fresh
  // attempt once the assignment has already moved past IN_PROGRESS (no retake flow this Phase).
  async function startAttempt(assignment, paper) {
    if (assignment.attemptId) {
      const existing = await getAttempt(assignment.attemptId);
      if (existing && existing.status === "IN_PROGRESS") return existing;
    }
    if (assignment.status === "SUBMITTED" || assignment.status === "GRADED") {
      throw new Error("이미 제출된 시험이에요. 다시 응시할 수 없어요.");
    }
    const questionIds = flattenQuestionIds(paper);
    const now = Date.now();
    const doc = {
      assignmentId: assignment.id,
      examPaperId: assignment.examPaperId,
      studentId: assignment.studentId,
      startedAt: now,
      submittedAt: null,
      status: "IN_PROGRESS",
      answers: {},
      results: {},
      totalQuestions: questionIds.length,
      correctCount: 0,
      wrongCount: 0,
      ungradedCount: 0,
      score: 0,
      createdAt: now,
      updatedAt: now,
    };
    const id = await addDocTo(ATTEMPTS_COLLECTION, doc);
    const attempt = { id, ...doc };
    await AS.updateAssignmentStatus(assignment, "IN_PROGRESS", { attemptId: id });
    return attempt;
  }

  // Whole-map overwrite (not per-key dot-notation) is intentional and safe here: unlike the shared
  // per-student doc (which needs updateData()'s transaction because multiple actors/tabs can race
  // on it), one exam attempt has exactly one writer — the student working through it in one tab.
  async function saveAnswer(attempt, questionId, selectedAnswer) {
    if (attempt.status !== "IN_PROGRESS") throw new Error("제출된 시험은 답을 수정할 수 없어요.");
    const now = Date.now();
    const answers = { ...(attempt.answers || {}), [questionId]: selectedAnswer };
    await setDocAt(ATTEMPTS_COLLECTION, attempt.id, { answers, updatedAt: now }, { merge: true });
    return { ...attempt, answers, updatedAt: now };
  }

  async function submitAttempt(attempt) {
    if (attempt.status !== "IN_PROGRESS") throw new Error("이미 제출된 시험이에요.");
    const now = Date.now();
    const patch = { status: "SUBMITTED", submittedAt: now, updatedAt: now };
    await setDocAt(ATTEMPTS_COLLECTION, attempt.id, patch, { merge: true });
    const submitted = { ...attempt, ...patch };
    const assignment = await AS.getAssignment(attempt.assignmentId);
    if (assignment) await AS.updateAssignmentStatus(assignment, "SUBMITTED");
    return submitted;
  }

  // Pure — no Firestore reads/writes, no side effects. `questionsById` must cover exactly the
  // question set this attempt's paper referenced (same convention as examPaperService's
  // finalizeExamPaper(existingDoc, questionsById)). MC (`answerFormat === "mc"`) is graded by index
  // comparison; subjective is always `correct: null` / ungraded, per the Phase 8-A decision.
  function computeGrading(attempt, questionsById) {
    const results = {};
    let correctCount = 0, wrongCount = 0, ungradedCount = 0;
    Object.entries(questionsById).forEach(([qId, qDoc]) => {
      const selectedAnswer = (attempt.answers || {})[qId];
      const has = selectedAnswer !== undefined && selectedAnswer !== null && selectedAnswer !== "";
      if (qDoc.answerFormat === "subjective") {
        results[qId] = { correct: null, selectedAnswer: has ? selectedAnswer : null, correctAnswer: qDoc.answer, answerFormat: "subjective" };
        ungradedCount += 1;
        return;
      }
      const correct = has && Number(selectedAnswer) === Number(qDoc.answer);
      results[qId] = { correct, selectedAnswer: has ? selectedAnswer : null, correctAnswer: qDoc.answer, answerFormat: "mc" };
      if (correct) correctCount += 1; else wrongCount += 1;
    });
    return {
      results,
      totalQuestions: Object.keys(questionsById).length,
      correctCount,
      wrongCount,
      ungradedCount,
      score: correctCount, // raw count (matches this app's existing score/total convention — mockExamResults 등 — not a percentage)
    };
  }

  async function gradeAttempt(attempt, questionsById) {
    if (attempt.status === "IN_PROGRESS") throw new Error("제출 전에는 채점할 수 없어요.");
    const grading = computeGrading(attempt, questionsById);
    const now = Date.now();
    const patch = { ...grading, status: "GRADED", updatedAt: now };
    await setDocAt(ATTEMPTS_COLLECTION, attempt.id, patch, { merge: true });
    const graded = { ...attempt, ...patch };
    const assignment = await AS.getAssignment(attempt.assignmentId);
    if (assignment) await AS.updateAssignmentStatus(assignment, "GRADED");
    return graded;
  }

  // §12 — "이 문제가 어느 시험지/학생에게 언제 나갔고 언제/몇 점으로 응시됐는가"를 examAttempts/
  // examAssignments/examPapers 세 컬렉션을 조합해 조회. 별도 이력 컬렉션은 만들지 않는다(지시사항 그대로).
  async function getQuestionUsageHistory(questionId) {
    const EP = window.SarahServices.examPaperService;
    const [papers, assignments, attempts] = await Promise.all([EP.listExamPapers(), AS.listAssignments(), listAllAttempts()]);
    const paperIdsWithQuestion = new Set(
      papers.filter((p) => (p.sections || []).some((s) => (s.questionRefs || []).some((r) => r.questionId === questionId))).map((p) => p.id)
    );
    const paperTitleById = {};
    papers.forEach((p) => { paperTitleById[p.id] = p.title; });
    const attemptById = {};
    attempts.forEach((a) => { attemptById[a.id] = a; });

    return assignments
      .filter((a) => paperIdsWithQuestion.has(a.examPaperId))
      .map((a) => {
        const attempt = a.attemptId ? attemptById[a.attemptId] : null;
        const result = attempt && attempt.results ? attempt.results[questionId] : null;
        return {
          examPaperId: a.examPaperId,
          examPaperTitle: paperTitleById[a.examPaperId] || a.examPaperId,
          studentId: a.studentId,
          assignedAt: a.assignedAt,
          // Phase 8-G addition — startedAt/attemptStatus so the Question Bank UI can show 응시 시작일
          // and distinguish "아직 응시 안 함"/"채점 대기" from an actual graded result, not just null.
          startedAt: attempt ? attempt.startedAt : null,
          submittedAt: attempt ? attempt.submittedAt : null,
          attemptStatus: attempt ? attempt.status : null,
          correct: result ? result.correct : null,
        };
      });
  }

  // 전체 시험 이력(AssessmentTimelineView) 삭제 버튼용(2026-09-01) — attempt 문서 자체를 지운다.
  // 연결된 assignment는 examAssignmentService.deleteAssignment가 별도로 지운다.
  async function deleteAttempt(id) {
    await deleteDocAt(ATTEMPTS_COLLECTION, id);
  }

  window.SarahServices.examAttemptService = {
    ATTEMPTS_COLLECTION,
    startAttempt,
    saveAnswer,
    submitAttempt,
    gradeAttempt,
    computeGrading,
    getAttempt,
    listStudentAttempts,
    listAttempts,
    getQuestionUsageHistory,
    deleteAttempt,
  };
})();
