// Phase 7 (원래 로드맵 순서상 "Sarah's Original", ARCHITECTURE.md §14) — the ONLY file in this repo
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

  window.SarahServices.questionGenerationService = {
    generateGrammarQuestions,
    generateReadingQuestions,
    generateReadingAnalysisQuestions,
  };
})();
