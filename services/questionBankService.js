// Phase 5 — Question Bank Core + Grammar Question Bank (first bank implemented on top of it).
//
// Design goal (per Phase 5 spec §1): don't build a one-off structure just for grammar. Everything
// below is split into two layers —
//   1. Generic "core" functions (list/create/update/status transitions/versioning/dedup/query),
//      each taking a `collectionName` so any future bank (readingQuestions, mockExamQuestionBank,
//      originalQuestions — see ARCHITECTURE.md §11) reuses the same CRUD/versioning/query code
//      instead of every bank reimplementing it.
//   2. A thin Grammar-specific layer (taxonomy constants + a `grammarQuestions`-bound API) that is
//      the only part actually wired into UI this phase.
//
// Every doc in a question-bank collection shares this shape (see ARCHITECTURE.md §11.2):
//   { id, grade, difficulty, mainCategory, subCategory, questionType, questionText, choices,
//     answerFormat, answer, explanation, wrongChoiceExplanations, tags, source: {type, note},
//     status, review: {...}, fingerprint, usageCount, version, supersedesId, replacedBy,
//     createdAt, updatedAt, createdBy }
//
// Firestore access goes entirely through services/firebaseClient.js — no ad hoc window.__* calls
// here or in the UI (CLAUDE.md "Project reconstruction" principle: new functionality goes through
// a service layer, not more ad hoc Firestore calls in components).
window.SarahServices = window.SarahServices || {};

(function () {
  const { getAllDocs, addDocTo, setDocAt, deleteDocAt } = window.SarahServices.firebaseClient;

  // ---------------------------------------------------------------------------------------------
  // Shared taxonomy / enums (§2-§8 of the Phase 5 spec)
  // ---------------------------------------------------------------------------------------------

  const GRADES = ["중1", "중2", "중3", "고1", "고2", "고3"];

  const DIFFICULTIES = [
    { key: "BASIC", label: "Basic" },
    { key: "INTERMEDIATE", label: "Intermediate" },
    { key: "ADVANCED", label: "Advanced" },
    { key: "KILLER", label: "Killer" },
  ];

  // Grammar 대주제/세부주제 taxonomy — researched proposal (Phase 5 spec §2 explicitly asked not to
  // just take the user's draft numbers as final, but to check them against actual 중1~고3 교재
  // 커리큘럼 + 수능/내신 문법 출제 유형). This list keeps the user's 22-topic skeleton (it already
  // matches how Korean middle/high-school grammar curricula and 수능 어법 기출 are conventionally
  // organized) but adds a subCategory level under each — the "대주제 → 세부 문법" layer the spec
  // requires (§2 example: 시제 → 현재완료). "기타" is kept as an intentional overflow bucket, not a
  // dumping ground default — the UI never pre-selects it.
  const GRAMMAR_TAXONOMY = [
    { key: "sentenceStructure", label: "문장의 기본 구조", subCategories: [
      { key: "svPatterns", label: "문형 (SV~SVOC)" },
      { key: "wordOrder", label: "어순" },
      { key: "sentenceTypes", label: "문장의 종류 (평서/의문/명령/감탄)" },
    ]},
    { key: "partsOfSpeech", label: "품사", subCategories: [
      { key: "nounPronoun", label: "명사·대명사" },
      { key: "adjectiveAdverb", label: "형용사·부사" },
      { key: "preposition", label: "전치사" },
      { key: "article", label: "관사" },
    ]},
    { key: "sentenceElements", label: "문장 성분", subCategories: [
      { key: "subjectVerb", label: "주어·동사" },
      { key: "objectComplement", label: "목적어·보어" },
      { key: "modifierPlacement", label: "수식어 위치" },
    ]},
    { key: "tense", label: "시제", subCategories: [
      { key: "presentPast", label: "현재·과거" },
      { key: "presentPerfect", label: "현재완료" },
      { key: "pastPerfect", label: "과거완료" },
      { key: "progressive", label: "진행형" },
      { key: "tenseAgreement", label: "시제 일치" },
    ]},
    { key: "modal", label: "조동사", subCategories: [
      { key: "basicModals", label: "기본 조동사 (can/may/must/should)" },
      { key: "modalPerfect", label: "조동사 + have p.p." },
      { key: "modalIdioms", label: "조동사 관용표현" },
    ]},
    { key: "passive", label: "수동태", subCategories: [
      { key: "basicPassive", label: "기본 수동태" },
      { key: "ditransitivePassive", label: "4형식·5형식 수동태" },
      { key: "prepositionalPassive", label: "by 이외 전치사 수동태" },
      { key: "progressivePerfectPassive", label: "진행·완료 수동태" },
    ]},
    { key: "infinitive", label: "부정사", subCategories: [
      { key: "infinitiveUsage", label: "명사·형용사·부사적 용법" },
      { key: "bareInfinitive", label: "원형부정사" },
      { key: "infinitiveSubject", label: "의미상 주어" },
    ]},
    { key: "gerund", label: "동명사", subCategories: [
      { key: "gerundVsInfinitive", label: "동명사 vs to부정사" },
      { key: "gerundIdioms", label: "동명사 관용표현" },
    ]},
    { key: "participle", label: "분사", subCategories: [
      { key: "presentPastParticiple", label: "현재분사·과거분사" },
      { key: "participleClause", label: "분사구문" },
      { key: "emotionParticiple", label: "감정 분사" },
    ]},
    { key: "relative", label: "관계사", subCategories: [
      { key: "relativePronoun", label: "관계대명사" },
      { key: "relativeAdverb", label: "관계부사" },
      { key: "continuativeUsage", label: "계속적 용법" },
      { key: "compoundRelative", label: "복합관계사" },
    ]},
    { key: "conjunction", label: "접속사", subCategories: [
      { key: "coordinating", label: "등위접속사" },
      { key: "subordinating", label: "종속접속사" },
      { key: "correlative", label: "상관접속사" },
    ]},
    { key: "nounClause", label: "명사절", subCategories: [
      { key: "thatClause", label: "that절" },
      { key: "whetherIfClause", label: "whether/if절" },
      { key: "whClause", label: "의문사절" },
    ]},
    { key: "adverbClause", label: "부사절", subCategories: [
      { key: "timeReason", label: "시간·이유" },
      { key: "conditionConcession", label: "조건·양보" },
      { key: "purposeResult", label: "목적·결과" },
    ]},
    { key: "conditional", label: "조건문", subCategories: [
      { key: "realCondition", label: "직설법 조건문" },
      { key: "unlessOtherwise", label: "unless 등 조건 표현" },
    ]},
    { key: "subjunctive", label: "가정법", subCategories: [
      { key: "subjunctivePast", label: "가정법 과거" },
      { key: "subjunctivePastPerfect", label: "가정법 과거완료" },
      { key: "mixedSubjunctive", label: "혼합 가정법" },
      { key: "wishAsIf", label: "I wish / as if" },
    ]},
    { key: "comparison", label: "비교", subCategories: [
      { key: "positiveComparative", label: "원급·비교급" },
      { key: "superlative", label: "최상급" },
      { key: "comparisonIdioms", label: "비교 관용표현" },
    ]},
    { key: "agreement", label: "일치", subCategories: [
      { key: "subjectVerbAgreement", label: "수 일치 (주어-동사)" },
      { key: "tenseAgreementDetail", label: "시제 일치" },
    ]},
    { key: "inversion", label: "도치", subCategories: [
      { key: "negativeInversion", label: "부정어 도치" },
      { key: "soNeitherInversion", label: "so/neither 도치" },
      { key: "placeAdverbInversion", label: "장소부사구 도치" },
    ]},
    { key: "emphasis", label: "강조", subCategories: [
      { key: "itThatEmphasis", label: "it ~ that 강조구문" },
      { key: "doEmphasis", label: "do 강조" },
    ]},
    { key: "parallelism", label: "병렬", subCategories: [
      { key: "coordinatingParallel", label: "등위접속사 병렬" },
      { key: "correlativeParallel", label: "상관접속사 병렬" },
    ]},
    { key: "verbals", label: "준동사 종합", subCategories: [
      { key: "verbalMixed", label: "부정사·동명사·분사 통합 오류 (수능 어법 대표 유형)" },
    ]},
    { key: "etc", label: "기타", subCategories: [
      { key: "ellipsis", label: "생략" },
      { key: "inanimateSubject", label: "무생물 주어" },
      { key: "insertion", label: "삽입·동격" },
    ]},
  ];

  // 문제 유형 — 문법 주제와 분리된 별도 축 (spec §3: "현재완료 + 어법상 옳은 것" ≠ "현재완료 + 빈칸").
  // "객관식"/"서술형"은 사용자가 §3에 명시한 유형이라 선택지로 유지하되, 실제 채점 방식은 이 값과
  // 별개로 answerFormat(§11.2, choices 유무로 자동 결정)에서 나온다 — 교사가 "빈칸"을 고르고 객관식
  // 보기를 입력하면 answerFormat은 자동으로 mc가 된다.
  const QUESTION_TYPES = [
    { key: "blank", label: "빈칸" },
    { key: "grammarCorrect", label: "어법상 옳은 것" },
    { key: "grammarIncorrect", label: "어법상 틀린 것" },
    { key: "underlineError", label: "밑줄 오류" },
    { key: "sentenceCompletion", label: "문장 완성" },
    { key: "sentenceChoice", label: "올바른 문장 선택" },
    { key: "sentenceOrdering", label: "문장 배열" },
    { key: "writing", label: "영작" },
    { key: "transformation", label: "변형" },
    { key: "shortAnswer", label: "서술형" },
    { key: "multipleChoice", label: "객관식" },
  ];

  const SOURCE_TYPES = [
    { key: "ORIGINAL", label: "자체 제작" },
    { key: "TEXTBOOK_VARIATION", label: "교재 변형" },
    { key: "TEACHER_CREATED", label: "교사 출제" },
    { key: "AI_GENERATED", label: "AI 생성" },
    { key: "PAST_EXAM_REFERENCE", label: "기출 유형 참고" },
  ];

  // Status pipeline (§5). Order matters — used for "forward" transition validation below.
  // PUBLISHED is reachable only from APPROVED, and only a human calls setStatus (there is no AI
  // auto-generation wired up yet this phase, but the guard is here so that stays true later too —
  // spec §5/§19: "AI가 자동으로 APPROVED 처리하면 안 된다").
  const STATUS_FLOW = [
    { key: "DRAFT", label: "초안" },
    { key: "AI_REVIEW", label: "AI 검토" },
    { key: "TEACHER_REVIEW", label: "교사 검토" },
    { key: "APPROVED", label: "승인됨" },
    { key: "PUBLISHED", label: "출제 가능" },
    { key: "ARCHIVED", label: "보관됨" },
  ];
  const STATUS_ORDER = STATUS_FLOW.map((s) => s.key);

  function canTransition(from, to) {
    if (to === "ARCHIVED") return from !== "ARCHIVED"; // anything (once) can be archived
    if (from === "ARCHIVED") return to === "DRAFT"; // restoring only puts it back to DRAFT
    if (to === "PUBLISHED") return from === "APPROVED"; // the one hard rule from §5/§19
    const fi = STATUS_ORDER.indexOf(from);
    const ti = STATUS_ORDER.indexOf(to);
    if (fi === -1 || ti === -1) return false;
    return ti === fi + 1 || ti === fi - 1; // one step forward (review pipeline) or one step back (send back for revision)
  }

  // Content fields that, if changed on a question that has already been used in a real exam
  // (usageCount > 0), must fork a new version instead of editing in place (§12: editing a
  // used question must never change what a past exam's results mean).
  const CONTENT_FIELDS = ["grade", "difficulty", "mainCategory", "subCategory", "questionType", "questionText", "choices", "answer"];

  // ---------------------------------------------------------------------------------------------
  // Fingerprint / duplicate detection (§14) — normalized-text match, not AI similarity. Catches
  // exact-or-near-exact re-entry (copy-paste, re-typing the same sentence with different spacing/
  // casing/punctuation), which is the realistic day-to-day duplicate risk for a teacher hand-
  // entering questions. Real semantic-similarity detection is explicitly out of scope this phase.
  // ---------------------------------------------------------------------------------------------
  function normalizeForFingerprint(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[.,!?;:'"()\[\]_\-—–]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function computeFingerprint(text) {
    const norm = normalizeForFingerprint(text);
    let hash = 0;
    for (let i = 0; i < norm.length; i++) {
      hash = (hash * 31 + norm.charCodeAt(i)) | 0;
    }
    return `${norm.length}:${hash}`;
  }
  function findDuplicates(list, questionText, excludeId) {
    const fp = computeFingerprint(questionText);
    if (!normalizeForFingerprint(questionText)) return [];
    return (list || []).filter((q) => q.id !== excludeId && q.fingerprint === fp);
  }

  // ---------------------------------------------------------------------------------------------
  // Generic core CRUD (collectionName-parameterized — reused by every future bank, §1/§15)
  // ---------------------------------------------------------------------------------------------
  async function listQuestions(collectionName) {
    const docs = await getAllDocs(collectionName);
    return Object.entries(docs).map(([id, data]) => ({ id, ...data }));
  }

  function blankReview() {
    return {
      grammarChecked: null, answerVerified: null, explanationVerified: null,
      difficultyAppropriate: null, distractorQuality: null,
      naeshinFit: null, suneungFit: null, duplicateChecked: null,
      reviewNote: "", reviewedBy: null, reviewedAt: null,
    };
  }

  // input: { grade, difficulty, mainCategory, subCategory, questionType, questionText, choices,
  //          answer, explanation, wrongChoiceExplanations, tags, source }
  // Always created as DRAFT (§11), version 1, usageCount 0 — status only ever advances via setStatus.
  async function createQuestion(collectionName, input) {
    const now = Date.now();
    const choices = Array.isArray(input.choices) ? input.choices.filter((c) => c != null && c !== "") : [];
    const doc = {
      grade: input.grade || "",
      difficulty: input.difficulty || "BASIC",
      mainCategory: input.mainCategory || "",
      subCategory: input.subCategory || "",
      questionType: input.questionType || "",
      questionText: input.questionText || "",
      choices,
      answerFormat: choices.length > 0 ? "mc" : "subjective",
      answer: choices.length > 0 ? Number(input.answer) : String(input.answer || ""),
      explanation: input.explanation || "",
      wrongChoiceExplanations: Array.isArray(input.wrongChoiceExplanations) ? input.wrongChoiceExplanations : [],
      tags: Array.isArray(input.tags) ? input.tags : [],
      source: { type: (input.source && input.source.type) || "TEACHER_CREATED", note: (input.source && input.source.note) || "" },
      status: "DRAFT",
      review: blankReview(),
      fingerprint: computeFingerprint(input.questionText),
      usageCount: 0,
      version: 1,
      supersedesId: null,
      replacedBy: null,
      createdAt: now,
      updatedAt: now,
      createdBy: "teacher",
    };
    const id = await addDocTo(collectionName, doc);
    return { id, ...doc };
  }

  // Versioning (§12): if the existing doc has usageCount > 0 and the patch touches a CONTENT_FIELD,
  // fork instead of overwriting — a new doc is created (version+1, supersedesId = old id, status
  // reset to DRAFT since edited content is unreviewed again, usageCount 0), and the old doc is
  // marked ARCHIVED + replacedBy so past exam results (which reference the old id) keep meaning
  // exactly what they meant when the exam was given.
  async function updateQuestion(collectionName, existingDoc, patch) {
    const touchesContent = Object.keys(patch).some((k) => CONTENT_FIELDS.includes(k));
    const now = Date.now();
    if ((existingDoc.usageCount || 0) > 0 && touchesContent) {
      const merged = { ...existingDoc, ...patch };
      const choices = Array.isArray(merged.choices) ? merged.choices.filter((c) => c != null && c !== "") : [];
      const forked = {
        ...merged,
        choices,
        answerFormat: choices.length > 0 ? "mc" : "subjective",
        answer: choices.length > 0 ? Number(merged.answer) : String(merged.answer || ""),
        status: "DRAFT",
        review: blankReview(),
        fingerprint: computeFingerprint(merged.questionText),
        usageCount: 0,
        version: (existingDoc.version || 1) + 1,
        supersedesId: existingDoc.id,
        replacedBy: null,
        createdAt: now,
        updatedAt: now,
      };
      delete forked.id;
      const newId = await addDocTo(collectionName, forked);
      await setDocAt(collectionName, existingDoc.id, { status: "ARCHIVED", replacedBy: newId, updatedAt: now }, { merge: true });
      return { forked: true, newId, oldId: existingDoc.id, doc: { id: newId, ...forked } };
    }
    const patchOut = { ...patch, updatedAt: now };
    if (touchesContent && patch.questionText !== undefined) patchOut.fingerprint = computeFingerprint(patch.questionText);
    if (patch.choices !== undefined || patch.answer !== undefined) {
      const choices = Array.isArray(patch.choices !== undefined ? patch.choices : existingDoc.choices) || [];
      const cleanChoices = choices.filter((c) => c != null && c !== "");
      patchOut.choices = cleanChoices;
      patchOut.answerFormat = cleanChoices.length > 0 ? "mc" : "subjective";
      const rawAnswer = patch.answer !== undefined ? patch.answer : existingDoc.answer;
      patchOut.answer = cleanChoices.length > 0 ? Number(rawAnswer) : String(rawAnswer || "");
    }
    await setDocAt(collectionName, existingDoc.id, patchOut, { merge: true });
    return { forked: false, doc: { ...existingDoc, ...patchOut } };
  }

  async function setStatus(collectionName, existingDoc, nextStatus, reviewPatch) {
    if (!canTransition(existingDoc.status, nextStatus)) {
      throw new Error(`허용되지 않는 상태 전환이에요: ${existingDoc.status} → ${nextStatus}`);
    }
    const now = Date.now();
    const patch = { status: nextStatus, updatedAt: now };
    if (reviewPatch) {
      patch.review = { ...blankReview(), ...existingDoc.review, ...reviewPatch, reviewedAt: now };
    }
    await setDocAt(collectionName, existingDoc.id, patch, { merge: true });
    return { ...existingDoc, ...patch };
  }

  // Hard delete only ever allowed for never-used drafts (§20 "기존 데이터는 손대지 않는다" — once a
  // question has been reviewed/published/used, "delete" must be Archive, not removal).
  function canHardDelete(doc) {
    return doc.status === "DRAFT" && (doc.usageCount || 0) === 0;
  }
  async function hardDeleteQuestion(collectionName, doc) {
    if (!canHardDelete(doc)) throw new Error("초안(DRAFT) 상태이고 사용된 적 없는 문제만 완전히 삭제할 수 있어요. 그 외에는 보관(Archive) 처리해 주세요.");
    await deleteDocAt(collectionName, doc.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Query / exam-builder foundation (§13). Client-side filtering over listQuestions() — this repo
  // has no firestore.rules/index config to audit (ARCHITECTURE.md §1.3), so compound server-side
  // `where` queries would need composite indexes this repo can't manage; every other content
  // collection (readingLibrary etc.) already filters client-side after a full fetch, so this stays
  // consistent rather than introducing a new access pattern for one collection.
  // ---------------------------------------------------------------------------------------------
  function queryQuestions(list, filters) {
    filters = filters || {};
    return (list || []).filter((q) => {
      if (filters.grade && q.grade !== filters.grade) return false;
      if (filters.difficulty && q.difficulty !== filters.difficulty) return false;
      if (filters.mainCategory && q.mainCategory !== filters.mainCategory) return false;
      if (filters.subCategory && q.subCategory !== filters.subCategory) return false;
      if (filters.questionType && q.questionType !== filters.questionType) return false;
      if (filters.source && (q.source && q.source.type) !== filters.source) return false;
      if (filters.status && filters.status.length && !filters.status.includes(q.status)) return false;
      if (filters.tags && filters.tags.length && !filters.tags.every((t) => (q.tags || []).includes(t))) return false;
      if (filters.search) {
        const needle = filters.search.toLowerCase();
        const haystack = `${q.questionText} ${(q.tags || []).join(" ")}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }

  // The actual "조건으로 N문제 뽑기" Exam Builder will call this directly later (§13/§17: this
  // phase only needs the query to exist, not a full builder UI). Defaults status to PUBLISHED only
  // — an exam should never accidentally pull an unreviewed DRAFT question.
  function pickQuestionsForExam(list, filters, count) {
    const pool = queryQuestions(list, { status: ["PUBLISHED"], ...filters });
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return count ? shuffled.slice(0, count) : shuffled;
  }

  // ---------------------------------------------------------------------------------------------
  // Grammar-specific bound API — the only part wired into UI this phase.
  // ---------------------------------------------------------------------------------------------
  const GRAMMAR_COLLECTION = "grammarQuestions";

  window.SarahServices.questionBankService = {
    GRADES, DIFFICULTIES, GRAMMAR_TAXONOMY, QUESTION_TYPES, SOURCE_TYPES, STATUS_FLOW,
    canTransition, computeFingerprint, findDuplicates,
    listQuestions, createQuestion, updateQuestion, setStatus, canHardDelete, hardDeleteQuestion,
    queryQuestions, pickQuestionsForExam,
    GRAMMAR_COLLECTION,
    listGrammarQuestions: () => listQuestions(GRAMMAR_COLLECTION),
    createGrammarQuestion: (input) => createQuestion(GRAMMAR_COLLECTION, input),
    updateGrammarQuestion: (doc, patch) => updateQuestion(GRAMMAR_COLLECTION, doc, patch),
    setGrammarQuestionStatus: (doc, nextStatus, reviewPatch) => setStatus(GRAMMAR_COLLECTION, doc, nextStatus, reviewPatch),
    hardDeleteGrammarQuestion: (doc) => hardDeleteQuestion(GRAMMAR_COLLECTION, doc),
  };
})();
