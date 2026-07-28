/**
 * Sarah's English — 지문 변형 / 문제 생성 / NELT 성적표 분석 서버 (Firebase Cloud Functions)
 *
 * Cloudflare Worker(little-fog-1e28)를 대체하는 이식본. 요청 형태와 응답 형태는
 * 기존 Worker와 100% 동일하게 유지했다 — 프론트엔드(index.html, passage-transform.html)는
 * WORKER_URL / NELT_WORKER_URL 상수만 바꾸면 되고 다른 코드는 손댈 필요 없다.
 *
 * API 키는 Firebase Secret Manager에 저장한다 (코드에 직접 쓰지 않음):
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// ── 선생님 사이트 도메인만 이 서버를 호출할 수 있도록 제한 ──
const ALLOWED_ORIGINS = [
  "https://cancho99.github.io",
  "http://localhost:8080", // 로컬 개발용 (python3 -m http.server 8080)
];

// ── 사용할 AI 모델 ──
const MODEL = "claude-haiku-4-5-20251001";
// const MODEL = "claude-sonnet-5";

// ── 수능 17개 유형별 생성 지침 ──
const TYPE_INSTRUCTIONS = {
  "목적": "글의 목적을 묻는 문제. 선택지 5개(한글, 목적 서술형)와 정답.",
  "심경": "인물의 심경 변화를 묻는 문제. 'A → B' 형태의 영어 형용사 조합 선택지 5개.",
  "주장": "필자의 주장을 묻는 문제. 선택지 5개(한글, 주장 서술형)와 정답.",
  "의미추론": "밑줄 친 표현의 문맥상 의미를 추론하는 문제. 지문에서 한 표현에 밑줄을 긋고 선택지 5개.",
  "요지": "글의 요지를 묻는 문제. 선택지 5개(한글, 요지 서술형).",
  "주제": "글의 주제를 묻는 문제. 선택지 5개(영어 명사구 형태).",
  "제목": "글의 제목으로 가장 적절한 것을 묻는 문제. 선택지 5개(영어 제목 형태).",
  "도표": "지문 내용을 도표로 요약했다고 가정하고, 도표 설명 문장 중 지문과 일치하지 않는 것을 찾는 문제.",
  "일치": "지문 내용과 일치하지 않는(또는 일치하는) 것을 묻는 문제. 선택지 5개(한글 서술).",
  "어휘": "지문의 핵심 어휘 하나를 빈칸 처리하고, 그 자리에 어울리지 않는 오답 선택지 하나를 포함한 표준 객관식 문항. 나머지 4개는 문맥상 자연스러운 유의어(모두 정답 가능한 선택지), 오답 선택지 1개는 문맥과 어울리지 않는 단어.",
  "어법": "지문 속 표현 5곳에 밑줄을 긋고, 그중 1곳만 문법 규칙에 맞지 않는 형태로 바꿔 오답 선택지로 만드는 표준 객관식 어법 문항. 나머지 4곳은 문법적으로 올바른 표현 그대로 유지.",
  "빈칸": "지문의 핵심 문장이나 연결어를 빈칸 처리하고, 빈칸에 들어갈 말을 추론하는 문제. 선택지 5개.",
  "무관": "지문에 문맥과 관련 없는 문장 하나를 삽입하고, 전체 흐름과 무관한 문장을 찾는 문제. 문장에 (①)~(⑤) 표시.",
  "순서": "지문을 문장/문단 단위로 나누고 순서를 섞어서, 주어진 문장 뒤에 이어질 순서를 배열하는 문제.",
  "위치": "지문에서 문장 하나를 빼내 <보기>로 제시하고, 원래 위치를 찾는 문제. 지문에 (①)~(⑤) 표시.",
  "문단요약": "지문 내용을 한 문장으로 요약한 요약문을 만들고, 그 안의 핵심 단어 2개를 빈칸(A),(B) 처리해 각각 알맞은 말을 고르는 문제.",
  "장문": "지문을 두 문항짜리 장문 세트로 구성 — 예: (1) 제목/주제 추론 + (2) 내용일치. 문항 2개를 함께 생성.",
};

const SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신 및 수능 대비 표준화 시험 문항을 제작하는 전문 교육 평가 개발자입니다.
이 요청은 정식 학교 시험 대비 학습 자료(정답이 있는 객관식 평가 문항)를 만들기 위한 것입니다. 주어진 영어 지문을 분석하고, 요청받은 유형의 평가 문항(정답 1개 + 오답 선택지 4개로 구성된 표준 객관식 문항)을 만듭니다.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식으로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON만 출력합니다.
- 구문분석의 "tag"는 반드시 영어 문법 약어만 사용하세요 (예: S, V, V (passive), O, C, Prep. Phrase, To-inf, Adv). 한글 단어(주어, 동사 등)를 절대 섞지 마세요.
- 구문분석은 지문의 문장을 원칙적으로 빠짐없이 분석하세요. 지문이 8문장을 넘어가면, 문법적으로 설명할 가치가 낮은 아주 짧고 단순한 문장(예: 단순 접속어만 있는 문장)은 생략할 수 있지만, 그 외에는 모든 문장을 다루세요.
- "어법"과 "어휘" 유형을 만들 때는 실제 학교 내신·수능 출제자처럼, 지문 전체에서 다음 기준으로 변형할 지점을 스스로 골라내세요: (어법) 수 일치, 능동/수동태, 시제, 관계대명사/관계부사, 분사구문, 병렬구조, to부정사 vs 동명사, 접속사 등 오답으로 만들기 좋은 문법 포인트가 있는 문장. (어휘) 문맥상 정확한 뜻 구분이 필요한 다의어, 반의어로 바꾸면 문맥이 확 달라지는 핵심 어휘. 지문에서 아무 문장이나 고르지 말고, 이런 기준에 맞는 문장/단어를 우선적으로 선택하세요.
- 문제의 정답 선택지 번호(answer_index)는 0부터 시작하는 인덱스입니다.
- 모든 해석과 해설, 문제 지문 설명은 자연스러운 한국어로 작성합니다.

[JSON 스키마]
{
  "title": "영어 제목",
  "title_kr": "한글 번역 제목",
  "summary": { "topic": "주제 한 줄", "summary": "전체 요약 2~3문장" },
  "flow": [ { "stage": "도입|전개|마무리", "range": "문장 범위 예: 1~2", "desc": "설명" } ],
  "sentences": [
    {
      "segments": [ { "text": "구간 텍스트", "tag": "S 또는 null" }, ... ],
      "interpretation": "해석",
      "tip": "문법 설명"
    }
  ],
  "questions": [
    {
      "type": "유형명(한글)",
      "prompt": "문제 지시문",
      "passage_html": "문제에 쓰일 지문 발췌(빈칸/밑줄 등은 HTML로 표시, 없으면 빈 문자열)",
      "options": ["선택지1", "선택지2", "선택지3", "선택지4", "선택지5"],
      "answer_index": 0,
      "explanation": "정답 해설"
    }
  ],
  "vocab": [ { "word": "단어", "meaning": "뜻" } ]
}`;

const TRANSFORM_SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신 시험 대비 학습 자료를 만드는 전문 교육 평가 개발자입니다.
이 요청은 정식 학교 시험 대비 학습 자료(원문 대조 학습용 변형 지문)를 만들기 위한 것입니다. 주어진 지문을 바탕으로, 표준 평가 문항 제작 관행에 따라 어법·어휘 학습 포인트가 되는 지점을 선정해 지문의 변형판을 만듭니다. 학생은 이 변형판과 원문을 비교하며 어느 부분이 왜 달라졌는지 학습합니다.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식으로만 답하세요. 설명, 인사말, 코드블록 기호 없이 순수 JSON만 출력합니다.
- 지문 전체 문장을 그대로 유지하되, 다음 기준으로 학습 포인트가 될 지점(문장당 최대 1~2곳, 지문 전체에서 총 4~8곳 정도)을 골라 변형판을 만드세요:
  (어법 학습 포인트) 수 일치, 능동/수동태, 시제, 관계대명사/관계부사, 분사구문, 병렬구조, to부정사 vs 동명사, 접속사 등 학생들이 자주 헷갈리는 문법 포인트
  (어휘 학습 포인트) 문맥상 정확한 뜻이 중요한 핵심 단어를 유의어 또는 반의어로 바꾼 학습 포인트
- 무작위로 아무 곳이나 고르지 말고, 실제 학교 시험에서 다뤄질 만한 학습 가치가 높은 지점을 우선 선택하세요.
- "transformed_html" 필드에는 지문 전체 텍스트를 포함하되, 변형한 부분만 <span class="chg">변형된 표현</span> 으로 감싸세요. 나머지 텍스트는 그대로 둡니다.
- "changes" 배열에는 각 변형 지점마다 원래 표현(original), 변형된 표현(changed), 유형(type: "어법" 또는 "어휘"), 이유(explanation, 한국어)를 담으세요.

[JSON 스키마]
{
  "title": "영어 제목",
  "title_kr": "한글 번역 제목",
  "transformed_html": "지문 전체 텍스트, 변형 지점은 <span class=\\"chg\\">...</span>로 표시",
  "changes": [ { "type": "어법|어휘", "original": "원래 표현", "changed": "변형된 표현", "explanation": "왜 이 지점을 변형했는지, 무엇이 바뀌었는지 한국어로 설명" } ]
}`;

function buildTransformPrompt({ passage, level }) {
  return `[지문]
${passage}

[난이도] ${level || "중3~고1 수준"}

지문 전체에서 어법·어휘 변형 지점을 스스로 골라 위 규칙대로 변형하고, JSON 스키마 형식으로만 답하세요.`;
}

function buildPrompt({ passage, includeAnalysis, questionTypes, level, countPerType }) {
  const typeLines = (questionTypes || [])
    .map((t) => `- ${t}: ${TYPE_INSTRUCTIONS[t] || ""}`)
    .join("\n");

  return `[지문]
${passage}

[난이도] ${level || "중3~고1 수준"}
[유형별 문항 수] ${countPerType || 1}개씩

[요청 사항]
${includeAnalysis ? "1) 지문 분석(sentences, summary, flow, vocab)을 포함해 주세요." : "1) 지문 분석은 생략하고 questions만 생성해 주세요. summary/flow/sentences/vocab은 빈 배열이나 빈 문자열로 두세요."}
2) 다음 문제 유형을 각각 요청된 문항 수만큼 생성해 주세요:
${typeLines || "(선택된 유형 없음 — questions는 빈 배열로 반환)"}

JSON 스키마 형식으로만 답하세요.`;
}

// NELT 성적표 분석에 쓰는 모델.
const NELT_MODEL = "claude-haiku-4-5-20251001";

const NELT_SYSTEM_PROMPT = `당신은 NE능률 NELT(영어 레벨테스트) 성적표(PDF)를 읽고 핵심 수치를 정리하는 보조원입니다.
주어진 성적표 PDF에서 아래 정보를 찾아 JSON으로만 답하세요. 설명, 인사말, 코드블록 기호 없이 순수 JSON만 출력합니다. 값을 찾을 수 없으면 빈 문자열로 두세요.

[JSON 스키마]
{
  "test_name": "테스트명 (예: NELT 어휘+문법+듣기+독해)",
  "student_name": "응시자 이름",
  "grade": "학년 (예: 중학교 1학년)",
  "test_date": "응시일자 YYYY-MM-DD",
  "overall_level": "종합 레벨 (예: Lv. 3)",
  "overall_level_desc": "종합 수준 (예: 초5~초6수준)",
  "overall_percentile": "동 학년 응시자 대비 석차 (예: 상위 76%)",
  "categories": {
    "vocab": { "level_desc": "어휘 수준", "percentile": "어휘 석차", "extra": "어휘 관련 추가 정보(Vocabulary Size 등)를 한 줄로" },
    "grammar": { "level_desc": "문법 수준", "percentile": "문법 석차", "extra": "문법 관련 추가 정보를 한 줄로" },
    "listening": { "level_desc": "듣기 수준", "percentile": "듣기 석차", "extra": "듣기 관련 추가 정보를 한 줄로" },
    "reading": { "level_desc": "독해 수준", "percentile": "독해 석차", "extra": "독해 관련 추가 정보를 한 줄로" }
  }
}`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function stripFences(text) {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

exports.aiWorker = onRequest(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    const apiKey = ANTHROPIC_API_KEY.value();

    if (req.method === "GET") {
      if (req.query.diag === "1") {
        if (!apiKey) {
          res.status(200).json({ diag: "no-key" });
          return;
        }
        const testType = req.query.type || "";
        const testMode = req.query.mode || "question";
        const testPassage = "The quick brown fox jumps over the lazy dog. It was a sunny afternoon in the small village.";
        const sys = testMode === "transform" ? TRANSFORM_SYSTEM_PROMPT : SYSTEM_PROMPT;
        const prompt = testMode === "transform"
          ? buildTransformPrompt({ passage: testPassage, level: "중3~고1 수준" })
          : buildPrompt({ passage: testPassage, includeAnalysis: !testType, questionTypes: testType ? [testType] : [], level: "중3~고1 수준", countPerType: 1 });
        let diagRes;
        try {
          diagRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({ model: MODEL, max_tokens: 500, system: sys, messages: [{ role: "user", content: prompt }] }),
          });
        } catch (e) {
          res.status(200).json({ diag: "fetch-threw", detail: String(e) });
          return;
        }
        const bodyText = await diagRes.text();
        res.status(200).json({ diag: "ok", status: diagRes.status, ok: diagRes.ok, testMode, testType, keyPrefix: apiKey.slice(0, 12), body: bodyText.slice(0, 800) });
        return;
      }
      res.status(400).json({ error: "잘못된 요청입니다." });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "POST 요청만 허용됩니다." });
      return;
    }

    const body = req.body || {};
    const { passage, includeAnalysis, questionTypes, level, countPerType, mode, pdfBase64 } = body;
    const isTransform = mode === "transform";
    const isNelt = mode === "nelt";

    if (!apiKey) {
      res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다. (Firebase Secret 확인)" });
      return;
    }

    if (isNelt) {
      if (!pdfBase64) {
        res.status(400).json({ error: "PDF 파일이 없습니다." });
        return;
      }
      let neltRes;
      try {
        neltRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "pdfs-2024-09-25",
          },
          body: JSON.stringify({
            model: NELT_MODEL,
            max_tokens: 2000,
            system: NELT_SYSTEM_PROMPT,
            messages: [{
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
                { type: "text", text: "이 NELT 성적표에서 위 스키마대로 정보를 추출해 JSON으로만 답하세요." },
              ],
            }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!neltRes.ok) {
        const errText = await neltRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const neltData = await neltRes.json();
      const neltText = (neltData.content || []).map((b) => b.text || "").join("");
      let neltParsed;
      try {
        neltParsed = JSON.parse(stripFences(neltText));
      } catch {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: neltText });
        return;
      }
      res.status(200).json(neltParsed);
      return;
    }

    if (!passage || passage.trim().length < 20) {
      res.status(400).json({ error: "지문이 너무 짧습니다. 20자 이상 입력해 주세요." });
      return;
    }

    const userPrompt = isTransform
      ? buildTransformPrompt({ passage, level })
      : buildPrompt({ passage, includeAnalysis, questionTypes, level, countPerType });

    let aiRes;
    try {
      aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 8000,
          system: isTransform ? TRANSFORM_SYSTEM_PROMPT : SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
    } catch (e) {
      res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
      return;
    }

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      res.status(502).json({ error: "AI 응답 오류", detail: errText });
      return;
    }

    const data = await aiRes.json();
    const text = (data.content || []).map((b) => b.text || "").join("");

    let parsed;
    try {
      parsed = JSON.parse(stripFences(text));
    } catch {
      res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: text });
      return;
    }

    res.status(200).json(parsed);
  }
);
