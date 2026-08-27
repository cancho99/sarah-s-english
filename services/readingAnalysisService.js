// Reading Analysis (Teacher OS reconstruction, Phase C — 2026-08-26 설계 승인).
//
// NOT to be confused with services/readingService.js — that file is the read-only aggregator over
// the STUDENT-facing reading-library.html collections (readingLibrary/readingVocab/readingJournal/
// readingActivity). This file owns a completely separate, TEACHER-facing collection
// (readingAnalyses) that reading-library.html and readingService.js never touch and never will.
//
// Also separate from the legacy Reading Question Bank (readingPassages/readingQuestions,
// services/questionBankService.js §Reading Question Bank) — that pair is frozen/legacy per the
// 2026-08-26 design approval (existing data preserved, no new writes from this new workflow).
// readingAnalyses is the new "Passage → Analysis → Question/Variation" source of truth. Questions
// generated from an analysis are NOT stored here — they go through
// questionBankService's readingAnalysisQuestions bound API (separate collection, same reasoning
// as why readingQuestions isn't embedded inside readingPassages: 1MB doc cap + independent
// versioning granularity, see ARCHITECTURE.md §12.2).
//
// No AI calls in this file (CLAUDE.md "API cost policy") — AI happens in questionGenerationService
// (question generation) and directly from the Reading Analysis UI components (passage analysis /
// passage variation, both explicit-button-only calls to the aiWorker Cloud Function). This file is
// pure Firestore CRUD + one pure formatting helper.
window.SarahServices = window.SarahServices || {};

(function () {
  const { getAllDocs, addDocTo, setDocAt, deleteDocAt } = window.SarahServices.firebaseClient;

  const READING_ANALYSIS_COLLECTION = "readingAnalyses";

  async function listAnalyses() {
    const docs = await getAllDocs(READING_ANALYSIS_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ id, ...data }));
  }

  // input: { title, originalText, passageId?, grade, difficulty, publisher?, examType?, analysis }
  // passageId is an OPTIONAL pointer into the legacy readingPassages collection, kept only for
  // teacher traceability ("이 지문은 원래 그 legacy passage에서 왔다") — never dereferenced by any
  // required code path, so a stale/missing legacy passage never breaks this doc.
  // publisher/examType (2026-08-27, teacher list-organization request) are free-form/optional —
  // existing docs saved before this change simply have both as "" and render as "미분류" in the
  // UI, no migration needed.
  async function createAnalysis(input) {
    const now = Date.now();
    const doc = {
      title: input.title || "",
      originalText: input.originalText || "",
      passageId: input.passageId || null,
      grade: input.grade || "",
      difficulty: input.difficulty || "BASIC",
      publisher: input.publisher || "",
      examType: input.examType || "",
      // AI 응답 원형 — "분석노트" 재설계(Phase B-1 설계 승인, 2026-08-26) 스키마:
      // { title, passageLevel: {topicKo, topicEn, summary, flow[], levelGrammarPoints[]},
      //   paragraphs[], sentences: [{index, originalText, chunks[], clauses[], translation,
      //   grammarAnnotations[], vocabAnnotations[], testablePoints[]}], vocabulary[], examPoints[] }.
      // 저장 전 무결성 검증(원문↔chunk 일치, chunk 순서, clause 범위, levelGrammarPoints의
      // sentenceIndices 존재 여부)은 functions/index.js의 validateReadingAnalysis()가 서버
      // 측(Cloud Function)에서 이미 마쳤다는 전제 — 이 함수는 검증된 결과를 그대로 저장만 한다.
      analysis: input.analysis || null,
      variations: [],
      createdAt: now,
      updatedAt: now,
      createdBy: "teacher",
    };
    const id = await addDocTo(READING_ANALYSIS_COLLECTION, doc);
    return { id, ...doc };
  }

  // No fork/versioning pipeline here (deliberately, see Phase B design report §1-A) — Analysis is
  // reference material a teacher freely edits/regenerates, not a graded question whose past usage
  // must stay reproducible. Simple merge write.
  async function updateAnalysis(existingDoc, patch) {
    const now = Date.now();
    const patchOut = { ...patch, updatedAt: now };
    await setDocAt(READING_ANALYSIS_COLLECTION, existingDoc.id, patchOut, { merge: true });
    return { ...existingDoc, ...patchOut };
  }

  // Passage Variation results append here rather than overwrite — a teacher may generate several
  // difficulty variants of the same passage over time (§1-A: variations[] on the analysis doc).
  async function saveVariation(existingDoc, variation) {
    const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), createdAt: Date.now(), verified: false, ...variation };
    const variations = [...(existingDoc.variations || []), entry];
    return updateAnalysis(existingDoc, { variations });
  }

  // A passage/analysis with any linked readingAnalysisQuestions can't be hard-deleted, mirroring
  // canDeletePassage's guard in questionBankService (never orphan a question's analysisId).
  function canDeleteAnalysis(doc, allReadingAnalysisQuestions) {
    return !(allReadingAnalysisQuestions || []).some((q) => q.analysisId === doc.id);
  }
  async function hardDeleteAnalysis(doc, allReadingAnalysisQuestions) {
    if (!canDeleteAnalysis(doc, allReadingAnalysisQuestions)) {
      throw new Error("연결된 문제가 있는 지문 분석은 삭제할 수 없어요. 먼저 문제를 정리해 주세요.");
    }
    await deleteDocAt(READING_ANALYSIS_COLLECTION, doc.id);
  }

  // Pure helper — lets any screen that already builds a `passagesById` map from the legacy
  // readingPassages collection (Exam Builder print/preview/attempt runtime) merge readingAnalyses
  // docs into the SAME map without those call sites knowing or caring which collection a given id
  // came from (Phase B design §5/§6: this is what lets School Exam reuse ~15 existing
  // `passagesById[section.passageId]` render sites completely unmodified). Firestore auto-ids from
  // two different collections colliding is not a realistic risk (20-char random base62 ids).
  function toPassagesById(analyses) {
    const out = {};
    (analyses || []).forEach((a) => { out[a.id] = a; });
    return out;
  }

  window.SarahServices.readingAnalysisService = {
    READING_ANALYSIS_COLLECTION,
    listAnalyses,
    createAnalysis,
    updateAnalysis,
    saveVariation,
    canDeleteAnalysis,
    hardDeleteAnalysis,
    toPassagesById,
  };
})();
