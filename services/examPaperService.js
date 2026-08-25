// Phase 7 — Exam Builder (ARCHITECTURE.md §13). Composes exam papers FROM the Grammar/Reading
// Question Banks (services/questionBankService.js) — it never duplicates question/passage content,
// only references (questionId/passageId). No AI API calls anywhere in this file (CLAUDE.md "API
// cost policy") — selection, filtering, shuffling and preview are all Firestore reads + plain JS.
//
// Does not touch the existing exam systems (examTests/mockExams/regularExams/examKeyLibrary,
// all inside sarahsEnglishStudents or sarahsEnglishMeta) — `examPapers` is a new, separate,
// additive collection. See ARCHITECTURE.md §13.1 for why these are not merged.
window.SarahServices = window.SarahServices || {};

(function () {
  const { getAllDocs, addDocTo, setDocAt, deleteDocAt } = window.SarahServices.firebaseClient;
  const QB = window.SarahServices.questionBankService;

  const EXAM_PAPER_COLLECTION = "examPapers";

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function totalQuestionCount(sections) {
    return (sections || []).reduce((sum, s) => sum + (s.questionRefs || []).length, 0);
  }

  async function listExamPapers() {
    const docs = await getAllDocs(EXAM_PAPER_COLLECTION);
    return Object.entries(docs).map(([id, data]) => ({ id, ...data }));
  }

  // input: { title, grade?, examType?, sections? } — sections default to [] (teacher builds up the
  // paper incrementally via addSection-style calls below, all of which just patch `sections`).
  async function createExamPaper(input) {
    const now = Date.now();
    const sections = input.sections || [];
    const doc = {
      title: input.title || "",
      grade: input.grade || "",
      examType: input.examType || "", // optional representative label only — §13.4, never enforced on sections/questions
      status: "DRAFT",
      sections,
      totalQuestionCount: totalQuestionCount(sections),
      createdAt: now,
      updatedAt: now,
      createdBy: "teacher",
      finalizedAt: null,
    };
    const id = await addDocTo(EXAM_PAPER_COLLECTION, doc);
    return { id, ...doc };
  }

  // Only DRAFT papers can be edited — once FINALIZED, order/choiceDisplayOrder are locked and the
  // only allowed transition is → ARCHIVED (§13.8, no "un-finalize" path, symmetric with Question
  // Bank's PUBLISHED-is-a-one-way-door design).
  async function updateExamPaper(existingDoc, patch) {
    if (existingDoc.status !== "DRAFT") {
      throw new Error("확정(FINALIZED)되었거나 보관된 시험지는 수정할 수 없어요. 보관 후 새 시험지를 만들어 주세요.");
    }
    const now = Date.now();
    const patchOut = { ...patch, updatedAt: now };
    if (patch.sections !== undefined) patchOut.totalQuestionCount = totalQuestionCount(patch.sections);
    await setDocAt(EXAM_PAPER_COLLECTION, existingDoc.id, patchOut, { merge: true });
    return { ...existingDoc, ...patchOut };
  }

  // ---------------------------------------------------------------------------------------------
  // Section builders — pure functions, no Firestore writes. UI calls these to build up the `sections`
  // array it then saves via updateExamPaper. Kept separate from create/update so "assembling a
  // paper" and "persisting it" are independent steps the UI can call as often as it wants while a
  // teacher is drafting.
  // ---------------------------------------------------------------------------------------------

  function blankSection(bank, label, passageId) {
    return { id: uid(), label, bank, passageId: passageId || null, shuffleQuestions: false, shuffleChoices: false, questionRefs: [] };
  }

  function questionRefsFrom(questionIds) {
    return questionIds.map((questionId, i) => ({ questionId, order: i, choiceDisplayOrder: null }));
  }

  // §13.5 자동 선택 — grammar: pickQuestionsForExam 결과를 그대로 한 섹션에 채운다 (지문 개념이 없음).
  function autoSelectGrammarSection(label, grammarQuestions, filters, count) {
    const picked = QB.pickQuestionsForExam(grammarQuestions, filters, count);
    const section = blankSection("grammar", label);
    section.questionRefs = questionRefsFrom(picked.map((q) => q.id));
    return { section, pickedCount: picked.length };
  }

  // §13.5 자동 선택 — reading: pickQuestionsForExam은 "문제"를 반환하므로, 같은 passageId끼리 묶어
  // 지문 1개당 섹션 1개씩 만든다 (그래야 렌더링 시 지문+문제가 항상 함께 붙어 있다, §12.2).
  // `readingPassagesById`가 주어지면 지문 제목으로 섹션 라벨을 자동 생성한다(선택 사항).
  function autoSelectReadingSections(labelPrefix, readingQuestions, filters, count, readingPassagesById) {
    const picked = QB.pickQuestionsForExam(readingQuestions, filters, count);
    const byPassage = {};
    picked.forEach((q) => { (byPassage[q.passageId] = byPassage[q.passageId] || []).push(q); });
    const sections = Object.entries(byPassage).map(([passageId, qs]) => {
      const passageTitle = readingPassagesById && readingPassagesById[passageId] ? readingPassagesById[passageId].title : passageId;
      const section = blankSection("reading", `${labelPrefix} — ${passageTitle}`, passageId);
      section.questionRefs = questionRefsFrom(qs.map((q) => q.id));
      return section;
    });
    return { sections, pickedCount: picked.length };
  }

  // §13.5 수동 선택 — 교사가 목록에서 고른 questionId 배열을 섹션 하나로 만든다. PUBLISHED 여부는
  // 호출부(UI)가 목록을 이미 PUBLISHED로 필터링해서 넘긴다는 전제 — 여기서도 한 번 더 걸러
  // DRAFT/미검수 문제가 섞여 들어오는 것을 막는다(이중 가드).
  function manualSection(bank, label, questionDocs, passageId) {
    const publishedOnly = questionDocs.filter((q) => q.status === "PUBLISHED");
    const section = blankSection(bank, label, passageId || null);
    section.questionRefs = questionRefsFrom(publishedOnly.map((q) => q.id));
    return { section, skippedCount: questionDocs.length - publishedOnly.length };
  }

  // Phase 8 prep — duplicate an existing paper (any status, incl. FINALIZED) as a fresh editable
  // DRAFT. Deep-copies `sections` (so the copy's questionRefs are independent arrays the teacher can
  // reorder without mutating the original) but keeps every questionId reference as-is — no question
  // content is touched or copied, and no usageCount bump here (that only ever happens in
  // finalizeExamPaper, unchanged below). If the source was FINALIZED, its locked order/
  // choiceDisplayOrder carries over as a starting point but the copy is DRAFT so it's fully editable.
  async function duplicateExamPaper(existingDoc) {
    const now = Date.now();
    const sections = (existingDoc.sections || []).map((s) => ({
      ...s,
      questionRefs: (s.questionRefs || []).map((r) => ({ ...r })),
    }));
    const doc = {
      title: "[복사본] " + (existingDoc.title || ""),
      grade: existingDoc.grade || "",
      examType: existingDoc.examType || "",
      status: "DRAFT",
      sections,
      totalQuestionCount: totalQuestionCount(sections),
      createdAt: now,
      updatedAt: now,
      createdBy: "teacher",
      finalizedAt: null,
    };
    const id = await addDocTo(EXAM_PAPER_COLLECTION, doc);
    return { id, ...doc };
  }

  // ---------------------------------------------------------------------------------------------
  // Finalize — §13.8. The one-time, one-way transition: locks order/choice-display-order into the
  // document and bumps usageCount on every referenced question (which is what makes the Question
  // Bank's copy-on-write versioning protect this exam paper's reproducibility forever, §13.4/§13.6).
  // ---------------------------------------------------------------------------------------------

  function shuffledCopy(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // questionsById: { [questionId]: questionDoc } — caller assembles this from
  // QB.listGrammarQuestions()/listReadingQuestions() (already loaded in the UI, no extra reads here).
  function computeFinalizedSections(sections, questionsById) {
    return sections.map((section) => {
      const baseRefs = section.questionRefs || [];
      const orderedRefs = section.shuffleQuestions ? shuffledCopy(baseRefs) : baseRefs;
      const finalRefs = orderedRefs.map((ref, i) => {
        const qDoc = questionsById[ref.questionId];
        let choiceDisplayOrder = null;
        if (section.shuffleChoices && qDoc && qDoc.answerFormat === "mc" && Array.isArray(qDoc.choices) && qDoc.choices.length > 0) {
          choiceDisplayOrder = shuffledCopy(qDoc.choices.map((_, idx) => idx));
        }
        return { questionId: ref.questionId, order: i, choiceDisplayOrder };
      });
      return { ...section, questionRefs: finalRefs };
    });
  }

  // questionsById must cover every questionId referenced across all sections (grammar + reading
  // mixed, §13.4/§13.12-2) — caller is responsible for merging both banks' lists into one map.
  async function finalizeExamPaper(existingDoc, questionsById) {
    if (existingDoc.status !== "DRAFT") {
      throw new Error("초안(DRAFT) 상태의 시험지만 확정할 수 있어요.");
    }
    if (totalQuestionCount(existingDoc.sections) === 0) {
      throw new Error("문제가 하나도 없는 시험지는 확정할 수 없어요.");
    }
    const finalizedSections = computeFinalizedSections(existingDoc.sections, questionsById);
    const now = Date.now();

    // Bump usageCount on every referenced question — dedup by (bank, questionId) since the same
    // question could in principle appear in more than one section of the same paper.
    const seen = new Set();
    for (const section of finalizedSections) {
      const collectionName = section.bank === "reading" ? QB.READING_QUESTION_COLLECTION : QB.GRAMMAR_COLLECTION;
      for (const ref of section.questionRefs) {
        const key = collectionName + ":" + ref.questionId;
        if (seen.has(key)) continue;
        seen.add(key);
        const qDoc = questionsById[ref.questionId];
        if (qDoc) await QB.incrementUsageCount(collectionName, qDoc);
      }
    }

    const patch = {
      sections: finalizedSections,
      status: "FINALIZED",
      finalizedAt: now,
      updatedAt: now,
      totalQuestionCount: totalQuestionCount(finalizedSections),
    };
    await setDocAt(EXAM_PAPER_COLLECTION, existingDoc.id, patch, { merge: true });
    return { ...existingDoc, ...patch };
  }

  // §13.8 — DRAFT → ARCHIVED (abandon a draft) or FINALIZED → ARCHIVED (retire a used paper). No
  // path back out of ARCHIVED; no path back from FINALIZED to DRAFT (would require un-bumping
  // usageCount, which is unsafe if the same question is also used elsewhere — see §13.8).
  function canArchiveExamPaper(doc) {
    return doc.status === "DRAFT" || doc.status === "FINALIZED";
  }
  async function archiveExamPaper(existingDoc) {
    if (!canArchiveExamPaper(existingDoc)) throw new Error("이미 보관된 시험지예요.");
    const now = Date.now();
    await setDocAt(EXAM_PAPER_COLLECTION, existingDoc.id, { status: "ARCHIVED", updatedAt: now }, { merge: true });
    return { ...existingDoc, status: "ARCHIVED", updatedAt: now };
  }

  // Only ever-untouched DRAFTs can be hard-deleted — a FINALIZED paper is the reproducibility record
  // itself (§추가요구사항6) and must never be removable, even indirectly.
  function canHardDeleteExamPaper(doc) {
    return doc.status === "DRAFT";
  }
  async function hardDeleteExamPaper(doc) {
    if (!canHardDeleteExamPaper(doc)) throw new Error("초안(DRAFT) 상태의 시험지만 완전히 삭제할 수 있어요. 그 외에는 보관(Archive) 처리해 주세요.");
    await deleteDocAt(EXAM_PAPER_COLLECTION, doc.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Render helper — §13.6. Pure function, never writes to the original question doc. Works whether
  // choiceDisplayOrder is set (FINALIZED paper) or null (still-DRAFT preview / non-mc question).
  // ---------------------------------------------------------------------------------------------
  function resolveQuestionForDisplay(questionDoc, choiceDisplayOrder) {
    if (!choiceDisplayOrder || questionDoc.answerFormat !== "mc" || !Array.isArray(questionDoc.choices)) {
      return { displayChoices: questionDoc.choices || [], displayAnswerIndex: Number(questionDoc.answer) };
    }
    const displayChoices = choiceDisplayOrder.map((i) => questionDoc.choices[i]);
    const displayAnswerIndex = choiceDisplayOrder.indexOf(Number(questionDoc.answer));
    return { displayChoices, displayAnswerIndex };
  }

  window.SarahServices.examPaperService = {
    EXAM_PAPER_COLLECTION,
    listExamPapers, createExamPaper, updateExamPaper, duplicateExamPaper,
    blankSection, autoSelectGrammarSection, autoSelectReadingSections, manualSection,
    finalizeExamPaper, computeFinalizedSections,
    canArchiveExamPaper, archiveExamPaper,
    canHardDeleteExamPaper, hardDeleteExamPaper,
    resolveQuestionForDisplay,
    totalQuestionCount,
  };
})();
