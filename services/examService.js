// Phase 1-B skeleton. Thin read adapters over the existing per-student exam fields — three
// parallel schemas that already coexist (see ARCHITECTURE.md §2.4): teacher-authored ad hoc
// quizzes (examTests/examResults), official mock-exam answer keys (mockExams/mockExamResults),
// and 내신/모의고사/교재성취평가 score log (regularExams). No new schema, no writes. Not yet
// wired into any UI — ExamEditor/MockExamEditor/RegularExamEditor in index.html are untouched.
window.SarahServices = window.SarahServices || {};

(function () {
  function getExamTestsForStudent(studentData) {
    return (studentData && studentData.examTests) || [];
  }

  function getExamResultsForStudent(studentData) {
    return (studentData && studentData.examResults) || [];
  }

  function getMockExamsForStudent(studentData) {
    return (studentData && studentData.mockExams) || [];
  }

  function getMockExamResultsForStudent(studentData) {
    return (studentData && studentData.mockExamResults) || [];
  }

  // The closer-to-a-real-gradebook record: 중간고사/기말고사/모의고사/교재성취평가/기출고사/기타.
  function getRegularExamsForStudent(studentData) {
    return (studentData && studentData.regularExams) || [];
  }

  // Phase 2 (Teacher Center "최근 시험" card): joins *Results with their *Tests/*Exams title,
  // same normalized shape vocabularyService.getRecentVocabResults uses so a caller can merge
  // and sort all three kinds together.
  function getRecentMockResults(studentId, studentName, studentData) {
    const mocks = getMockExamsForStudent(studentData);
    const titleById = {};
    mocks.forEach((m) => { titleById[m.id] = m.title; });
    return getMockExamResultsForStudent(studentData).map((r) => ({
      kind: "mock",
      studentId, studentName,
      title: titleById[r.testId] || "모의고사",
      date: r.date || null,
      score: r.score, total: r.total,
    }));
  }

  function getRecentExamResults(studentId, studentName, studentData) {
    const exams = getExamTestsForStudent(studentData);
    const titleById = {};
    exams.forEach((e) => { titleById[e.id] = e.title; });
    return getExamResultsForStudent(studentData).map((r) => ({
      kind: "exam",
      studentId, studentName,
      title: titleById[r.testId] || "시험",
      date: r.date || null,
      score: r.score, total: r.total,
    }));
  }

  // Phase 3 (Report Center): monthly stats for the Monthly Report dashboard.
  //
  // regularExams' `subject` field is free text (default "영어") and `materialCategory` only
  // exists for examType === "교재성취평가" (see EXAM_TYPES/MATERIAL_CATEGORIES in index.html —
  // MATERIAL_CATEGORIES is just ["문법","어휘","독해"], not a Grammar/Reading/Vocabulary/
  // Listening/Writing 5-way split). There is no reliable "Listening"/"Writing" category anywhere
  // in this app's actual exam data, so this groups by whatever category label the teacher actually
  // used (materialCategory when present, else subject) instead of assuming a fixed category list —
  // "데이터가 존재하는 영역만 표시" from the Phase 3 spec, taken literally rather than padded with
  // categories that don't exist in the data.
  function getMonthlyRegularExamBreakdown(studentData, month) {
    const rows = getRegularExamsForStudent(studentData).filter((x) => x.date && x.date.startsWith(month));
    const byCategory = {};
    rows.forEach((x) => {
      const cat = x.materialCategory || x.subject || "기타";
      (byCategory[cat] || (byCategory[cat] = [])).push(x);
    });
    const summary = {};
    Object.entries(byCategory).forEach(([cat, items]) => {
      const nums = items.map((x) => x.scoreNum).filter((n) => n != null);
      summary[cat] = {
        count: items.length,
        avg: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null,
        max: nums.length ? Math.max(...nums) : null,
        min: nums.length ? Math.min(...nums) : null,
      };
    });
    return { rows, byCategory: summary };
  }

  function getMonthlyMockAndExamResults(studentData, month) {
    const mocks = getRecentMockResults("", "", studentData).filter((r) => r.date && r.date.startsWith(month));
    const exams = getRecentExamResults("", "", studentData).filter((r) => r.date && r.date.startsWith(month));
    return { mocks, exams };
  }

  // Teacher OS STEP 13 — Today의 "오늘 시험 결과"/"최근 시험" 카드와 Daily Report의 "시험
  // (자동 연결)"/학부모 메시지 초안이 지금까지 mock+examTest 두 계통만 보고 regularExams(내신/
  // 모의고사/교재성취평가 등 수기 기록, RegularExamEditor)는 전부 빠뜨리고 있었다 — 학생이 오늘
  // 중간고사 점수를 입력해도 "오늘 시험 결과" 어디에도 안 뜨는 실제 누락이었다. 이 함수가 세
  // 계통을 하나로 합친다(Exam Builder/examAttempts는 별도 비동기 조회라 그대로 분리 유지 —
  // 호출부가 이미 examAttemptResults를 따로 합쳐서 쓰고 있어 그 패턴은 안 건드림). regularExams
  // 는 total이 없는 자유서식 점수라 total: null로 둔다(호출부는 fmtScoreDisplay로 처리).
  function getAllExamResultsForStudent(studentId, studentName, studentData) {
    const regular = getRegularExamsForStudent(studentData).map((x) => ({
      kind: "regular", studentId, studentName,
      title: x.examDetail || x.examType || "시험",
      date: x.date || null,
      score: x.score || (x.scoreNum != null ? String(x.scoreNum) : null), total: null,
    }));
    return [
      ...regular,
      ...getRecentMockResults(studentId, studentName, studentData),
      ...getRecentExamResults(studentId, studentName, studentData),
    ];
  }

  window.SarahServices.examService = {
    getExamTestsForStudent,
    getExamResultsForStudent,
    getMockExamsForStudent,
    getMockExamResultsForStudent,
    getRegularExamsForStudent,
    getRecentMockResults,
    getRecentExamResults,
    getAllExamResultsForStudent,
    getMonthlyRegularExamBreakdown,
    getMonthlyMockAndExamResults,
  };
})();
