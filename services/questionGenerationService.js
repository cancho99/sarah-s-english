// Phase 7 (원래 로드맵 순서상, ARCHITECTURE.md §14) — the ONLY file in this repo
// allowed to call an AI API for question generation. services/questionBankService.js never calls
// AI (verified: 0 `fetch` calls in that file outside comments) and knows nothing about this file —
// the dependency is one-directional (this file calls questionBankService's create*/list* functions,
// never the reverse). This is what makes "Question Bank works fully with zero AI calls" a structural
// guarantee, not just a convention. See CLAUDE.md "API cost policy".
//
// AI is called ONLY when a teacher explicitly clicks a generate button — never on page load, bank
// browsing, search, or filter. Every function here maps to exactly one Anthropic API call
// (ARCHITECTURE.md §14.9 confirmed this against the existing examVariant handler's actual code).
// Generated results are always persisted as DRAFT with source.type "AI_GENERATED" — never discarded,
// never auto-published (PUBLISHED is only reachable from APPROVED, enforced by questionBankService's
// existing status-transition guard, unchanged by this file).
//
// Provider-agnostic shape (CLAUDE.md §8): only `callAiWorker` below knows the request goes to this
// repo's aiWorker Cloud Function. Swapping to Gemini/OpenAI/local later means changing only that one
// function; generateGrammarQuestions/generateReadingQuestions don't know or care which provider ran.
window.SarahServices = window.SarahServices || {};

(function () {
  const QB = window.SarahServices.questionBankService;
  const AI_WORKER_URL = "https://us-central1-sarah-s-english.cloudfunctions.net/aiWorker";

  async function callAiWorker(body) {
    const res = await fetch(AI_WORKER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error((json.error || "AI 생성에 실패했어요.") + (json.detail ? " / " + String(json.detail).slice(0, 200) : ""));
    }
    if (!Array.isArray(json)) throw new Error("AI 응답 형식이 올바르지 않아요.");
    return json;
  }

  // AI item -> questionBankService.createQuestion() input shape. Both grammarGenerate and
  // readingGenerate modes return the same { type, q, choices, answer, explanation,
  // wrongChoiceExplanations? } shape (functions/index.js GRAMMAR_GENERATE/READING_GENERATE prompts).
  function toQuestionInput(item, extra) {
    return {
      ...extra,
      questionText: item.q || "",
      choices: item.type === "mc" ? (item.choices || []) : [],
      answer: item.answer,
      explanation: item.explanation || "",
      wrongChoiceExplanations: Array.isArray(item.wrongChoiceExplanations) ? item.wrongChoiceExplanations : [],
      tags: extra.tags || [],
    };
  }

  // opts: { grade, mainCategory, subCategory, questionType, difficulty, count, tags? }
  // mainCategory/subCategory/questionType are taxonomy KEYS (e.g. "tense"/"presentPerfect"/"blank") —
  // this function resolves their Korean labels itself so the caller doesn't have to.
  async function generateGrammarQuestions(opts) {
    const cat = QB.GRAMMAR_TAXONOMY.find((c) => c.key === opts.mainCategory);
    const sub = cat && (cat.subCategories || []).find((s) => s.key === opts.subCategory);
    const qType = QB.QUESTION_TYPES.find((t) => t.key === opts.questionType);
    const diff = QB.DIFFICULTIES.find((d) => d.key === opts.difficulty);
    const items = await callAiWorker({
      mode: "grammarGenerate",
      grade: opts.grade || "",
      mainCategoryLabel: cat ? cat.label : "",
      subCategoryLabel: sub ? sub.label : "",
      questionTypeLabel: qType ? qType.label : "",
      difficultyLabel: diff ? diff.label : "",
      count: opts.count || 5,
    });
    const saved = [];
    for (const item of items) {
      const input = toQuestionInput(item, {
        grade: opts.grade, difficulty: opts.difficulty, mainCategory: opts.mainCategory, subCategory: opts.subCategory,
        questionType: opts.questionType, tags: opts.tags,
      });
      input.source = { type: "AI_GENERATED", note: "questionGenerationService.generateGrammarQuestions" };
      const doc = await QB.createGrammarQuestion(input);
      saved.push(doc);
    }
    return saved;
  }

  // opts: { passage (readingPassages doc), questionType, difficulty, count, tags? }
  // Only ever adds questions to an EXISTING passage — never generates passage text itself (§14.8).
  async function generateReadingQuestions(opts) {
    const qType = QB.READING_QUESTION_TYPES.find((t) => t.key === opts.questionType);
    const diff = QB.DIFFICULTIES.find((d) => d.key === opts.difficulty);
    const items = await callAiWorker({
      mode: "readingGenerate",
      passageText: opts.passage.passageText,
      questionTypeLabel: qType ? qType.label : "",
      difficultyLabel: diff ? diff.label : "",
      count: opts.count || 5,
    });
    const saved = [];
    for (const item of items) {
      const input = toQuestionInput(item, {
        grade: opts.passage.grade, difficulty: opts.difficulty, questionType: opts.questionType,
        examType: opts.passage.examType, tags: opts.tags,
      });
      input.source = { type: "AI_GENERATED", note: "questionGenerationService.generateReadingQuestions" };
      const doc = await QB.createReadingQuestion(input, opts.passage.id);
      saved.push(doc);
    }
    return saved;
  }

  // opts: { analysis (readingAnalyses doc), questionType, difficulty, count, tags? }
  // Reading Analysis 재설계(Phase C, 2026-08-26 설계 승인) — generateReadingQuestions와 같은 패턴,
  // 대상 저장소만 questionBankService의 새 readingAnalysisQuestions 바인딩으로 바뀐다. 레거시
  // readingQuestions/readingPassages는 이 함수가 절대 건드리지 않는다. originalText(원문)뿐
  // 아니라 이미 만들어진 analysis(문장 구조/문법포인트/어휘 등)까지 함께 넘겨서 Passage
  // Analysis 단계의 결과를 문제 생성 품질에 실제로 반영한다.
  async function generateReadingAnalysisQuestions(opts) {
    const qType = QB.READING_QUESTION_TYPES.find((t) => t.key === opts.questionType);
    const diff = QB.DIFFICULTIES.find((d) => d.key === opts.difficulty);
    const items = await callAiWorker({
      mode: "readingAnalysisGenerate",
      passageText: opts.analysis.originalText,
      analysis: opts.analysis.analysis || null,
      questionTypeLabel: qType ? qType.label : "",
      difficultyLabel: diff ? diff.label : "",
      count: opts.count || 5,
    });
    const saved = [];
    for (const item of items) {
      const input = toQuestionInput(item, {
        grade: opts.analysis.grade, difficulty: opts.difficulty, questionType: opts.questionType,
        examType: opts.analysis.examType, tags: opts.tags,
      });
      input.source = { type: "AI_GENERATED", note: "questionGenerationService.generateReadingAnalysisQuestions" };
      const doc = await QB.createReadingAnalysisQuestion(input, opts.analysis.id);
      saved.push(doc);
    }
    return saved;
  }

  // "PDF에서 문제 가져오기" (Question Generator, 2026-09-01) — 지문·선택지·정답이 이미 완성된
  // 기존 문제집 PDF에서 문항을 추출한다. 위 3개 함수와 달리 결과를 즉시 저장하지 않는다 — 이
  // 기능은 검토(수정 가능한 형태로 보여주고, 문항 단위로 저장에서 제외 가능) 후에만 저장하는
  // 흐름이 명시적으로 요구돼서, 저장은 UI(PdfBlankQuestionImportPanel)가 readingAnalysisService/
  // questionBankService를 직접 호출해서 한다(둘 다 AI를 부르지 않는 순수 CRUD라 여기서 굳이
  // 감쌀 이유가 없다 — CLAUDE.md "서비스 레이어 분리" 원칙은 지키되 과설계는 피함).
  //
  // 1차 범위는 "빈칸 추론" 유형뿐(§CLAUDE.md 신규 기능 요청 원문) — 다른 5개 유형(문장삽입/
  // 요약문완성/글의순서/질문찾기/내용일치)은 나중에 유형별로 별도 함수+aiWorker 모드를 추가할
  // 예정이며, 이 함수를 확장해서 처리하지 않는다.
  //
  // opts: { images } — renderPdfPageTiles(index.html)가 만든 base64 PNG 타일 배열, examkey
  // 모드와 동일한 PDF-비전 방식.
  // 반환: [{ number, passage, choices:[5], answer(1~5 또는 null) }] — 저장되지 않은 원본 결과.
  async function extractBlankInferenceQuestionsFromPdf(opts) {
    const items = await callAiWorker({ mode: "extractBlankInferenceQuestions", images: opts.images || [] });
    return items.map((it) => {
      // AI 응답이 스키마대로 숫자 1~5여야 정상이지만, 가끔 "3" 같은 문자열로 오는 경우까지
      // Number()로 한 번 더 받아준다 — 여기서 놓치면 answer가 잘못 null 처리돼서 멀쩡히 읽은
      // 정답까지 검토 화면에서 "파싱 실패"로 표시되는 오탐이 생긴다.
      const ansNum = Number(it.answer);
      return {
        number: String(it.number != null ? it.number : ""),
        passage: it.passage || "",
        choices: Array.isArray(it.choices) ? it.choices.slice(0, 5).map((c) => c || "") : [],
        answer: Number.isInteger(ansNum) && ansNum >= 1 && ansNum <= 5 ? ansNum : null,
      };
    });
  }

  window.SarahServices.questionGenerationService = {
    generateGrammarQuestions,
    generateReadingQuestions,
    generateReadingAnalysisQuestions,
    extractBlankInferenceQuestionsFromPdf,
  };
})();
