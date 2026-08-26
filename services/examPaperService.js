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

  // input: { title, grade?, examType?, sections?, layout? } — sections default to [] (teacher builds
  // up the paper incrementally via addSection-style calls below, all of which just patch `sections`).
  // Exam Wizard (Phase B) — `layout` ("1col"|"2col") is an additive field, approved in the Phase A
  // report. A paper created before this field existed simply has no `layout` key; every reader
  // (print, detail view) treats a missing value as "1col" — see EXAM_PAPER_DEFAULT_LAYOUT below.
  // No migration touches old docs.
  async function createExamPaper(input) {
    const now = Date.now();
    const sections = input.sections || [];
    const isSchool = input.examCategory === "school";
    const doc = {
      title: input.title || "",
      grade: input.grade || "",
      examType: input.examType || "", // optional representative label only — §13.4, never enforced on sections/questions
      layout: input.layout === "2col" ? "2col" : "1col",
      // School Exam Builder (Reading Analysis 재설계 Phase C) — additive, optional. 기존 문서는
      // 이 두 필드가 아예 없고, 모든 기존 읽기 경로는 examCategory를 안 보거나 "general" 폴백을
      // 쓰므로 회귀 없음. schoolExamMeta는 별도 curriculum master collection 없이 교사가 그때그때
      // 입력한 자유 텍스트를 그대로 저장한다(2026-08-26 설계 승인 §5) — 최근 사용 목록은
      // getRecentSchoolExamValues()가 이 필드들을 훑어서 즉석 계산한다.
      examCategory: isSchool ? "school" : "general",
      schoolExamMeta: isSchool ? (input.schoolExamMeta || {}) : null,
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

  // readingSource ("analysis" | undefined) — Reading Analysis 재설계(Phase C). Omitted entirely for
  // every existing caller (기존 시험지는 필드 자체가 없음 = legacy readingQuestions 경로, 100%
  // 하위호환). "analysis"면 passageId는 readingPassages가 아니라 readingAnalyses 문서를 가리킨다
  // — 필드명을 그대로 재사용해서 인쇄/미리보기/응시 화면의 기존 passagesById[section.passageId]
  // 조회 코드 ~15곳을 전혀 손대지 않고도 그대로 동작하게 한다(호출부가 legacy+analysis 병합 맵을
  // 넘기기만 하면 됨, Phase B 설계 §5/§6).
  function blankSection(bank, label, passageId, readingSource) {
    const section = { id: uid(), label, bank, passageId: passageId || null, shuffleQuestions: false, shuffleChoices: false, questionRefs: [] };
    if (readingSource) section.readingSource = readingSource;
    return section;
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

  // ---------------------------------------------------------------------------------------------
  // Exam Wizard (Teacher OS Exam Builder Phase B) — "총 문항 수만 지정하면 여러 Topic/유형에 걸쳐
  // 자동으로 비례 배분하고, 부족분은 재배분한다" 오케스트레이션. autoSelectGrammarSection/
  // autoSelectReadingSections(위, 단일 필터·단일 count 전용, 기존 평면형 빌더가 계속 쓴다)와는
  // 별개 — 이 둘은 그대로 두고 이 아래는 전부 새로 추가된 함수다. 여전히 QB.queryQuestions/
  // QB.distributeCounts/QB.pickQuestionsWeighted 조합일 뿐, 새 Firestore 쓰기는 없다.
  // ---------------------------------------------------------------------------------------------

  // 최근 N개의 FINALIZED 시험지(현재 만들고 있는 초안 paperId는 제외)에 쓰인 questionId 집합.
  // "최근 사용 문제는 가능하면 피한다"는 순한 우선순위(하드 제외 아님, §3)의 입력값 — 이미
  // ExamBuilderView가 불러온 examPapers 목록에서 계산할 뿐, 추가 Firestore 읽기가 없다.
  function computeRecentlyUsedQuestionIds(examPapers, excludePaperId, limitPapers) {
    const finalized = (examPapers || [])
      .filter((p) => p.status === "FINALIZED" && p.id !== excludePaperId)
      .sort((a, b) => (b.finalizedAt || 0) - (a.finalizedAt || 0))
      .slice(0, limitPapers || 5);
    const ids = new Set();
    finalized.forEach((p) => (p.sections || []).forEach((s) => (s.questionRefs || []).forEach((r) => ids.add(r.questionId))));
    return ids;
  }

  // opts: { grade, difficulty, topics: [mainCategoryKey, ...] }. Returns one flat "grammar" section
  // (문법은 지문 개념이 없어 §13.5의 기존 단일-섹션 관례를 그대로 따른다) plus the per-topic
  // allocation breakdown the Wizard's Preview step (STEP4) shows. `excludeIds`는 이미 이 시험지의
  // 다른 섹션(예: Mixed의 Reading 쪽)에 들어간 questionId — 자동 배분 풀에서 처음부터 제외한다.
  function autoDistributeGrammarSection(label, grammarQuestions, opts, totalRequested, recentlyUsedIds, excludeIds) {
    const baseExclude = excludeIds || [];
    const topics = opts.topics || [];
    const pools = topics.map((key) => {
      const pool = QB.queryQuestions(grammarQuestions, { status: ["PUBLISHED"], grade: opts.grade, difficulty: opts.difficulty, mainCategory: key, excludeIds: baseExclude });
      const cat = QB.GRAMMAR_TAXONOMY.find((c) => c.key === key);
      return { key, label: cat ? cat.label : key, available: pool.length };
    });
    const dist = QB.distributeCounts(pools, totalRequested);
    const picked = [];
    dist.allocations.forEach((a) => {
      if (a.allocated <= 0) return;
      const pool = QB.queryQuestions(grammarQuestions, {
        status: ["PUBLISHED"], grade: opts.grade, difficulty: opts.difficulty, mainCategory: a.key,
        excludeIds: [...baseExclude, ...picked.map((q) => q.id)],
      });
      picked.push(...QB.pickQuestionsWeighted(pool, a.allocated, recentlyUsedIds));
    });
    const section = blankSection("grammar", label);
    section.questionRefs = questionRefsFrom(picked.map((q) => q.id));
    return { section, picked, allocations: dist.allocations, actualTotal: picked.length, shortfall: totalRequested - picked.length };
  }

  // opts: { grade, difficulty, examType, questionTypes: [...] }. Picks across multiple Reading
  // question types with the same proportional-distribution + shortage-redistribution logic, then
  // groups the result by passageId into one section per passage (§8 — "지문 단위 → 문제 묶음", same
  // grouping rule autoSelectReadingSections above already uses so a passage's questions always stay
  // together in one section).
  function autoDistributeReadingSections(labelPrefix, readingQuestions, opts, totalRequested, recentlyUsedIds, excludeIds, readingPassagesById) {
    const baseExclude = excludeIds || [];
    const types = opts.questionTypes || [];
    const pools = types.map((key) => {
      const pool = QB.queryQuestions(readingQuestions, { status: ["PUBLISHED"], grade: opts.grade, difficulty: opts.difficulty, examType: opts.examType, questionType: key, excludeIds: baseExclude });
      const t = QB.READING_QUESTION_TYPES.find((x) => x.key === key);
      return { key, label: t ? t.label : key, available: pool.length };
    });
    const dist = QB.distributeCounts(pools, totalRequested);
    const picked = [];
    dist.allocations.forEach((a) => {
      if (a.allocated <= 0) return;
      const pool = QB.queryQuestions(readingQuestions, {
        status: ["PUBLISHED"], grade: opts.grade, difficulty: opts.difficulty, examType: opts.examType, questionType: a.key,
        excludeIds: [...baseExclude, ...picked.map((q) => q.id)],
      });
      picked.push(...QB.pickQuestionsWeighted(pool, a.allocated, recentlyUsedIds));
    });
    const byPassage = {};
    picked.forEach((q) => { (byPassage[q.passageId] = byPassage[q.passageId] || []).push(q); });
    const sections = Object.entries(byPassage).map(([passageId, qs]) => {
      const passageTitle = readingPassagesById && readingPassagesById[passageId] ? readingPassagesById[passageId].title : passageId;
      const section = blankSection("reading", `${labelPrefix} — ${passageTitle}`, passageId);
      section.questionRefs = questionRefsFrom(qs.map((q) => q.id));
      return section;
    });
    return { sections, picked, allocations: dist.allocations, actualTotal: picked.length, shortfall: totalRequested - picked.length };
  }

  // Reading Analysis 재설계(Phase C, School Exam Builder 전용) — autoDistributeReadingSections와
  // 완전히 같은 패턴(비례배분+부족분 재배분+우선순위 픽), 대상만 레거시 readingQuestions가 아니라
  // 신규 readingAnalysisQuestions. section.passageId에는 analysisId를 그대로 담는다(위 blankSection
  // 주석 참고) — 그래야 이 섹션도 기존 "지문 단위로 문제 묶기" 렌더링 규칙을 그대로 탄다.
  function autoDistributeReadingAnalysisSections(labelPrefix, readingAnalysisQuestions, opts, totalRequested, recentlyUsedIds, excludeIds, readingAnalysesById) {
    const baseExclude = excludeIds || [];
    const types = opts.questionTypes || [];
    const pools = types.map((key) => {
      const pool = QB.queryQuestions(readingAnalysisQuestions, { status: ["PUBLISHED"], grade: opts.grade, difficulty: opts.difficulty, examType: opts.examType, questionType: key, excludeIds: baseExclude });
      const t = QB.READING_QUESTION_TYPES.find((x) => x.key === key);
      return { key, label: t ? t.label : key, available: pool.length };
    });
    const dist = QB.distributeCounts(pools, totalRequested);
    const picked = [];
    dist.allocations.forEach((a) => {
      if (a.allocated <= 0) return;
      const pool = QB.queryQuestions(readingAnalysisQuestions, {
        status: ["PUBLISHED"], grade: opts.grade, difficulty: opts.difficulty, examType: opts.examType, questionType: a.key,
        excludeIds: [...baseExclude, ...picked.map((q) => q.id)],
      });
      picked.push(...QB.pickQuestionsWeighted(pool, a.allocated, recentlyUsedIds));
    });
    const byAnalysis = {};
    picked.forEach((q) => { (byAnalysis[q.analysisId] = byAnalysis[q.analysisId] || []).push(q); });
    const sections = Object.entries(byAnalysis).map(([analysisId, qs]) => {
      const title = readingAnalysesById && readingAnalysesById[analysisId] ? readingAnalysesById[analysisId].title : analysisId;
      const section = blankSection("reading", `${labelPrefix} — ${title}`, analysisId, "analysis");
      section.questionRefs = questionRefsFrom(qs.map((q) => q.id));
      return section;
    });
    return { sections, picked, allocations: dist.allocations, actualTotal: picked.length, shortfall: totalRequested - picked.length };
  }

  // §13.5 수동 선택 — 교사가 목록에서 고른 questionId 배열을 섹션 하나로 만든다. PUBLISHED 여부는
  // 호출부(UI)가 목록을 이미 PUBLISHED로 필터링해서 넘긴다는 전제 — 여기서도 한 번 더 걸러
  // DRAFT/미검수 문제가 섞여 들어오는 것을 막는다(이중 가드).
  function manualSection(bank, label, questionDocs, passageId, readingSource) {
    const publishedOnly = questionDocs.filter((q) => q.status === "PUBLISHED");
    const section = blankSection(bank, label, passageId || null, readingSource);
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
      // readingSource === "analysis" (School Exam Builder, Reading Analysis 재설계 Phase C)만
      // 신규 readingAnalysisQuestions로 간다 — 필드가 없는 모든 기존 섹션(레거시 reading 포함)은
      // 예전과 똑같이 READING_QUESTION_COLLECTION 경로를 탄다(하위호환, 회귀 없음).
      const collectionName = section.bank === "grammar" ? QB.GRAMMAR_COLLECTION
        : section.readingSource === "analysis" ? QB.READING_ANALYSIS_QUESTION_COLLECTION
        : QB.READING_QUESTION_COLLECTION;
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

  // School Exam Builder (Reading Analysis 재설계 Phase C, 2026-08-26 설계 승인 §5) — curriculum
  // master collection을 만들지 않고, 이미 로드된 examPapers 목록에서 즉석으로 최근 사용값을
  // 뽑는다(computeRecentlyUsedQuestionIds와 동일한 패턴 — 추가 Firestore 읽기 없음). 나중에
  // master collection으로 승격하고 싶어지면 이 함수 내부만 바꾸면 되고, 호출부(UI)는 그대로.
  function getRecentSchoolExamValues(examPapers, limitPapers) {
    const schoolPapers = (examPapers || [])
      .filter((p) => p.examCategory === "school" && p.schoolExamMeta)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limitPapers || 30);
    function uniq(arr) { return [...new Set(arr.filter(Boolean))]; }
    return {
      schools: uniq(schoolPapers.map((p) => p.schoolExamMeta.school)),
      publishers: uniq(schoolPapers.map((p) => p.schoolExamMeta.publisher)),
      textbooks: uniq(schoolPapers.map((p) => p.schoolExamMeta.textbook)),
      lessons: uniq(schoolPapers.map((p) => p.schoolExamMeta.lesson)),
      examRanges: uniq(schoolPapers.map((p) => p.schoolExamMeta.examRange)),
    };
  }

  window.SarahServices.examPaperService = {
    EXAM_PAPER_COLLECTION,
    listExamPapers, createExamPaper, updateExamPaper, duplicateExamPaper,
    blankSection, autoSelectGrammarSection, autoSelectReadingSections, manualSection,
    computeRecentlyUsedQuestionIds, autoDistributeGrammarSection, autoDistributeReadingSections,
    autoDistributeReadingAnalysisSections, getRecentSchoolExamValues,
    finalizeExamPaper, computeFinalizedSections,
    canArchiveExamPaper, archiveExamPaper,
    canHardDeleteExamPaper, hardDeleteExamPaper,
    resolveQuestionForDisplay,
    totalQuestionCount,
  };
})();
