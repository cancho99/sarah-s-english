// Phase 9-D 이후 데이터 흐름(문제은행→시험지→배정→응시→채점, functions/index.js·
// services/examAttemptService.js·questionBankService.js 참고)을 학생별 문항 단위 정답률로 한
// 단계 더 연결하는 순수 계산 모듈. 새 Firestore collection이나 스키마 변경 없음 — 기존
// examAttempts.results(computeGrading이 이미 채워둔 것, 손대지 않음)와 기존
// grammarQuestions/readingQuestions의 mainCategory/subCategory만 조인한다.
//
// 2026-08-27 — "취약 유형(Weak Areas)" 판정 기능은 사용자 요청으로 전면 제거됐다(카드/탭/영역별
// 정확도 breakdown 전부). 이 모듈에는 그 흔적으로 함수/파일 이름에 여전히 "Weakness"가 남아있지만
// (리네임은 이번 범위 밖으로 보류), 실제로 하는 일은 학생 Assessment → Question Performance 탭이
// 쓰는 문항별 정답률(questionAccuracy) 계산 하나뿐이다.
//
// examAttemptService.getQuestionUsageHistory()와 겹치는 부분 검토: 그 함수는 "문제 하나 → 여러
// 학생/시도"를 조인하는 반대 방향 질의(Question Bank UI의 "출제 이력" 패널용)라, 여기서 필요한
// "학생 하나 → 여러 문제" 집계와는 순회 축이 달라 재사용 가능한 공통 로직은 사실상
// attempt.results[qId].correct를 읽는 것 정도뿐 — 별도 함수로 분리하는 것이 더 단순하다고 판단.
//
// computeStudentWeaknessAnalysis()는 순수 함수(Firestore 접근 없음, computeGrading과 같은 원칙)
// — 이미 로드된 attempts/question 목록을 인자로 받는다. getStudentWeaknessAnalysis()는 그
// 순수 함수를 기존 서비스 함수(examAttemptService.listStudentAttempts, questionBankService.
// listGrammarQuestions/listReadingQuestions)로 데이터를 읽어와 호출하는 얇은 편의 함수 — 새
// Firestore 접근 코드를 추가하지 않고 기존 서비스만 재사용한다.
// UI 연결 현황(작성 시점 기준, 실제 호출부는 index.html을 grep해 재확인할 것): StudentDetailSection
// (학생 상세, getStudentWeaknessAnalysis 호출) → StudentAssessmentTab의 Question Performance 탭
// (StudentQuestionAccuracyPanel)이 그 결과의 questionAccuracy 필드만 읽는다.
window.SarahServices = window.SarahServices || {};

(function () {
  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // { [questionId]: { ...questionDoc, bank } } — grammarQuestions/readingQuestions를 한 맵으로
  // 합치되 어느 은행 소속인지(bank) 표시해둔다. 두 컬렉션에 같은 id가 우연히 겹칠 일은 없다
  // (Firestore auto-id) — 겹치면 grammar를 우선한다(호출 순서).
  function buildQuestionsById(grammarQuestions, readingQuestions) {
    const map = {};
    (grammarQuestions || []).forEach((q) => { map[q.id] = { ...q, bank: "grammar" }; });
    (readingQuestions || []).forEach((q) => { if (!map[q.id]) map[q.id] = { ...q, bank: "reading" }; });
    return map;
  }

  // 요구사항 1~7 — attempts를 순회하며 attempt.results[qId]를 questionsById로 조인해
  // bank/mainCategory/subCategory 별 { total, correct, wrong } 누적치를 만든다. `total`은 항상
  // "correct !== null인(=채점된) 시도 수"만 센다(요구사항 7 — subjective 미채점은 정확도 계산에서
  // 제외) — answered와는 다른 개념이라 별도로 answeredCount를 함께 반환한다.
  function aggregate(studentId, attempts) {
    const byKey = {}; // "bank|mainCategory|subCategory" -> { bank, mainCategory, subCategory, total, correct, wrong, answered }
    // Phase 2(Teacher OS) STEP 3 추가 — questionId 단위 누적치. byKey와 같은 순회에서 같이 쌓는다
    // (별도 조회/traversal 없음) — 학생 Overview의 "문항별 정답률"이 쓴다.
    const byQuestion = {}; // questionId -> { questionId, bank, mainCategory, subCategory, questionText, total, correct, wrong }
    let totalQuestions = 0;
    let answeredQuestions = 0;
    let correctQuestions = 0;
    let gradableQuestions = 0;

    (attempts || [])
      .filter((a) => a && a.studentId === studentId)
      .forEach((attempt) => {
        Object.entries(attempt.results || {}).forEach(([questionId, result]) => {
          const qDoc = attempt.__questionsById[questionId];
          if (!qDoc) return; // 요구사항 6 — 존재하지 않는 questionId는 안전하게 skip

          totalQuestions += 1;
          const hasAnswer = result.selectedAnswer !== undefined && result.selectedAnswer !== null && result.selectedAnswer !== "";
          if (hasAnswer) answeredQuestions += 1;

          const key = `${qDoc.bank}|${qDoc.mainCategory || ""}|${qDoc.subCategory || ""}`;
          if (!byKey[key]) {
            byKey[key] = { bank: qDoc.bank, mainCategory: qDoc.mainCategory || "", subCategory: qDoc.subCategory || "", total: 0, correct: 0, wrong: 0 };
          }
          const bucket = byKey[key];

          if (!byQuestion[questionId]) {
            byQuestion[questionId] = { questionId, bank: qDoc.bank, mainCategory: qDoc.mainCategory || "", subCategory: qDoc.subCategory || "", questionText: qDoc.questionText || "", total: 0, correct: 0, wrong: 0 };
          }
          const qBucket = byQuestion[questionId];

          if (result.correct === null || result.correct === undefined) return; // 요구사항 7 — 정확도 계산 제외
          gradableQuestions += 1;
          bucket.total += 1;
          qBucket.total += 1;
          if (result.correct === true) { correctQuestions += 1; bucket.correct += 1; qBucket.correct += 1; }
          else if (result.correct === false) { bucket.wrong += 1; qBucket.wrong += 1; }
        });
      });

    return { byKey, byQuestion, totalQuestions, answeredQuestions, correctQuestions, gradableQuestions };
  }

  function accuracyOf(bucket) {
    return bucket.total > 0 ? round1((bucket.correct / bucket.total) * 100) : 0;
  }

  // input:
  //   studentId — 분석 대상 학생 id (roster의 id, examAttempts.studentId와 동일)
  //   attempts — 이 학생의 examAttempts 문서 배열(다른 학생 것이 섞여 있어도 studentId로 걸러냄)
  //   grammarQuestions / readingQuestions — 문제은행 전체 또는 필요한 만큼의 목록(questionBankService의
  //     listGrammarQuestions()/listReadingQuestions() 반환 그대로)
  // computeGrading과 마찬가지로 Firestore를 전혀 건드리지 않는 순수 함수. 함수/파일 이름은
  // "Weakness"를 그대로 쓰고 있지만(2026-08-27 시점 리네임은 범위 밖으로 보류), 실제로는
  // questionAccuracy(문항별 정답률, Question Performance 탭)만 남았다 — 취약 유형(weakAreas)/
  // 영역별 정확도(grammar/reading categories) 계산은 그 UI가 전부 제거되면서(사용자 요청) 같이
  // 뺐다.
  function computeStudentWeaknessAnalysis({ studentId, attempts, grammarQuestions, readingQuestions }) {
    const questionsById = buildQuestionsById(grammarQuestions, readingQuestions);
    // aggregate()가 attempt별로 questionsById를 참조할 수 있게 임시로 붙여둔다(순회 편의용,
    // 반환값에는 포함 안 시킴 — 원본 attempts 배열/객체는 변경하지 않도록 얕은 복사로 붙인다).
    const attemptsWithLookup = (attempts || []).map((a) => Object.assign(Object.create(null), a, { __questionsById: questionsById }));

    const { byQuestion } = aggregate(studentId, attemptsWithLookup);

    // Teacher OS STEP 3 — 학생 평가 탭의 "문항별 정답률". 채점된(gradable) 문항만, 정확도 낮은 순.
    const questionAccuracy = Object.values(byQuestion)
      .filter((q) => q.total > 0)
      .map((q) => ({ ...q, accuracy: accuracyOf(q) }))
      .sort((a, b) => a.accuracy - b.accuracy);

    return { studentId, questionAccuracy };
  }

  // 편의 함수 — 기존 서비스만 재사용해서 데이터를 읽어온 뒤 위 순수 함수를 호출한다. 새
  // Firestore 접근 코드를 추가하지 않는다(examAttemptService.listStudentAttempts,
  // questionBankService.listGrammarQuestions/listReadingQuestions 그대로 호출).
  async function getStudentWeaknessAnalysis(studentId) {
    const AT = window.SarahServices.examAttemptService;
    const QB = window.SarahServices.questionBankService;
    const [attempts, grammarQuestions, readingQuestions] = await Promise.all([
      AT.listStudentAttempts(studentId),
      QB.listGrammarQuestions(),
      QB.listReadingQuestions(),
    ]);
    return computeStudentWeaknessAnalysis({ studentId, attempts, grammarQuestions, readingQuestions });
  }

  window.SarahServices.studentAnalysisService = {
    computeStudentWeaknessAnalysis,
    getStudentWeaknessAnalysis,
  };
})();
