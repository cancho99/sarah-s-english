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

  // Review checklists differ per bank (Phase 6, ARCHITECTURE.md §12.8): grammar checks 8 things,
  // reading checks 10 (passage↔question link, evidence clarity, rote-memory, ... ). Keyed by schema
  // so a bank asks for its own list; "grammar" stays the default so every Phase 5 call site and
  // every existing grammarQuestions doc keeps the exact same shape.
  const REVIEW_SCHEMAS = {
    grammar: ["grammarChecked", "answerVerified", "explanationVerified", "difficultyAppropriate",
      "distractorQuality", "naeshinFit", "suneungFit", "duplicateChecked"],
    reading: ["passageQuestionLink", "answerClarity", "distractorQuality", "evidenceClarity",
      "difficultyAppropriate", "gradeAppropriate", "examTypeFit", "notRoteMemory",
      "discrimination", "explanationValue"],
  };

  function blankReview(schemaKey) {
    const fields = REVIEW_SCHEMAS[schemaKey] || REVIEW_SCHEMAS.grammar;
    const out = {};
    fields.forEach((f) => { out[f] = null; });
    out.reviewNote = "";
    out.reviewedBy = null;
    out.reviewedAt = null;
    return out;
  }

  // input: { grade, difficulty, mainCategory, subCategory, questionType, questionText, choices,
  //          answer, explanation, wrongChoiceExplanations, tags, source }
  // Always created as DRAFT (§11), version 1, usageCount 0 — status only ever advances via setStatus.
  //
  // `opts` (Phase 6, ARCHITECTURE.md §12.9) — both optional, so every Phase 5 grammar call site is
  // unchanged. Reading questions carry fields grammar has no concept of (passageId/examType/
  // targetSkill/evidenceLocation); without `extraFields` the fixed doc literal below would silently
  // drop them.
  //   opts.extraFields — extra columns merged into the stored doc
  //   opts.reviewSchema — which REVIEW_SCHEMAS list to blank out ("grammar" default)
  async function createQuestion(collectionName, input, opts) {
    opts = opts || {};
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
      ...(opts.extraFields || {}),
      status: "DRAFT",
      review: blankReview(opts.reviewSchema),
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
  //
  // `opts` (Phase 6, §12.9), both optional — grammar call sites pass nothing and behave identically:
  //   opts.extraContentFields — additional fields that count as "content" for fork purposes
  //     (reading: passageId/examType — repointing a question to another passage, or reclassifying
  //      which exam it belongs to, must not silently rewrite history on an already-used question)
  //   opts.reviewSchema — which checklist the forked copy starts blank with
  // Shared copy-on-write engine (Phase 6, ARCHITECTURE.md §12.8/§12.9) — the safety-critical part
  // (fork-vs-in-place decision, archiving the old doc with replacedBy, fingerprinting) written once
  // and reused by both updateQuestion and updatePassage rather than copy-pasted per bank.
  // `deriveFields(merged)` lets each caller compute its own bank-specific derived columns
  // (choices/answerFormat/answer for questions; wordCount/estimatedReadingTime for passages)
  // without touching the fork/archive logic itself. `fingerprintField` names which field the
  // fingerprint is computed from (questionText vs passageText).
  async function forkOrUpdate(collectionName, existingDoc, patch, contentFields, opts, fingerprintField, deriveFields) {
    opts = opts || {};
    const touchesContent = Object.keys(patch).some((k) => contentFields.includes(k));
    const now = Date.now();
    if ((existingDoc.usageCount || 0) > 0 && touchesContent) {
      const merged = { ...existingDoc, ...patch, ...(deriveFields ? deriveFields({ ...existingDoc, ...patch }) : {}) };
      const forked = {
        ...merged,
        status: "DRAFT",
        review: blankReview(opts.reviewSchema),
        fingerprint: computeFingerprint(merged[fingerprintField]),
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
    if (deriveFields) Object.assign(patchOut, deriveFields({ ...existingDoc, ...patch }));
    if (patch[fingerprintField] !== undefined) patchOut.fingerprint = computeFingerprint(patch[fingerprintField]);
    await setDocAt(collectionName, existingDoc.id, patchOut, { merge: true });
    return { forked: false, doc: { ...existingDoc, ...patchOut } };
  }

  function deriveQuestionFields(merged) {
    const choices = Array.isArray(merged.choices) ? merged.choices.filter((c) => c != null && c !== "") : [];
    return {
      choices,
      answerFormat: choices.length > 0 ? "mc" : "subjective",
      answer: choices.length > 0 ? Number(merged.answer) : String(merged.answer || ""),
    };
  }

  async function updateQuestion(collectionName, existingDoc, patch, opts) {
    opts = opts || {};
    const contentFields = CONTENT_FIELDS.concat(opts.extraContentFields || []);
    return forkOrUpdate(collectionName, existingDoc, patch, contentFields, opts, "questionText", deriveQuestionFields);
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

  // Phase 7 (Exam Builder, ARCHITECTURE.md §13.8) — the moment a question/passage gets referenced
  // by a FINALIZED exam paper, its usageCount must go up so the copy-on-write versioning guard
  // (usageCount > 0 forks instead of mutating, §11.8/§12.8) kicks in and locks its content forever.
  // Deliberately NOT in CONTENT_FIELDS / not routed through updateQuestion — usageCount itself is
  // metadata about usage, not question content, so bumping it must never trigger a fork of the
  // question it's counting.
  async function incrementUsageCount(collectionName, doc) {
    const next = (doc.usageCount || 0) + 1;
    await setDocAt(collectionName, doc.id, { usageCount: next, updatedAt: Date.now() }, { merge: true });
    return { ...doc, usageCount: next };
  }

  // ---------------------------------------------------------------------------------------------
  // Query / exam-builder foundation (§13). Client-side filtering over listQuestions() — this repo
  // has no firestore.rules/index config to audit (ARCHITECTURE.md §1.3), so compound server-side
  // `where` queries would need composite indexes this repo can't manage; every other content
  // collection (readingLibrary etc.) already filters client-side after a full fetch, so this stays
  // consistent rather than introducing a new access pattern for one collection.
  // ---------------------------------------------------------------------------------------------
  // Generic over any bank's doc shape — grammar (mainCategory/subCategory) and reading
  // (examType/passageId/targetSkill, Phase 6 §12.9) filters below are just equality checks that
  // no-op when the field isn't on the doc or the filter isn't passed, so this one function serves
  // both without a bank-specific branch. Also doubles as the Passage list filter (§12.10) — a
  // passage doc has grade/difficulty/examType/status/tags/source but no questionType/mainCategory,
  // so those filters simply never match anything unless passed.
  function queryQuestions(list, filters) {
    filters = filters || {};
    return (list || []).filter((q) => {
      if (filters.grade && q.grade !== filters.grade) return false;
      if (filters.difficulty && q.difficulty !== filters.difficulty) return false;
      if (filters.mainCategory && q.mainCategory !== filters.mainCategory) return false;
      if (filters.subCategory && q.subCategory !== filters.subCategory) return false;
      if (filters.questionType && q.questionType !== filters.questionType) return false;
      if (filters.examType && q.examType !== filters.examType) return false;
      if (filters.passageType && q.passageType !== filters.passageType) return false;
      if (filters.passageId && q.passageId !== filters.passageId) return false;
      if (filters.targetSkill && q.targetSkill !== filters.targetSkill) return false;
      if (filters.source && (q.source && q.source.type) !== filters.source) return false;
      if (filters.status && filters.status.length && !filters.status.includes(q.status)) return false;
      if (filters.tags && filters.tags.length && !filters.tags.every((t) => (q.tags || []).includes(t))) return false;
      // Exam Builder dedup (Phase 8 prep) — lets auto-select and the manual picker exclude questionIds
      // already referenced by the exam paper being built. No-op for every other caller that doesn't pass it.
      if (filters.excludeIds && filters.excludeIds.length && filters.excludeIds.includes(q.id)) return false;
      if (filters.search) {
        const needle = filters.search.toLowerCase();
        // title/passageText only exist on Passage docs, topic only on Passage — harmless no-ops on
        // Question docs. Lets one search box cover "지문 제목/지문 본문/문제 본문/태그" (§12 spec §17).
        const haystack = `${q.questionText || ""} ${q.title || ""} ${q.passageText || ""} ${q.topic || ""} ${(q.tags || []).join(" ")}`.toLowerCase();
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
  // Grammar-specific bound API — Phase 5.
  // ---------------------------------------------------------------------------------------------
  const GRAMMAR_COLLECTION = "grammarQuestions";

  // ---------------------------------------------------------------------------------------------
  // Reading Question Bank (Phase 6, ARCHITECTURE.md §12) — Passage + Question, two collections.
  // No AI API calls anywhere below: wordCount/estimatedReadingTime are plain string math, not a
  // model call (CLAUDE.md "API cost policy").
  // ---------------------------------------------------------------------------------------------
  const READING_PASSAGE_COLLECTION = "readingPassages";
  const READING_QUESTION_COLLECTION = "readingQuestions";

  // §12.6 — exam/usage purpose, deliberately open-ended so INTERNATIONAL_SCHOOL/TOEFL/etc. can be
  // appended later without touching UI/filter code that iterates this array.
  const READING_EXAM_TYPES = [
    { key: "MIDDLE_SCHOOL_INTERNAL", label: "중학교 내신" },
    { key: "HIGH_SCHOOL_INTERNAL", label: "고등학교 내신" },
    { key: "MOCK_EXAM", label: "모의고사" },
    { key: "CSAT_STYLE", label: "수능형" },
    { key: "TEACHER_CREATED", label: "자체 제작" },
    { key: "PRACTICE", label: "연습용" },
  ];

  const PASSAGE_TYPES = [
    { key: "argumentative", label: "논설문" },
    { key: "expository", label: "설명문" },
    { key: "narrative", label: "서사문" },
    { key: "descriptive", label: "묘사문" },
    { key: "letterEmail", label: "편지·이메일" },
    { key: "dialogue", label: "대화문" },
    { key: "adNotice", label: "광고·안내문" },
    { key: "chartGraph", label: "도표·그래프" },
    { key: "literature", label: "문학" },
    { key: "textbook", label: "교과서 본문" },
    { key: "article", label: "기사" },
  ];

  // §12.7 — questionType and examType are independent axes; group here is a UI hint only, not an
  // enforced mapping. Group A/B/C don't repeat a type that already exists in another group (e.g.
  // "빈칸"/"서술형"/"어휘"/"순서"/"문장 삽입"/"요약" are Group A or B types reused via examType, not
  // redefined per group) — see ARCHITECTURE.md §12.7 for why duplicating would fragment stats.
  const READING_QUESTION_TYPES = [
    // Group A — 수능/모의고사형 (19)
    { key: "topic", label: "주제", group: "A" },
    { key: "title", label: "제목", group: "A" },
    { key: "mainIdea", label: "요지", group: "A" },
    { key: "claim", label: "주장", group: "A" },
    { key: "purpose", label: "목적", group: "A" },
    { key: "contentMatch", label: "내용 일치", group: "A" },
    { key: "contentMismatch", label: "내용 불일치", group: "A" },
    { key: "blank", label: "빈칸", group: "A" },
    { key: "sentenceInsertion", label: "문장 삽입", group: "A" },
    { key: "order", label: "글의 순서", group: "A" },
    { key: "irrelevantSentence", label: "무관한 문장", group: "A" },
    { key: "summaryCompletion", label: "요약문 완성", group: "A" },
    { key: "vocabulary", label: "어휘", group: "A" },
    { key: "contextualMeaning", label: "문맥상 의미", group: "A" },
    { key: "referentInference", label: "지칭 추론", group: "A" },
    { key: "inference", label: "추론", group: "A" },
    { key: "authorAttitude", label: "필자의 태도", group: "A" },
    { key: "longPassage", label: "장문 독해", group: "A" },
    { key: "complex", label: "복합 문항", group: "A" },
    // Group B — 중학교 내신 (교과서 본문 기반, 9)
    { key: "textComprehension", label: "본문 내용 이해", group: "B" },
    { key: "detail", label: "세부 내용", group: "B" },
    { key: "englishDefinition", label: "영영풀이", group: "B" },
    { key: "vocabTransform", label: "어휘 변형", group: "B" },
    { key: "sentenceTransform", label: "문장 변형", group: "B" },
    { key: "shortAnswer", label: "서술형", group: "B" },
    { key: "textBlank", label: "본문 빈칸", group: "B" },
    { key: "textGrammar", label: "본문 어법", group: "B" },
    { key: "textOrder", label: "본문 순서", group: "B" },
    // Group C — 고등학교 내신 추가 (4; A/B와 겹치는 유형은 제외)
    { key: "textVariation", label: "본문 변형", group: "C" },
    { key: "grammarInContext", label: "어법", group: "C" },
    { key: "hardInference", label: "고난도 추론", group: "C" },
    { key: "summary", label: "요약", group: "C" },
  ];

  // §12.5/§12.10 — merged from the spec's two near-duplicate "skill"/"targetSkill" lists into one.
  const TARGET_SKILLS = [
    { key: "MAIN_IDEA", label: "주제 파악" },
    { key: "DETAIL_RETRIEVAL", label: "세부사항 확인" },
    { key: "INFERENCE", label: "추론" },
    { key: "VOCABULARY_IN_CONTEXT", label: "문맥상 어휘" },
    { key: "LOGIC", label: "논리 구조" },
    { key: "STRUCTURE", label: "글의 구조" },
  ];

  // §12.4 — wordCount/estimatedReadingTime are derived, never hand-entered (same principle as
  // answerFormat being derived from choices.length, §11.2). WPM figures are rough L2-reading-speed
  // heuristics, not calibrated data — good enough for a teacher-facing estimate, not a claim of
  // precision.
  const WPM_BY_GRADE = { "중1": 80, "중2": 90, "중3": 100, "고1": 110, "고2": 120, "고3": 130 };
  const DEFAULT_WPM = 100;
  function countWords(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length;
  }
  function estimateReadingTimeMin(wordCount, grade) {
    if (!wordCount) return 0;
    const wpm = WPM_BY_GRADE[grade] || DEFAULT_WPM;
    return Math.max(1, Math.round(wordCount / wpm));
  }
  function derivePassageFields(merged) {
    const wordCount = countWords(merged.passageText);
    return { wordCount, estimatedReadingTime: estimateReadingTimeMin(wordCount, merged.grade) };
  }

  const PASSAGE_CONTENT_FIELDS = ["title", "passageText", "grade", "difficulty", "passageType", "examType"];

  // input: { title, passageText, grade, difficulty, passageType, examType, topic, keywords, tags, source }
  async function createPassage(input) {
    const now = Date.now();
    const passageText = input.passageText || "";
    const wordCount = countWords(passageText);
    const doc = {
      title: input.title || "",
      passageText,
      grade: input.grade || "",
      difficulty: input.difficulty || "BASIC",
      passageType: input.passageType || "",
      examType: input.examType || "",
      topic: input.topic || "",
      keywords: Array.isArray(input.keywords) ? input.keywords : [],
      wordCount,
      estimatedReadingTime: estimateReadingTimeMin(wordCount, input.grade),
      source: { type: (input.source && input.source.type) || "TEACHER_CREATED", note: (input.source && input.source.note) || "" },
      tags: Array.isArray(input.tags) ? input.tags : [],
      status: "DRAFT",
      review: blankReview("reading"),
      fingerprint: computeFingerprint(passageText),
      usageCount: 0,
      version: 1,
      supersedesId: null,
      replacedBy: null,
      createdAt: now,
      updatedAt: now,
      createdBy: "teacher",
    };
    const id = await addDocTo(READING_PASSAGE_COLLECTION, doc);
    return { id, ...doc };
  }

  // §12.8 — a fork here deliberately does NOT cascade to the passage's existing questions; they
  // keep pointing at the archived original so past exam results stay meaningful. See ARCHITECTURE.md
  // §12.8 for why auto-copying questions to the new version is an explicit future action, not this.
  async function updatePassage(existingDoc, patch) {
    return forkOrUpdate(READING_PASSAGE_COLLECTION, existingDoc, patch, PASSAGE_CONTENT_FIELDS, { reviewSchema: "reading" }, "passageText", derivePassageFields);
  }

  // §12.8 — a passage with any linked question (regardless of that question's own status) can never
  // be hard-deleted, so a delete can't orphan a question's passageId reference.
  function canDeletePassage(doc, allReadingQuestions) {
    if (!canHardDelete(doc)) return false;
    return !(allReadingQuestions || []).some((q) => q.passageId === doc.id);
  }
  async function hardDeletePassage(doc, allReadingQuestions) {
    if (!canDeletePassage(doc, allReadingQuestions)) {
      throw new Error("초안(DRAFT) 상태이고 사용된 적 없으며 연결된 문제가 없는 지문만 완전히 삭제할 수 있어요.");
    }
    await deleteDocAt(READING_PASSAGE_COLLECTION, doc.id);
  }

  window.SarahServices.questionBankService = {
    GRADES, DIFFICULTIES, GRAMMAR_TAXONOMY, QUESTION_TYPES, SOURCE_TYPES, STATUS_FLOW,
    canTransition, computeFingerprint, findDuplicates,
    listQuestions, createQuestion, updateQuestion, setStatus, canHardDelete, hardDeleteQuestion,
    queryQuestions, pickQuestionsForExam, incrementUsageCount,
    GRAMMAR_COLLECTION,
    listGrammarQuestions: () => listQuestions(GRAMMAR_COLLECTION),
    createGrammarQuestion: (input) => createQuestion(GRAMMAR_COLLECTION, input),
    updateGrammarQuestion: (doc, patch) => updateQuestion(GRAMMAR_COLLECTION, doc, patch),
    setGrammarQuestionStatus: (doc, nextStatus, reviewPatch) => setStatus(GRAMMAR_COLLECTION, doc, nextStatus, reviewPatch),
    hardDeleteGrammarQuestion: (doc) => hardDeleteQuestion(GRAMMAR_COLLECTION, doc),

    // Reading Question Bank (Phase 6)
    READING_PASSAGE_COLLECTION, READING_QUESTION_COLLECTION,
    READING_EXAM_TYPES, PASSAGE_TYPES, READING_QUESTION_TYPES, TARGET_SKILLS,
    listReadingPassages: () => listQuestions(READING_PASSAGE_COLLECTION),
    createReadingPassage: (input) => createPassage(input),
    updateReadingPassage: (doc, patch) => updatePassage(doc, patch),
    setReadingPassageStatus: (doc, nextStatus, reviewPatch) => setStatus(READING_PASSAGE_COLLECTION, doc, nextStatus, reviewPatch),
    canDeleteReadingPassage: canDeletePassage,
    hardDeleteReadingPassage: (doc, allReadingQuestions) => hardDeletePassage(doc, allReadingQuestions),
    listReadingQuestions: () => listQuestions(READING_QUESTION_COLLECTION),
    createReadingQuestion: (input, passageId) => createQuestion(READING_QUESTION_COLLECTION, input, {
      extraFields: { passageId, examType: input.examType || "", targetSkill: input.targetSkill || "", evidenceLocation: input.evidenceLocation || "" },
      reviewSchema: "reading",
    }),
    updateReadingQuestion: (doc, patch) => updateQuestion(READING_QUESTION_COLLECTION, doc, patch, {
      extraContentFields: ["passageId", "examType"],
      reviewSchema: "reading",
    }),
    setReadingQuestionStatus: (doc, nextStatus, reviewPatch) => setStatus(READING_QUESTION_COLLECTION, doc, nextStatus, reviewPatch),
    hardDeleteReadingQuestion: (doc) => hardDeleteQuestion(READING_QUESTION_COLLECTION, doc),
  };
})();
