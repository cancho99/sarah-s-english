// Exam Studio (2026-09 — "리딩 애널리시스" 완전 대체) — Firestore-backed persistence for the
// exam-studio-prototype.html UI that got merged into index.html as the new Reading Analysis
// replacement. This file exists so that prototype's localStorage calls have a drop-in async
// equivalent with the SAME shapes (every item still carries a `localId` the UI already keys off
// of — here it's just the real Firestore doc id instead of a locally-generated uid()).
//
// Deliberately brand-new collections, NOT services/readingAnalysisService.js's `readingAnalyses` or
// questionBankService's `readingAnalysisQuestions` — those two are read by other existing screens
// (School Exam Builder, the Question Bank review queue) and reusing them here would either corrupt
// those screens' expectations or force a schema renegotiation neither screen asked for. Exam Studio
// is intentionally a fully independent island: its own 4 collections, nothing else in the app reads
// or writes them (and per teacher's explicit call, it's fine if this leaves School Exam Builder's
// old integration with the legacy 3-tab Reading Analysis dangling).
//
// Data model (mirrors the prototype's in-memory shapes 1:1):
//   examStudioFolders/taxonomy   — ONE doc: { [grade]: string[] (publisher folder names) }.
//                                   A tiny doc (just folder name strings), so no size-cap risk ever.
//   examStudioPassages           — one doc per "지문 보관함" passage: {grade,publisher,examType,
//                                   title,text,createdAt}.
//   examStudioQuestions          — one doc per generated/saved item (both single `kind:"single"` and
//                                   장문·복합 `kind:"group"` entries). `stage` is "review" (생성
//                                   결과, not yet saved) or "saved" (저장함) — this single field is
//                                   what used to be "which of the two localStorage arrays this is
//                                   in". One doc per question (not one big array-in-a-doc) on
//                                   purpose — same reasoning as every other per-item collection in
//                                   this app (readingAnalysisQuestions, homework, etc.): avoids ever
//                                   hitting Firestore's 1MB single-document cap as content grows.
//   examStudioExamPapers         — one doc per built 시험지: {title,grade,publisher,examType,
//                                   entries:[...],createdAt,updatedAt}. entries is the paper's own
//                                   independent snapshot copy (cloneEntryForPaper in index.html),
//                                   bounded by how many questions one exam paper holds — safe as a
//                                   single array field.
//   examStudioAnalyses           — one doc per saved 지문 분석(구문분석/직독직해/요약/글의 흐름/
//                                   어휘): {grade,publisher,examType,passageText,analysis,
//                                   createdAt}. Added 2026-09-17 — 원래 "지문 분석"은
//                                   ExamStudioSection의 로컬 React state(`analysis`)에만 있어서
//                                   새로고침/페이지 이동하면 그냥 사라졌다(저장 버튼 자체가
//                                   없었음). `analysis`는 EsAnalysisSection이 그리는 것과 완전히
//                                   같은 모양{summary,flow,sentences,vocab}을 그대로 저장한다 —
//                                   AI를 다시 부르지 않고도 나중에 그대로 재현해서 보여줄 수 있게.
window.SarahServices = window.SarahServices || {};

(function () {
  const FS = window.SarahServices.firebaseClient;

  const FOLDERS_COLLECTION = "examStudioFolders";
  const FOLDERS_DOC_ID = "taxonomy";
  const PASSAGES_COLLECTION = "examStudioPassages";
  const QUESTIONS_COLLECTION = "examStudioQuestions";
  const EXAM_PAPERS_COLLECTION = "examStudioExamPapers";
  const ANALYSES_COLLECTION = "examStudioAnalyses";

  const LIBRARY_GRADES = ["중1", "중2", "중3", "고1", "고2", "고3"];

  function emptyFolders() {
    const out = {};
    LIBRARY_GRADES.forEach((g) => { out[g] = []; });
    return out;
  }

  // ---- 폴더 taxonomy (학년 → 출판사[]) ----
  async function loadFolders() {
    const doc = await FS.getDoc(FOLDERS_COLLECTION, FOLDERS_DOC_ID);
    const fallback = emptyFolders();
    if (!doc || typeof doc !== "object") return fallback;
    const out = {};
    LIBRARY_GRADES.forEach((g) => { out[g] = Array.isArray(doc[g]) ? doc[g] : []; });
    return out;
  }
  async function addFolder(current, grade, name) {
    const trimmed = (name || "").trim();
    if (!trimmed || !grade) return current;
    const existing = current[grade] || [];
    if (existing.includes(trimmed)) return current;
    const next = { ...current, [grade]: [...existing, trimmed] };
    await FS.setDocAt(FOLDERS_COLLECTION, FOLDERS_DOC_ID, next, { merge: true });
    return next;
  }
  async function deleteFolder(current, grade, publisher) {
    const next = { ...current, [grade]: (current[grade] || []).filter((p) => p !== publisher) };
    await FS.setDocAt(FOLDERS_COLLECTION, FOLDERS_DOC_ID, next, { merge: true });
    return next;
  }
  async function renameFolder(current, grade, oldName, newName) {
    const trimmed = (newName || "").trim();
    if (!trimmed || !grade || trimmed === oldName) return current;
    const existing = current[grade] || [];
    if (existing.includes(trimmed)) return current;
    const next = { ...current, [grade]: existing.map((p) => (p === oldName ? trimmed : p)) };
    await FS.setDocAt(FOLDERS_COLLECTION, FOLDERS_DOC_ID, next, { merge: true });
    return next;
  }

  // ---- 지문 보관함 ----
  async function listPassages() {
    const docs = await FS.getAllDocs(PASSAGES_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ localId: id, id, ...data }));
  }
  async function createPassage(entry) {
    const doc = {
      grade: entry.grade || "", publisher: entry.publisher || "", examType: entry.examType || "",
      title: entry.title || "", text: entry.text || "",
      createdAt: new Date().toISOString(),
    };
    const id = await FS.addDocTo(PASSAGES_COLLECTION, doc);
    return { localId: id, id, ...doc };
  }
  async function updatePassage(id, patch) {
    await FS.setDocAt(PASSAGES_COLLECTION, id, patch, { merge: true });
  }
  async function deletePassage(id) {
    await FS.deleteDocAt(PASSAGES_COLLECTION, id);
  }

  // ---- 생성 결과(review) / 저장함(saved) — 둘 다 같은 컬렉션, stage 필드로만 구분 ----
  async function listQuestions() {
    const docs = await FS.getAllDocs(QUESTIONS_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ localId: id, id, ...data }));
  }
  // entries: array of already-normalized item/group objects (normalizeGeneratedRaw output) each
  // already carrying its own localId(temp)/grade/publisher/examType tag — that temp localId is
  // discarded here in favor of the real Firestore id.
  async function createQuestions(entries, tag) {
    const now = new Date().toISOString();
    const saved = [];
    for (const entry of entries) {
      const { localId, ...rest } = entry;
      const doc = { ...rest, ...tag, stage: "review", createdAt: now };
      const id = await FS.addDocTo(QUESTIONS_COLLECTION, doc);
      saved.push({ localId: id, id, ...doc });
    }
    return saved;
  }
  async function updateQuestion(id, patch) {
    await FS.setDocAt(QUESTIONS_COLLECTION, id, { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  }
  async function deleteQuestion(id) {
    await FS.deleteDocAt(QUESTIONS_COLLECTION, id);
  }
  async function setQuestionsStage(ids, stage) {
    await Promise.all(ids.map((id) => FS.setDocAt(QUESTIONS_COLLECTION, id, { stage, updatedAt: new Date().toISOString() }, { merge: true })));
  }
  async function setQuestionsReviewed(ids, reviewed) {
    await Promise.all(ids.map((id) => FS.setDocAt(QUESTIONS_COLLECTION, id, { reviewed, updatedAt: new Date().toISOString() }, { merge: true })));
  }
  async function deleteQuestions(ids) {
    await Promise.all(ids.map((id) => FS.deleteDocAt(QUESTIONS_COLLECTION, id)));
  }

  // ---- 시험지 생성 ----
  async function listExamPapers() {
    const docs = await FS.getAllDocs(EXAM_PAPERS_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ localId: id, id, ...data }));
  }
  async function createExamPaper(tag, entries) {
    const now = new Date().toISOString();
    const doc = {
      title: "제목 없는 시험지", subtitle: "", layout: "1col",
      grade: tag.grade || "", publisher: tag.publisher || "", examType: tag.examType || "",
      entries: entries || [], createdAt: now, updatedAt: now,
    };
    const id = await FS.addDocTo(EXAM_PAPERS_COLLECTION, doc);
    return { localId: id, id, ...doc };
  }
  async function updateExamPaper(id, patch) {
    await FS.setDocAt(EXAM_PAPERS_COLLECTION, id, { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  }
  async function deleteExamPaper(id) {
    await FS.deleteDocAt(EXAM_PAPERS_COLLECTION, id);
  }

  // ---- 지문 분석함 ----
  async function listAnalyses() {
    const docs = await FS.getAllDocs(ANALYSES_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ localId: id, id, ...data }));
  }
  async function createAnalysis(entry) {
    const doc = {
      grade: entry.grade || "", publisher: entry.publisher || "", examType: entry.examType || "",
      passageText: entry.passageText || "", analysis: entry.analysis || null,
      createdAt: new Date().toISOString(),
    };
    const id = await FS.addDocTo(ANALYSES_COLLECTION, doc);
    return { localId: id, id, ...doc };
  }
  async function updateAnalysis(id, patch) {
    await FS.setDocAt(ANALYSES_COLLECTION, id, patch, { merge: true });
  }
  async function deleteAnalysis(id) {
    await FS.deleteDocAt(ANALYSES_COLLECTION, id);
  }

  window.SarahServices.examStudioService = {
    LIBRARY_GRADES,
    loadFolders, addFolder, deleteFolder, renameFolder,
    listPassages, createPassage, updatePassage, deletePassage,
    listQuestions, createQuestions, updateQuestion, deleteQuestion, setQuestionsStage, setQuestionsReviewed, deleteQuestions,
    listExamPapers, createExamPaper, updateExamPaper, deleteExamPaper,
    listAnalyses, createAnalysis, updateAnalysis, deleteAnalysis,
  };
})();
