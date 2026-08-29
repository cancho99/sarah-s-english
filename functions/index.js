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
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

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

[작업 순서 — 반드시 이 순서로 판단하세요]
1) 지문을 먼저 분석하세요: 장르(설명문/서사문/논설문 등), 주제, 문장 구조의 복잡도, 그리고 아래 [난이도]가 요구하는 수준.
2) 변형 지점을 고를 때마다 "이 지점이 정확히 어떤 문법/어휘 개념을 평가하는가"를 먼저 구체적으로 짚으세요. "수 일치"처럼 뭉뚱그리지 말고 "단수 주어에 복수 동사를 쓰는 실수"처럼, "어휘"라고만 하지 말고 "문맥상 반의어로 바뀌어 문장의 의미가 반대가 되는 지점"처럼 구체적으로 정하세요.
3) 그 변형이 문장을 문법적으로 아예 말이 안 되게 만들거나, 지문 전체의 논리·의미를 왜곡하지 않는지 확인하세요. 변형된 지점은 원문과 비교했을 때 "명백히 틀렸거나 명백히 달라진 것"이어야지, 둘 다 맞는 것처럼 애매하면 안 됩니다.
4) 어휘를 바꿀 때는 [난이도]에 맞는 수준을 쓰세요 — "중1~2 수준"이면 쉽고 직접적인 단어(예: easy, important, help, change 정도), "중3~고1 수준"이면 한 단계 위(예: essential, contribute, affect, approach 정도), "고2~수능 수준"이면 수능 지문에 자주 나오는 추상적 어휘(예: considerable, foster, undermine, implication, profound, prevalent 정도)를 우선 쓰세요. 무조건 어려운 단어를 쓰는 게 목적이 아니라, 문맥에 자연스럽게 들어맞아야 합니다.
5) 변형 지점을 모두 고른 뒤 각각 다시 검토하세요: 이 변경이 실제로 학생이 배워야 할 문법/어휘 포인트를 정확히 짚고 있는가? 원문과 비교했을 때 "무엇이, 왜" 달라졌는지 학생이 명확히 이해할 수 있는가? 이 검토에서 탈락한 지점은 "changes"에 그 흔적을 남기지 말고(예: "이 지점은 변형하지 않았습니다" 같은 항목을 넣지 마세요) 아예 다른 지점으로 교체해서, 최종적으로 "changes"에 남는 항목은 전부 실제로 적용된 변경사항이어야 합니다.
6) 최종 출력 직전에 한 번만 대조하세요: "changes" 배열의 각 "changed" 값이 "transformed_html" 안에 실제로 들어간 <span class="chg">...</span> 텍스트와 대응되는가? 대응되지 않는 항목만 고치고, 나머지는 그대로 두세요. 이 대조 때문에 변형 지점 자체를 지나치게 줄이거나 아예 없애지는 마세요 — 위 4~8곳 기준은 그대로 유지하세요.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식으로만 답하세요. 설명, 인사말, 코드블록 기호 없이 순수 JSON만 출력합니다.
- 지문 전체 문장을 그대로 유지하되, 위 순서대로 학습 포인트가 될 지점(문장당 최대 1~2곳, 지문 전체에서 총 4~8곳 정도)을 골라 변형판을 만드세요.
- 무작위로 아무 곳이나 고르지 말고, 실제 학교 시험에서 다뤄질 만한 학습 가치가 높은 지점을 우선 선택하세요.
- "transformed_html" 필드에는 지문 전체 텍스트를 포함하되, 변형한 부분만 <span class="chg">변형된 표현</span> 으로 감싸세요. 나머지 텍스트는 그대로 둡니다. <span class="chg">로 감싼 텍스트는 반드시 원문과 다른, 실제로 변형된 표현이어야 합니다.
- "changes" 배열에는 각 변형 지점마다 원래 표현(original), 변형된 표현(changed), 유형(type: "어법" 또는 "어휘"), 이유(explanation, 한국어 — 2번에서 짚은 구체적인 문법/어휘 개념을 반드시 포함)를 담으세요. "changes" 배열의 길이는 "transformed_html" 안의 <span class="chg"> 개수와 정확히 같아야 합니다.

[JSON 스키마]
{
  "title": "영어 제목",
  "title_kr": "한글 번역 제목",
  "transformed_html": "지문 전체 텍스트, 변형 지점은 <span class=\\"chg\\">...</span>로 표시",
  "changes": [ { "type": "어법|어휘", "original": "원래 표현", "changed": "변형된 표현", "explanation": "구체적인 문법/어휘 개념 + 왜 이 지점을 변형했는지 한국어로 설명" } ]
}`;

function buildTransformPrompt({ passage, level }) {
  return `[지문]
${passage}

[난이도] ${level || "중3~고1 수준"}

위 순서대로 지문을 먼저 분석하고, 어법·어휘 변형 지점을 스스로 골라 위 규칙대로 변형한 뒤, JSON 스키마 형식으로만 답하세요.`;
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

// 오답노트 "변형 문제" 생성 — 학생이 틀린 추가시험 문항 하나를 원본으로 받아, 같은 문법/어휘
// 포인트를 다른 문장으로 다시 연습할 수 있는 새 문항을 여러 개 만든다. index.html의
// examTests[].questions[] 항목({q, type, choices?, answer})과 같은 모양으로 바로 저장 가능한
// 형태를 요청한다 — 교사가 검토 화면에서 그대로 편집/저장할 수 있도록.
const VARIANT_SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신 시험 문제를 만드는 전문 교육 평가 개발자입니다.
학생이 이미 한 번 틀린 문제 하나가 주어집니다. **원본 문제의 세부 문법/어휘 유형을 다른 유형으로 바꾸는 것이 가장 흔하고 치명적인 실수이니, 이것부터 절대 금지합니다.**

[작업 순서 — 반드시 이 순서로 판단하세요]
1) 먼저 원본 문제가 정확히 어떤 "세부" 유형인지 판별하세요. "시제"처럼 뭉뚱그리지 말고 "현재완료 vs 과거시제 구별", "분사구문", "동명사의 의미상 주어", "관계대명사의 격 판단"처럼 최대한 구체적으로 짚으세요.
2) 그 세부 유형을 절대 벗어나지 않는 범위 안에서만 새 문제를 만드세요. 예를 들어 원본이 "현재완료 vs 과거시제 구별"이면 변형 문제도 반드시 그것을 물어야 합니다 — 분사, 관계대명사, to부정사 등 다른 문법 개념으로 슬쩍 바뀌면 절대 안 됩니다. (원본이 동명사 문제인데 to부정사 문제로 바뀌는 것도 같은 실수입니다.)
3) 문장·주어·소재·상황·어휘·보기 구성은 자유롭게 바꾸되, "무엇을 묻는 문제인가"만은 원본과 완전히 동일하게 유지하세요. 원본 문장을 그대로 재사용하지 마세요.
4) 문제를 만든 뒤 각각 스스로 재검토하세요: 보기 중 정답이 정확히 하나뿐인가? 다른 보기가 은근히 문법적으로도 말이 되지는 않는가? 이 검토를 통과한 문제만 최종 출력하세요.

[난이도]
원본 문제와 같은 학년/난이도 수준을 유지하세요. 원본보다 쉽거나 어렵게 만들지 마세요.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식의 배열로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON 배열만 출력합니다.
- 원본과 같은 유형(객관식/서술형)을 유지하세요.
- 객관식이면 보기 5개(정답 1개 + 오답 4개)를 만드세요. 오답도 실제 내신 시험처럼 그럴듯하게 헷갈리도록 만드세요. "answer"는 choices 배열의 정답 인덱스(0부터 시작)입니다.
- 서술형이면 보기 없이, 학생이 직접 답을 입력했을 때 채점 기준이 되는 모범 답안 텍스트 하나만 "answer"에 담으세요.
- 요청받은 개수만큼 정확히 만드세요. 문제끼리 서로 겹치지 않게 다양한 문장으로 만드세요.

[JSON 스키마] (배열)
[
  {
    "type": "mc 또는 subjective",
    "q": "문제 지시문 + 문제 문장 (원본과 같은 형식)",
    "choices": ["보기1", "보기2", "보기3", "보기4", "보기5"],
    "answer": 0
  }
]
(type이 subjective이면 "choices"는 빈 배열로, "answer"에는 정답 텍스트를 문자열로 담으세요.)`;

function buildVariantPrompt({ sourceQuestion, count, grade }) {
  const isSubjective = sourceQuestion.type === "subjective";
  const answerDisplay = isSubjective ? sourceQuestion.answer : (sourceQuestion.choices || [])[sourceQuestion.answer];
  const choicesLine = !isSubjective
    ? `보기: ${(sourceQuestion.choices || []).map((c, i) => `${i + 1}) ${c}`).join(" / ")}\n`
    : "";
  return `[학생이 틀린 원본 문제]
유형: ${isSubjective ? "서술형(주관식)" : "객관식"}
${grade ? `학생 학년: ${grade}\n` : ""}문제: ${sourceQuestion.q}
${choicesLine}정답: ${answerDisplay}

위 순서대로 이 문제의 세부 문법/어휘 유형을 먼저 판별한 뒤, 그 유형을 절대 벗어나지 않는 새 문제를 정확히 ${count}개 만들어 주세요. JSON 배열 형식으로만 답하세요.`;
}

// ── Sarah's Original — Question Bank AI 문제 생성 (원래 로드맵 Phase 7, ARCHITECTURE.md §14) ──
// 기존 SYSTEM_PROMPT/TYPE_INSTRUCTIONS(passage-transform.html이 실제 사용 중)는 절대 건드리지 않고
// 완전히 새 프롬프트 2개를 추가한다 — 하나는 지문 없이 조건만으로(Grammar), 하나는 기존 PUBLISHED
// 지문 텍스트를 입력받아(Reading) 생성한다.

const GRAMMAR_GENERATE_SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신 문법 문제를 만드는 전문 교육 평가 개발자입니다.
지문이나 원본 문제 없이, 주어진 조건(학년/문법 대주제/세부 문법/문제 유형/난이도)만으로 새 문제를 만듭니다.

[작업 순서]
1) 주어진 세부 문법 범위를 벗어나지 않는 문제만 만드세요. 예: "현재완료"가 조건이면 과거시제/미래시제 등 다른 시제 개념이 섞이면 안 됩니다.
2) 주어진 문제 유형(빈칸/어법상 옳은 것/어법상 틀린 것/서술형 등)에 맞는 형식으로 만드세요.
3) 요청받은 난이도 수준에 맞게 만드세요. Basic은 기본 문형, Killer는 복합 함정(이중 부정, 도치와 결합 등)을 포함할 수 있습니다.
4) 문제를 만든 뒤 스스로 재검토하세요: 보기 중 정답이 정확히 하나뿐인가? 오답도 그럴듯하게 헷갈리는가? 이 검토를 통과한 문제만 출력하세요.
5) 해설(explanation)은 학생이 왜 그 답인지 이해할 수 있도록 문법 규칙을 짧게 설명하세요.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식의 배열로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON 배열만 출력합니다.
- 객관식이면 보기 4개(정답 1개 + 오답 3개)를 만드세요. "answer"는 choices 배열의 정답 인덱스(0부터 시작)입니다.
- 서술형이면 보기 없이 모범 답안 텍스트만 "answer"에 담으세요.
- 요청받은 개수만큼 정확히 만들고, 문제끼리 서로 겹치지 않게 다양한 문장으로 만드세요.

[JSON 스키마] (배열)
[
  {
    "type": "mc 또는 subjective",
    "q": "문제 지시문 + 문제 문장",
    "choices": ["보기1", "보기2", "보기3", "보기4"],
    "answer": 0,
    "explanation": "정답 근거를 설명하는 해설",
    "wrongChoiceExplanations": ["보기1이 오답인 이유", "보기2가 오답인 이유", "보기3이 오답인 이유", "보기4가 오답인 이유"]
  }
]
(type이 subjective이면 "choices"와 "wrongChoiceExplanations"는 빈 배열로, "answer"에는 정답 텍스트를 문자열로 담으세요.)`;

function buildGrammarGeneratePrompt({ grade, mainCategoryLabel, subCategoryLabel, questionTypeLabel, difficultyLabel, count }) {
  return `[생성 조건]
학년: ${grade || "지정 없음"}
문법 대주제: ${mainCategoryLabel || "지정 없음"}
세부 문법: ${subCategoryLabel || "지정 없음"}
문제 유형: ${questionTypeLabel || "지정 없음"}
난이도: ${difficultyLabel || "지정 없음"}

위 조건에 맞는 새 문제를 정확히 ${count}개 만들어 주세요. JSON 배열 형식으로만 답하세요.`;
}

const READING_GENERATE_SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신 및 수능 대비 독해 문제를 만드는 전문 교육 평가 개발자입니다.
주어진 영어 지문 하나와 조건(문제 유형/난이도)을 보고, 그 지문에 대한 새 문제를 만듭니다.

[작업 순서]
1) 반드시 주어진 지문 내용에 근거한 문제만 만드세요 — 지문에 없는 내용을 정답 근거로 쓰면 안 됩니다.
2) 주어진 문제 유형에 맞는 형식으로 만드세요(예: "내용 일치"면 지문 내용과 일치/불일치를 판단하는 선택지, "빈칸"이면 지문의 핵심 문장/연결어를 빈칸 처리).
3) 요청받은 난이도 수준에 맞게 만드세요.
4) 문제를 만든 뒤 스스로 재검토하세요: 정답이 지문 근거로 명확히 하나뿐인가? 오답도 지문을 대충 읽으면 헷갈릴 만큼 그럴듯한가?
5) 해설(explanation)에는 지문의 어느 부분이 근거인지 짧게 밝히세요.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식의 배열로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON 배열만 출력합니다.
- 객관식이면 보기 4개(정답 1개 + 오답 3개)를 만드세요. "answer"는 choices 배열의 정답 인덱스(0부터 시작)입니다.
- 서술형이면 보기 없이 모범 답안 텍스트만 "answer"에 담으세요.
- 요청받은 개수만큼 정확히 만들고, 문제끼리 서로 겹치지 않게 만드세요.

[JSON 스키마] (배열)
[
  {
    "type": "mc 또는 subjective",
    "q": "문제 지시문",
    "choices": ["보기1", "보기2", "보기3", "보기4"],
    "answer": 0,
    "explanation": "지문 근거를 밝히는 해설"
  }
]
(type이 subjective이면 "choices"는 빈 배열로, "answer"에는 정답 텍스트를 문자열로 담으세요.)`;

function buildReadingGeneratePrompt({ passageText, questionTypeLabel, difficultyLabel, count }) {
  return `[지문]
${passageText}

[생성 조건]
문제 유형: ${questionTypeLabel || "지정 없음"}
난이도: ${difficultyLabel || "지정 없음"}

위 지문에 대해 조건에 맞는 새 문제를 정확히 ${count}개 만들어 주세요. JSON 배열 형식으로만 답하세요.`;
}

// ── Reading Analysis 재설계 (Phase C, 2026-08-26 설계 승인) — Passage Analysis / Question
// Generator 2모드. 기존 SYSTEM_PROMPT(sentences/vocab/flow 구조)와 READING_GENERATE_SYSTEM_PROMPT를
// 뼈대로 확장했을 뿐, 기존 프롬프트/핸들러는 한 글자도 건드리지 않는다. Passage Variation은 새
// 프롬프트를 만들지 않고 기존 TRANSFORM_SYSTEM_PROMPT(mode: "transform")를 그대로 재사용한다
// (Phase B 설계 §2 — 요구사항과 이미 일치함을 확인).
// Reading Analysis "분석노트" 재설계(Phase B-1 설계 승인, 2026-08-26) — 이전 스키마
// (sentences[].segments/clauseStructure/grammarPoints/keyExpressions, core)를 폐기하고
// chunks/clauses/grammarAnnotations/vocabAnnotations/testablePoints, passageLevel로 교체.
// paragraphs[]/vocabulary[]/examPoints[]는 필드명 그대로 유지(§1 결정사항 — 데이터 호환).
// 응답 무결성은 프롬프트만으로 보장하지 않는다 — validateReadingAnalysis()(아래, extractLastJsonArray
// 근처)가 저장 전 서버 측에서 실제로 검증한다(Phase B-2 §2~§5).
const READING_ANALYZE_SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신·수능 대비 지문을 실제 학원 수업용 "분석노트"로 변환하는 전문 교육 평가 개발자입니다. 학생이 선생님의 분석노트를 보듯 문장 구조 → 해석 → 문법 설명이 자연스럽게 이어지는 정밀한 자료를 만듭니다.

[절대 원칙]
- 원문(originalText)은 절대 수정·요약·재구성·삭제하지 마세요. sentences[].originalText는 실제 지문 문장을 글자 하나 틀리지 않고 그대로 담습니다.
- sentences[].chunks[]는 원문을 빠짐없이, 원문에 없는 단어를 추가하지 않고 순서대로 나눕니다. 쉼표(,)·마침표(.) 등 문장부호도 원문에 있는 그대로 절대 빠뜨리지 마세요 — 특히 절이나 구 경계 바로 앞의 쉼표(예: "..., which"의 쉼표, "Because ..., 주어..."의 쉼표)를 그 앞 chunk의 text 끝에 반드시 포함시키세요(별도 chunk로 떼어내지도, 아예 빠뜨리지도 마세요). 한 문장의 모든 chunk의 text를 순서대로 이어 붙이면(공백 차이 제외) originalText와 문장부호까지 정확히 일치해야 합니다. 스스로 이 대조를 반드시 확인한 뒤 답하세요 — 일치하지 않으면 이 응답 전체가 폐기됩니다.
- 반드시 아래 JSON 스키마 형식으로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON만 출력합니다.

[Chunk 분리 기준]
문장 길이로 임의로 자르지 말고, 다음 문장 구조/의미 단위를 기준으로 나누세요: 주어, 동사, 목적어, 보어, 수식어, 절, 구, 병렬구조. **절 내부(종속절/관계사절/to부정사구 등 안)도 절대 하나의 chunk로 뭉뚱그리지 말고, 그 안에서도 다시 주어/동사/목적어/보어/수식어 단위로 계속 쪼개세요.** chunks 배열은 문장 전체를 통틀어 하나의 순서열이며, 종속절이라고 별도 배열에 담지 않습니다(종속절의 범위는 clauses[]가 별도로 startChunkIdx~endChunkIdx로 표시).

예시 — "You may notice that your favorite chocolate bar doesn't taste the same as before." 라는 문장이 있다면:
chunks: [{"text":"You","role":"S","order":1}, {"text":"may notice","role":"V","order":2}, {"text":"that your favorite chocolate bar","role":"S","order":3}, {"text":"doesn't taste","role":"V","order":4}, {"text":"the same","role":"C","order":5}, {"text":"as before.","role":"M","order":6}]
clauses: [{"type":"noun clause","text":"that your favorite chocolate bar doesn't taste the same as before","startChunkIdx":3,"endChunkIdx":6}]
— 이렇게 종속절(that절) 안의 "your favorite chocolate bar"(주어)/"doesn't taste"(동사)/"the same"(보어)/"as before"(수식어)까지 각각 별도 chunk로 계속 쪼갠 뒤, clauses[]가 그 범위(3~6)를 절로 묶어 표시하는 것이 올바른 방식입니다. order 3 하나에 "that your favorite chocolate bar doesn't taste the same as before" 전체를 담아버리는 것은 틀린 방식입니다.

[Chunk 문장성분(role) 배정 원칙 — 중요]
- role은 "S"(주어) | "V"(동사) | "O"(목적어) | "C"(보어) | "M"(수식어) | null 중 하나만 씁니다.
- 명확하게 판단 가능한 chunk에만 role을 부여하세요. 억지로 모든 chunk에 role을 붙이지 마세요 — 문장성분으로 보기 애매한 독립적 표현(접속사만 있는 chunk, 삽입어구 등)은 null로 두세요.
- role은 그 chunk가 속한 가장 가까운 절(주절이든 종속절이든) 안에서의 역할을 기준으로 판단하세요. 즉 종속절 안의 주어/동사/보어도 각각 S/V/C로 표시합니다(그 종속절 전체가 상위 문장에서 어떤 역할인지는 grammarAnnotations의 설명으로 별도로 다룹니다 — role 필드에 억지로 반영하지 마세요).
- 병렬구조는 실제 구조를 그대로 보존하세요(병렬된 여러 chunk에 같은 역할을 각각 부여, 하나로 뭉개지 마세요).
- 주어가 생략된 경우(명령문, 분사구문 등) 존재하지 않는 단어를 원문에 추가해서 만들어내지 마세요 — 그 chunk의 role은 null로 두세요.
- 예쁘게 보이도록 태그를 만들어내지 말고, 문법적으로 정확한 분석만 하세요. 틀리게 확신하는 것보다 애매하면 null이 낫습니다.
- 각 chunk의 "order"는 1부터 시작해 문장 안에서 끊김·중복 없이 연속되는 정수여야 합니다.

[Clause(절) 식별]
문장 안에서 다음 구조가 실제로 존재할 때만 clauses[]에 담으세요(startChunkIdx/endChunkIdx는 위에서 만든 chunks 배열의 1-based order 기준 범위): 명사절 / 관계대명사절 / 관계부사절 / 부사절 / 분사구문 / to부정사구 / 동명사구 / 전치사구 / 병렬구조 / 삽입구조 / 동격 / 비교구문 / 가주어-진주어 / 가목적어-진목적어 / 5형식 구조 / 수동태. 지문에 실제로 없는 구조를 교육과정에 있다는 이유만으로 만들어내지 마세요. 한 문장에 여러 clause가 겹칠 수 있습니다(예: 관계대명사절 안에 수동태).
각 clause를 적은 뒤, startChunkIdx~endChunkIdx가 가리키는 chunk들을 실제로 순서대로 이어 붙여 보고 그 결과가 clause의 text와 정확히 일치하는지(문장 끝 마침표/쉼표 유무 정도의 사소한 차이 제외) 스스로 다시 확인하세요 — 특히 절의 시작 지점에 그 절에 속하지 않는 앞 chunk(예: 주절의 주어)가 실수로 포함되지 않았는지, 절의 끝 지점이 실제 끝보다 한 chunk 모자라지 않는지 반드시 재확인한 뒤 답하세요.

[해석 — translation]
직역이 아니라 학생이 문장 구조(위 chunks/clauses)를 이해하면서 읽을 수 있는 자연스러운 한국어로 씁니다.

[grammarAnnotations]
문법 용어만 나열하지 말고, "왜 이렇게 해석되는지"와 "이 구조가 문장에서 무슨 역할을 하는지"를 학생에게 설명하듯 씁니다.
예: { "point": "notice + that절", "explanation": "that절이 notice의 목적어 역할을 하며 '~라는 것을 알아차리다'로 해석한다." }
문장마다 실제로 학습 가치가 있는 것만 고르세요(문장당 보통 1~3개, 억지로 채우지 마세요). 지문에 실제로 없는 문법 구조(관계대명사/수동태/분사/to부정사/동명사/가정법/도치/강조/병렬/명사절/부사절 등)를 교육과정에 있다는 이유만으로 끼워 넣지 마세요.

[vocabAnnotations]
사전적 의미가 아니라 이 문맥에서의 의미를 우선합니다. 모든 단어를 넣지 말고, 수업에서 실제로 짚어줄 가치가 있는 어휘·숙어·구문만 선별하세요.
예: { "expression": "replace A with B", "meaning": "A를 B로 대체하다" }

[testablePoints]
grammarAnnotations/vocabAnnotations와 내용이 겹칠 수 있지만, 목적이 다릅니다 — "이 문장에서 실제 시험 문제로 만들기 좋은 포인트"만 별도로 고르세요. 없는 문장은 빈 배열로 둡니다.

[Passage-level — passageLevel]
- topicKo/topicEn: 지문 전체의 주제. 영어 topic도 가능하면 함께 제공하세요.
- summary: 핵심만 담은 한국어 요약(불필요한 세부사항 나열 금지).
- flow: 지문의 실제 논리 전개를 분석해서 단계별로 나누세요. 단계 수는 지문 구조에 따라 3~7개 사이에서 동적으로 정하세요 — 모든 지문을 똑같은 단계 수나 똑같은 라벨(현상/원인/결과...)로 강제하지 마세요. 그 지문에 실제로 맞는 라벨을 쓰세요.
- levelGrammarPoints: 아래 [학년]을 기준으로, 이 지문에 실제로 나타나고 그 학년 학생에게 학습 가치가 있는 문법만 선별하세요. 같은 지문이라도 학년이 다르면 선별 결과가 달라질 수 있습니다 — 그 학년 교육과정에 없는 문법을 억지로 만들어내지 마세요. 모든 문법을 나열하지 마세요. 참고 가능한 대주제 예시: 문장의 기본 구조/품사/문장성분/시제/조동사/수동태/부정사/동명사/분사/관계사/접속사/명사절/부사절/조건문/가정법/비교/일치/도치/강조/병렬/준동사 종합. **각 항목의 sentenceIndices는 실제로 그 문법이 grammarAnnotations에 등장하는 sentences[].index와 정확히 일치해야 합니다** — 존재하지 않는 문장 번호를 넣으면 이 응답 전체가 폐기됩니다.

[paragraphs / vocabulary / examPoints]
기존과 같은 방식으로 채웁니다 — paragraphs는 문단별 핵심내용/전개방식/역할/앞뒤 관계, vocabulary는 지문 전체 핵심 어휘 사전(문맥 의미 우선), examPoints는 이 지문으로 실제 시험을 만든다면 어디를 어떻게 출제할 수 있는지.

[JSON 스키마]
{
  "title": "지문 제목(영어 원제 또는 적절한 제목)",
  "passageLevel": {
    "topicKo": "...", "topicEn": "...", "summary": "...",
    "flow": [ { "step": 1, "label": "...", "description": "..." } ],
    "levelGrammarPoints": [ { "category": "...", "description": "...", "sentenceIndices": [1, 4] } ]
  },
  "paragraphs": [
    { "index": 1, "mainContent": "...", "developmentType": "예: 도입/전개/예시/결론", "role": "글 전체에서의 역할", "relationToAdjacent": "앞/뒤 문단과의 관계" }
  ],
  "sentences": [
    {
      "index": 1,
      "originalText": "문장 원문 그대로",
      "chunks": [ { "text": "구간 텍스트", "role": "S 또는 V/O/C/M/null", "order": 1 } ],
      "clauses": [ { "type": "예: noun clause/relative clause/passive 등", "text": "해당 구간 텍스트", "startChunkIdx": 1, "endChunkIdx": 1 } ],
      "translation": "자연스러운 해석",
      "grammarAnnotations": [ { "point": "...", "explanation": "..." } ],
      "vocabAnnotations": [ { "expression": "...", "meaning": "..." } ],
      "testablePoints": [ { "point": "...", "note": "..." } ]
    }
  ],
  "vocabulary": [
    { "word": "단어", "pos": "품사", "contextualMeaning": "문맥상 의미", "synonyms": [], "antonyms": [], "importance": "상|중|하" }
  ],
  "examPoints": [
    { "type": "예: 빈칸/어법/어휘/순서/삽입/일치/주제·요지/서술형/영작", "description": "구체적으로 어디를 어떻게 출제할 수 있는지" }
  ]
}`;

function buildReadingAnalyzePrompt({ passage, grade, difficulty }) {
  return `[지문]
${passage}

[학년] ${grade || "지정 없음"}
[난이도] ${difficulty || "지정 없음"}

위 지문을 문장 단위부터 전체 구조까지 빠짐없이 분석해서, JSON 스키마 형식으로만 답하세요. [학년]을 passageLevel.levelGrammarPoints 선별에 실제로 반영하세요.`;
}

// Question Generator (Reading Analysis 재설계) — READING_GENERATE_SYSTEM_PROMPT와 거의 동일한
// 구조지만, 지문 원문뿐 아니라 이미 만들어진 Passage Analysis 결과(문장 구조/문법포인트/어휘 등)를
// 함께 참고 자료로 받아 더 정확한 문제를 유도한다.
const READING_ANALYSIS_GENERATE_SYSTEM_PROMPT = `당신은 한국 중·고등학교 영어 내신 및 수능 대비 독해 문제를 만드는 전문 교육 평가 개발자입니다.
주어진 영어 지문과, 그 지문을 미리 분석해 둔 자료(문장 구조/문법 포인트/어휘/출제 포인트)를 참고해서 조건(문제 유형/난이도)에 맞는 새 문제를 만듭니다.

[작업 순서]
1) 반드시 주어진 지문 내용에 근거한 문제만 만드세요 — 지문에 없는 내용을 정답 근거로 쓰면 안 됩니다.
2) 분석 자료의 examPoints/grammarExpressionPoints에 이미 표시된 출제 포인트가 요청된 문제 유형과 맞으면 우선적으로 활용하세요. 맞는 게 없으면 지문을 직접 다시 살펴 적절한 지점을 고르세요.
3) 주어진 문제 유형에 맞는 형식으로 만드세요.
4) 요청받은 난이도 수준에 맞게 만드세요.
5) 문제를 만든 뒤 스스로 재검토하세요: 정답이 지문 근거로 명확히 하나뿐인가? 오답도 그럴듯한가?
6) 해설(explanation)에는 지문의 어느 부분이 근거인지 짧게 밝히세요.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식의 배열로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON 배열만 출력합니다.
- 객관식이면 보기 4개(정답 1개 + 오답 3개)를 만드세요. "answer"는 choices 배열의 정답 인덱스(0부터 시작)입니다.
- 서술형이면 보기 없이 모범 답안 텍스트만 "answer"에 담으세요.
- 요청받은 개수만큼 정확히 만들고, 문제끼리 서로 겹치지 않게 만드세요.

[JSON 스키마] (배열)
[
  {
    "type": "mc 또는 subjective",
    "q": "문제 지시문",
    "choices": ["보기1", "보기2", "보기3", "보기4"],
    "answer": 0,
    "explanation": "지문 근거를 밝히는 해설"
  }
]
(type이 subjective이면 "choices"는 빈 배열로, "answer"에는 정답 텍스트를 문자열로 담으세요.)`;

function buildReadingAnalysisGeneratePrompt({ passageText, analysis, questionTypeLabel, difficultyLabel, count }) {
  const analysisSummary = analysis
    ? `[분석 자료 요약]
주제: ${(analysis.core && analysis.core.topic) || "-"}
요지: ${(analysis.core && analysis.core.mainIdea) || "-"}
문법 포인트: ${(analysis.grammarExpressionPoints || []).map((g) => g.category).join(", ") || "-"}
출제 포인트: ${(analysis.examPoints || []).map((e) => `${e.type}(${e.description})`).join(" / ") || "-"}
`
    : "";
  return `[지문]
${passageText}

${analysisSummary}
[생성 조건]
문제 유형: ${questionTypeLabel || "지정 없음"}
난이도: ${difficultyLabel || "지정 없음"}

위 지문에 대해 조건에 맞는 새 문제를 정확히 ${count}개 만들어 주세요. JSON 배열 형식으로만 답하세요.`;
}

// Reading Library 단어 클릭 뜻풀이(2026-08-26) — 예전엔 프론트가 Google Translate 공개 엔드포인트를
// 직접 두 번 불러서(문장 전체 번역 + 단어 사전 후보) 후보 뜻 중 문장 번역에 우연히 겹치는 접두 글자를
// 찾는 휴리스틱으로 뜻을 골랐다. 활용형(studies/ran/children 등)은 사전 후보 자체가 안 나와 실패하고,
// 다의어는 "우연히 앞 1~2글자가 겹치는 후보"를 고르다 보니 문맥과 다르거나 품사가 틀린 뜻이 잡히는 일이
// 잦았다 — 원인이 명확한 만큼 API 하나 더 얹는 대신 통째로 교체한다. 이 문장에서 실제로 쓰인 의미를
// AI가 한 번에 원형(lemma)·품사·문맥 의미까지 같이 판단하게 해서, 활용형/다의어/품사 문제를 같은
// 원인(표면형만 보고 후보를 고르는 방식)에서 한꺼번에 없앤다.
const WORD_MEANING_SYSTEM_PROMPT = `당신은 한국 중·고등학생의 영어 리딩 학습을 돕는 사전 도우미입니다. 학생이 영어 지문을 읽다가 모르는 단어를 클릭했고, 그 단어가 등장한 문장이 함께 주어집니다.

[중요 규칙]
- 반드시 아래 JSON 스키마로만 답하세요. 설명, 인사말, 코드블록 기호(\`\`\`) 없이 순수 JSON만 출력합니다.
- "lemma"에는 그 단어의 사전 원형(기본형)을 쓰세요. 예: studies→study, ran→run, children→child, mice→mouse, better(비교급)→good.
- "partOfSpeech"에는 주어진 문장에서 실제로 쓰인 품사를 다음 중 하나의 영어 약어로만 쓰세요: n., v., adj., adv., prep., conj., pron., interj., phrase.
- "meaningKo"에는 그 문장 속에서 쓰인 의미에 정확히 맞는 아주 짧은 한국어 뜻만 쓰세요(사전 표제어 뜻처럼 1~6글자 안팎 — 문장 번역이 아닙니다). 그 단어가 여러 뜻을 가질 수 있어도, 반드시 주어진 문장의 문맥에 맞는 뜻 하나만 고르세요.
- 클릭된 단어가 오탈자이거나, 고유명사이거나, 문장 안에 실제로 없거나, 뜻을 확신할 수 없는 경우: "meaningKo"를 빈 문자열("")로 두고 "confidence"를 "low"로 하세요. 모르면 모른다고 답하세요 — 확실하지 않은 뜻을 지어내지 마세요.
- "confidence"는 "high"(문맥상 뜻이 확실함) / "medium"(대체로 확실하나 문맥 정보가 부족함) / "low"(불확실하거나 판단 불가) 중 하나입니다.

[JSON 스키마]
{ "lemma": "사전 원형", "partOfSpeech": "n.|v.|adj.|adv.|prep.|conj.|pron.|interj.|phrase", "meaningKo": "문맥에 맞는 짧은 한국어 뜻 또는 빈 문자열", "confidence": "high|medium|low" }`;

// Reading Log(독서 기록) 제출 검증(2026-08-26) — reading-library.html 전용. "단어 나열/짧은 감상"
// 수준의 제출을 막아야 하는데, 글자 수만 세는 방식은 "초콜릿에 대한 글이다. 재미있었다."처럼
// 마침표가 있는 두 "문장"도 통과시켜버려 요구사항("단순 글자 수만으로 판단하지 마라")을 못
// 지킨다. 완전한 문장 구조인지·실제 지문 내용이 담겼는지·자신의 생각이 있는지는 결국 의미
// 판단이 필요한 일이라, wordMeaning과 같은 방식으로 AI에게 맡긴다 — 문법 오류만으로는 불합격
// 처리하지 않도록(§13) 프롬프트에 명시했다. 정확한 불합격 안내 문구는 프론트가 레벨별로
// 고정된 문구를 직접 보여주므로(교사가 검수한 정확한 워딩을 그대로 유지하기 위해), 여기서는
// valid 여부만 판단해서 돌려준다.
const JOURNAL_VALIDATE_SYSTEM_PROMPT = `당신은 한국의 영어 학원에서 학생이 제출한 "독서 기록(Reading Log)"이 충분한 성실도로 작성됐는지 판단하는 채점 보조원입니다. 이 판단은 문법 시험이 아니라, 글을 실제로 읽고 이해했는지와 자신의 생각을 담았는지를 확인하는 것이 목적입니다.

[레벨별 기준]
- level이 1~4이면 한국어로 작성된 답변을 심사합니다. 반드시 완전한 문장으로 쓰여 있어야 하고, 단어나 짧은 구절 나열(예: "초콜릿", "재미있었다"), 또는 내용이 없는 짧은 문장 나열(예: "초콜릿에 대한 글이다. 재미있었다.")은 불합격입니다. 글의 실제 내용(중요한 정보)에 대한 구체적인 설명과 학생 자신의 생각이 함께 담겨 있어야 합격입니다.
- level이 5 이상이면 영어로 작성된 답변을 심사합니다. 전체 답변을 합쳐 최소 5~7개의 완전한 문장이어야 하고, summary(요약) + 구체적인 세부 내용 + 설명 + 자신의 생각이 모두 포함돼야 합격입니다. "I liked it. It was interesting." 처럼 내용 없는 짧은 감상이나, 지문 문장을 그대로 베낀 것으로 보이면 불합격입니다.

[중요 — 하지 말아야 할 것]
- 문법 오류가 조금 있다고 불합격시키지 마세요(특히 영어 답변). 의미가 통하고 위 기준을 충족하면 합격입니다.
- 글자 수만으로 판단하지 마세요 — 문장 구조와 실제 내용이 담겼는지를 함께 보세요.

반드시 아래 JSON 스키마로만 답하세요. 설명이나 다른 텍스트 없이 순수 JSON만 출력합니다.
{ "valid": true 또는 false }`;

function buildJournalValidatePrompt({ level, journalAnswers }) {
  const qa = journalAnswers.map((a, i) => `Q${i + 1}. ${a.q}\nA${i + 1}. ${a.a || "(빈 답변)"}`).join("\n\n");
  return `학생 레벨: ${level}\n\n제출한 답변:\n${qa}\n\n위 기준에 따라 이 독서 기록이 합격인지 판단해 JSON으로만 답하세요.`;
}

function buildWordMeaningPrompt({ word, sentence }) {
  return `단어: "${word}"
문장(문맥): "${sentence}"

위 문장에서 "${word}"가 실제로 쓰인 의미를 분석해 JSON으로만 답하세요.`;
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

// 월말 리포트 작성 보조. 선생님이 대충 적은 메모를 학부모님께 보낼 문장으로 다듬는다.
const REPORT_MODEL = "claude-haiku-4-5-20251001";

const REPORT_SYSTEM_PROMPT = `당신은 한국의 영어 학원(Sarah's English)에서 학부모님께 보내는 월말 리포트 작성을 돕는 보조원입니다.
선생님이 대충 적어준 메모(축약어, 단어 나열, 문장 조각이어도 괜찮음)를 자연스럽고 따뜻한 존댓말 문장으로 다듬어, 학부모님께 그대로 전달할 수 있는 리포트 문장으로 완성합니다.

[중요 규칙]
- 반드시 아래 JSON 스키마 형식으로만 답하세요. 설명, 인사말, 코드블록 기호 없이 순수 JSON만 출력합니다.
- 선생님이 메모에 적지 않은 사실을 새로 지어내지 마세요. 문장을 자연스럽게 다듬고 정리하는 것이 역할이지, 없는 내용을 추가하는 게 아닙니다.
- 메모가 "(메모 없음)"으로 표시된 항목은 빈 문자열("")로 그대로 두세요. 억지로 채우지 마세요.
- 문체는 학부모님께 보내는 공손하고 따뜻한 존댓말로 통일하세요 ("~했습니다", "~합니다" 체). 학생 이름 뒤에는 "~이는/~는"을 자연스럽게 붙여 불러주세요 (예: 이름이 "태연"이면 "태연이는", "민지"면 "민지는").

- "content"(이번 달 학습 내용)는 배운 항목을 하나하나 전부 나열하지 말고, 비슷한 것끼리 묶어서 큰 흐름으로 요약하세요.
  예: 메모에 "명사의 인칭 구분, be동사, 일반동사, 의문사, 선택의문문, 부가의문문, 명령문, 청유문, 감탄문"이 있다면
  → "인칭 구분과 다양한 동사, 그리고 의문사·명령문 등 다양한 문장 형태에 대해 학습했습니다" 처럼 상위 개념으로 묶어서 표현하세요.

- "comment"(선생님 종합 코멘트)는 아래 예시처럼 여러 문단으로, 구체적이고 진심이 담긴 톤으로 씁니다. 학생의 가장 큰 장점으로 시작해서, 최근 눈에 띄는 성장, 아쉬운 점(있다면 안심시키는 톤으로), 선생님의 지도 방식이나 노력, 마무리 격려 순서로 자연스럽게 이어가세요. 반드시 메모에 있는 내용만 바탕으로 쓰되, 이 예시의 분량과 어조를 참고하세요 (메모가 이 예시만큼 풍부하지 않으면 억지로 늘리지 말고, 메모 안에서 이 정도 톤과 정성으로만 다듬으세요):
"""
태연이의 가장 큰 장점은 변함없는 성실함입니다. 숙제와 복습을 꾸준히 해오고 있는 덕분에, 제가 처음 계획했던 학습 플랜대로, 오히려 그 이상으로 순조롭게 성장하고 있습니다.

최근에는 문법에 대한 이해도가 눈에 띄게 높아졌고, 독해를 할 때 해석하는 속도와 글을 읽는 속도, 문제를 푸는 속도까지 전반적으로 많이 향상되었습니다. 수업 시간에도 항상 밝고 적극적으로 참여하는 모습이 너무 좋고, 무엇보다 영어에 대한 자신감이 점점 생기고 있다는 것이 느껴집니다. 영어는 자신감이 실력으로 이어지는 과목인 만큼, 지금의 흐름이 매우 긍정적입니다.

현재 부족한 부분이 있다면 아직 품사를 완벽하게 구분하지 못해 해석하면서 잠시 헷갈리는 경우가 있습니다. 하지만 이 부분은 앞으로 문법에서 더 자세하게 배우게 되는 내용이기 때문에 지금 단계에서는 크게 걱정하지 않으셔도 됩니다. 차근차근 배우면서 자연스럽게 해결될 부분입니다.

지금처럼만 꾸준히 해준다면 앞으로의 성장도 정말 기대됩니다. 집에서도 태연이의 성실함을 많이 칭찬해 주세요ㅎㅎ 😊
"""

[JSON 스키마]
{
  "content": "이번 달 학습 내용 정리",
  "good": "칭찬할 점",
  "improve": "보완할 점",
  "comment": "선생님 종합 코멘트",
  "nextMonth": "다음 달 학습 방향"
}`;

function buildReportPrompt({ studentName, month, rough }) {
  const r = rough || {};
  return `[학생] ${studentName || ""}
[리포트 대상 월] ${month || ""}

[선생님이 적은 메모 — 이걸 자연스러운 리포트 문장으로 다듬어 주세요]
- 이번 달 학습 내용: ${r.content || "(메모 없음)"}
- 칭찬할 점: ${r.good || "(메모 없음)"}
- 보완할 점: ${r.improve || "(메모 없음)"}
- 선생님 종합 코멘트: ${r.comment || "(메모 없음)"}
- 다음 달 학습 방향: ${r.nextMonth || "(메모 없음)"}

위 메모들을 각각 다듬어서 JSON 스키마 형식으로만 답하세요. "(메모 없음)"으로 표시된 항목은 빈 문자열로 반환하세요.`;
}

// 정답표 PDF가 텍스트가 아니라 벡터 윤곽선(디자인 파일에서 흔함)으로만 되어 있어서
// 로컬 텍스트 파서(extractPdfTextForKeys)가 아무것도 못 읽어낼 때 쓰는 AI 비전 파싱 폴백.
// 문항 수가 많은 정답표(예: 45문항 x 30회, 2페이지)에서 신뢰도가 중요해서 haiku가 아니라 sonnet을 쓴다.
const EXAM_KEY_MODEL = "claude-sonnet-5";

const EXAM_KEY_SYSTEM_PROMPT = `당신은 한국 영어 학원에서 쓰는 정답표(모의고사/문제집 answer key) PDF를 읽고 구조화된 데이터로 바꿔주는 보조원입니다.
주어진 PDF는 객관식 정답표이며, 여러 개의 독립된 "블록"(세트)으로 나뉘어 있습니다. 각 블록 안에는 문항 번호(01, 02... 또는 001, 002...)와 정답(①~⑤ 중 하나, 동그라미 숫자)이 순서대로 나열되어 있습니다. 블록마다 문항 수는 제각각입니다 (12개일 수도 45개, 134개일 수도 있음).

책마다 블록을 나누는 방식이 다릅니다. 아래 두 가지 패턴이 모두 나올 수 있으니, PDF를 보고 실제 구조에 맞게 판단하세요:
1) "N회" 형태의 모의고사 회차별 정답표 (예: "01회", "13회 2023학년도 9월 모의평가", "1회 20분 미니모의고사"). 이 경우 각 회차 전체가 하나의 블록입니다.
2) 유형별/단원별 문제집 정답표. 이런 책은 보통 계층 구조를 가집니다:
   - 최상위: "편" 구분 (예: "어법편", "어휘편") — 이 자체는 블록이 아니라 상위 분류 라벨입니다.
   - 그 아래: "Ⅰ. 문장의 기초", "01. 글의 목적 파악" 같은 로마숫자/아라비아숫자 대단원 — 정답 블록의 기준 단위입니다.
   - 대단원 안에서 다시 "2026학년도", "2022~2025학년도" 같은 연도 구간, 또는 "경찰대/사관학교 입학시험" 같은 별도 보너스 문제 구간으로 한 번 더 나뉘기도 합니다. 이런 경우 연도 구간/보너스 구간 각각이 독립된 블록입니다 (문항 번호가 001부터 다시 시작함).
   - 이때 각 블록의 name은 "편 이름(있다면) + 대단원 이름 + 하위 구분"을 조합해서 명확하게 만드세요. 예: "어법편 Ⅰ. 문장의 기초", "어법편 Ⅰ. 문장의 기초 (경찰대/사관학교 입학시험)", "01. 글의 목적 파악 (2026학년도)", "01. 글의 목적 파악 (2022~2025학년도)".

[중요 규칙]
- 반드시 아래 JSON 스키마(배열) 형식으로만 답하세요. 설명, 인사말, 코드블록 기호 없이 순수 JSON만 출력합니다. 들여쓰기나 불필요한 공백 없이 최대한 압축된 형태로 출력하세요 (응답 길이를 아끼기 위함입니다).
- PDF의 모든 페이지, 모든 블록을 빠짐없이, PDF에 나온 순서 그대로 추출하세요. 페이지가 여러 장이면 마지막 페이지 마지막 블록까지 절대 빠뜨리지 마세요.
- 각 블록의 정답은 문항 번호 순서대로(01번 또는 001번부터) 배열에 담으세요. ①=1, ②=2, ③=3, ④=4, ⑤=5로 숫자만 담습니다.
- "문제편 p.2", "해설편 p.11" 같은 페이지 표기는 이름에 포함하지 마세요. 이런 텍스트는 블록 경계 판단에 참고만 하고 name에는 넣지 않습니다.
- 매우 중요: 각 블록마다 마지막 문항 번호(예: 45번, 134번)와 answers 배열의 길이가 반드시 일치해야 합니다. 동그라미 숫자를 하나하나 신중하게 확인하고, 문항 번호를 놓치거나 중복 세지 않도록 표의 각 줄을 순서대로 처음부터 끝까지 훑으세요. 숫자를 잘못 읽으면 실제 학생 채점이 틀리게 되므로 정확도가 무엇보다 중요합니다.
- 같은 책 안에서도 블록마다 문항 수가 다를 수 있으니, 앞선 블록의 문항 수를 기준으로 추측하지 말고 매 블록에 실제로 보이는 마지막 문항 번호를 그대로 따르세요.
- 가장 흔한 실수: 정답표는 한 블록 안에서도 여러 개의 세로줄(열)로 나뉘어, "각 열을 위에서 아래로 다 읽은 뒤 오른쪽 열로 넘어가는" 순서로 인쇄된 경우가 매우 많습니다 (예: 45문항이 9행×5열로 배치되어 1~9번이 첫 번째 열, 10~18번이 두 번째 열...). 이걸 화면에 보이는 그대로 위→아래, 왼쪽→오른쪽으로 단순히 훑으면서 동그라미만 순서대로 나열하면 번호와 답이 서로 뒤섞여 완전히 틀린 정답표가 만들어집니다. 반드시 각 동그라미 정답 바로 옆(또는 위)에 인쇄된 문항 번호 라벨(01, 02, 03...)을 하나하나 직접 확인해서 "이 답은 정확히 몇 번 문항의 답인가"를 먼저 확정한 다음, 그 번호 기준으로 오름차순 정렬한 answers 배열을 만드세요. 절대 눈에 보이는 픽셀 순서만 믿고 번호를 추측하지 마세요.
- 최종 출력 전에 스스로 검산하세요: answers 배열의 i번째 값(0-indexed이므로 i+1번 문항)이 실제로 PDF에서 "i+1"이라는 번호 옆에 인쇄된 동그라미 숫자와 일치하는지, 몇 개 지점을 무작위로 골라 다시 대조해 보세요.
- 답변에 <thinking> 같은 내부 태그나 메타 설명을 절대 포함하지 마세요. 오직 JSON 배열만 출력합니다.

[JSON 스키마]
[{"name":"01회","answers":[5,1,2,4,3,5,2,1,3,1,1,2]},{"name":"어법편 Ⅰ. 문장의 기초","answers":[3,4,5,3,5]},{"name":"어법편 Ⅰ. 문장의 기초 (경찰대/사관학교 입학시험)","answers":[5,3,5,2,2]}]`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function stripFences(text) {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// On hard extraction tasks the model sometimes narrates a self-correction ("다시 확인해보니...")
// before settling on a final JSON array instead of outputting pure JSON as instructed. When that
// happens, recover the LAST top-level [...] array in the text (its final answer) by scanning
// backward from the last "]" and bracket-matching to find where that array actually starts.
function extractLastJsonArray(text) {
  const lastClose = text.lastIndexOf("]");
  if (lastClose === -1) return null;
  let depth = 0;
  for (let i = lastClose; i >= 0; i--) {
    if (text[i] === "]") depth++;
    else if (text[i] === "[") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, lastClose + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Reading Analysis "분석노트" 재설계(Phase B-2, 2026-08-26 설계 승인) — 저장 전 서버 측(Cloud
// Function) 무결성 검증. AI가 스키마에 맞는 JSON을 반환했다는 것과, 그 내용이 실제로 원문/구조와
// 정확히 대응한다는 것은 별개다 — 프롬프트 지시만으로는 보장 안 되므로 여기서 결정적으로
// 재검증한다(§2~§5, "AI가 JSON을 반환했다고 해서 그대로 저장하지 마라"). 검증 실패 시 이 함수를
// 호출한 쪽이 재생성을 요청하거나 에러로 처리한다 — 이 함수 자체는 Firestore/네트워크를 전혀
// 건드리지 않는 순수 함수라서 프론트(readingAnalysisService.js)에서도 재사용 가능하지만, "서버
// 측" 요구사항이라 1차로는 aiWorker(isReadingAnalyze 핸들러)에서만 호출한다.
function validateReadingAnalysis(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") return { valid: false, errors: ["응답이 JSON 객체가 아닙니다."] };

  const sentences = Array.isArray(parsed.sentences) ? parsed.sentences : null;
  if (!sentences || sentences.length === 0) {
    return { valid: false, errors: ["sentences 배열이 없거나 비어 있습니다."] };
  }

  // Phase B-4 실측(2026-08-28, 실제 사용자 검증 실패 리포트 기반)에서 발견 — 원문(pasted from
  // PDF/Word 등)에 타이포그래피 인용부호(’ ‘ “ ”)나 en/em dash(– —)가 섞여 있으면, 모델이
  // originalText는 그대로 옮기면서도 chunks[].text 안에서는 자기 기본 타이포그래피(직선따옴표
  // '/", 하이픈 -)로 슬쩍 바꿔 쓰는 경우가 실측에서 나왔다 — 단어/부호 "종류"는 그대로인데
  // 문자 인코딩만 달라 §2가 오탐지했다. 위 punctuation-spacing 케이스와 같은 종류의 순수 표기
  // 차이이므로(단어 삭제/추가/순서변경은 여전히 그대로 잡힘) 비교 전에 동일 문자로 통일한다.
  function normTypography(s) {
    return String(s || "")
      .replace(/[‘’′]/g, "'")
      .replace(/[“”″]/g, '"')
      .replace(/[–—−]/g, "-")
      .replace(/…/g, "...");
  }
  function norm(s) {
    return normTypography(s).replace(/\s+/g, " ").trim();
  }
  // Phase B-3 실측(2026-08-26)에서 발견 — chunk 경계에 걸친 문장부호(,.;:!?) 앞에 공백이 끼는
  // 경우가 실제로 나왔다(예: AI가 "gardens," 대신 "gardens"+","를 별도 chunk로 낸 경우
  // join(" ")하면 "gardens , which"가 됨). 단어/부호 자체는 안 바뀌고 공백 위치만 다른 것이므로
  // §2가 명시적으로 허용한 "일반적인 whitespace normalization" 범위 — 단어 삭제/추가/순서변경/
  // 부호 자체 변경은 이걸로 절대 가려지지 않는다(부호가 아예 없어지거나 다른 부호로 바뀌는 건
  // 여전히 그대로 잡힘).
  function normPunctSpacing(s) {
    return norm(s).replace(/\s+([,.;:!?])/g, "$1");
  }

  const sentenceIndexSet = new Set();

  sentences.forEach((sent, sIdx) => {
    const label = `sentences[${sIdx}]` + (sent && typeof sent.index === "number" ? ` (index=${sent.index})` : "");

    if (!sent || typeof sent.index !== "number") {
      errors.push(`${label}: index가 없거나 숫자가 아닙니다.`);
      return;
    }
    if (sentenceIndexSet.has(sent.index)) errors.push(`${label}: index가 다른 문장과 중복됩니다.`);
    sentenceIndexSet.add(sent.index);

    const chunks = Array.isArray(sent.chunks) ? sent.chunks : null;
    if (!chunks || chunks.length === 0) {
      errors.push(`${label}: chunks가 없거나 비어 있습니다.`);
      return;
    }

    // §3 — chunks order: 1..N 연속(중복/누락/순서뒤바뀜 전부 실패)
    const orders = chunks.map((c) => c && c.order);
    const expectedOrders = chunks.map((_, i) => i + 1);
    const sortedOrders = [...orders].sort((a, b) => a - b);
    const orderOk = orders.every((o) => typeof o === "number") && JSON.stringify(sortedOrders) === JSON.stringify(expectedOrders);
    if (!orderOk) {
      errors.push(`${label}: chunks[].order가 1~${chunks.length} 연속이 아닙니다 (받은 값: ${JSON.stringify(orders)}).`);
    }

    // §2 — originalText ↔ chunks 결합: whitespace(+구두점 앞 공백) 차이만 허용, 그 외 불일치는 전부 실패
    const joinedChunks = normPunctSpacing(chunks.map((c) => c && c.text).join(" "));
    const originalNorm = normPunctSpacing(sent.originalText);
    if (joinedChunks !== originalNorm) {
      errors.push(`${label}: chunks 결합 결과가 originalText와 다릅니다.\n    originalText: "${originalNorm}"\n    chunks 결합 : "${joinedChunks}"`);
    }

    // §4 — clauses index 범위 + (best-effort) text 논리적 일치
    // 문장 끝(또는 chunk 경계)의 마침표/쉼표를 clause.text 자체에 포함시킬지는 AI마다 표기가
    // 갈린다(예: endChunkIdx가 가리키는 chunk에 "...together."처럼 마침표가 붙어 있어도
    // clause.text는 "...together"로 깔끔하게 적는 경우가 실측에서 흔했다) — 절 범위/내용이
    // 실제로 맞는지가 중요하지, 마지막 부호 표기 여부는 아니므로 이 비교에서만 문장 끝 부호를
    // 추가로 무시한다(§7 "가능한 범위에서 검증" — 원문 자체의 무결성은 위 originalText 비교가
    // 이미 훨씬 엄격하게 담당).
    function stripTrailingPunct(s) {
      return s.replace(/[,.;:!?]+$/, "");
    }
    const clauses = Array.isArray(sent.clauses) ? sent.clauses : [];
    clauses.forEach((cl, cIdx) => {
      const clLabel = `${label}.clauses[${cIdx}]`;
      if (!cl || typeof cl.startChunkIdx !== "number" || typeof cl.endChunkIdx !== "number") {
        errors.push(`${clLabel}: startChunkIdx/endChunkIdx가 없습니다.`);
        return;
      }
      if (cl.startChunkIdx < 1 || cl.endChunkIdx > chunks.length || cl.startChunkIdx > cl.endChunkIdx) {
        errors.push(`${clLabel}: 범위(${cl.startChunkIdx}~${cl.endChunkIdx})가 실제 chunk 범위(1~${chunks.length})를 벗어납니다.`);
        return;
      }
      const rangeText = normPunctSpacing(chunks.slice(cl.startChunkIdx - 1, cl.endChunkIdx).map((c) => c && c.text).join(" "));
      const clauseTextNorm = normPunctSpacing(cl.text);
      if (stripTrailingPunct(clauseTextNorm) !== stripTrailingPunct(rangeText)) {
        errors.push(`${clLabel}: text("${clauseTextNorm}")가 startChunkIdx~endChunkIdx 구간의 chunk 결합("${rangeText}")과 일치하지 않습니다.`);
      }
    });
  });

  // §5 — passageLevel.levelGrammarPoints[].sentenceIndices가 실제 존재하는 sentences[].index만
  // 가리키는지 검증. 존재하지 않는 인덱스가 하나라도 있으면 전체 실패("이 부분은 UI에서 클릭 →
  // 해당 문장으로 이동하는 핵심 데이터다").
  const levelGrammarPoints = parsed.passageLevel && Array.isArray(parsed.passageLevel.levelGrammarPoints)
    ? parsed.passageLevel.levelGrammarPoints
    : [];
  levelGrammarPoints.forEach((p, pIdx) => {
    const indices = p && Array.isArray(p.sentenceIndices) ? p.sentenceIndices : [];
    indices.forEach((idx) => {
      if (!sentenceIndexSet.has(idx)) {
        errors.push(`passageLevel.levelGrammarPoints[${pIdx}] ("${p && p.category}"): 존재하지 않는 sentence index ${idx}를 가리킵니다.`);
      }
    });
  });

  return { valid: errors.length === 0, errors };
}

// Prompt wording alone can't fully guarantee the model's "changes" list stays in sync with what
// it actually marked inside transformed_html — testing found cases where a "changes" entry
// described a swap (e.g. build → develop) that the <span class="chg"> in the passage never
// applied (still just wrapped the original word), and one case where original === changed
// entirely (a leftover from the model second-guessing itself mid-generation). Rather than keep
// tuning prose to try to prevent every variant of this, cross-check deterministically: only keep
// a "changes" entry if its "changed" text actually corresponds to one of the real <span class="chg">
// contents in the passage. This can only make the list more accurate (it drops entries, never
// invents ones), so it's safe to apply unconditionally in transform mode.
function extractChgSpanTexts(html) {
  const re = /<span class="chg">([\s\S]*?)<\/span>/g;
  const out = [];
  let m;
  while ((m = re.exec(html || ""))) out.push(m[1]);
  return out;
}

function sanitizeTransformResult(parsed) {
  if (!parsed || typeof parsed.transformed_html !== "string") return parsed;
  const spanTexts = extractChgSpanTexts(parsed.transformed_html);
  const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
  const clean = changes.filter((c) => {
    if (!c || !c.changed || !c.original || c.original === c.changed) return false;
    return spanTexts.some((s) => s && (c.changed.includes(s) || s.includes(c.changed)));
  });
  return { ...parsed, changes: clean };
}

exports.aiWorker = onRequest(
  { secrets: [ANTHROPIC_API_KEY], region: "us-central1", cors: false, timeoutSeconds: 300 },
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
    const { passage, includeAnalysis, questionTypes, level, countPerType, mode, pdfBase64, images, studentName, month, rough, sourceQuestion, count, grade,
      mainCategoryLabel, subCategoryLabel, questionTypeLabel, difficultyLabel, passageText, difficulty, analysis, word, sentence, answers } = body;
    const isTransform = mode === "transform";
    const isNelt = mode === "nelt";
    const isReport = mode === "monthlyReport";
    const isExamKey = mode === "examkey";
    const isExamVariant = mode === "examVariant";
    // Phase 7(원래 로드맵 순서상 "Sarah's Original") — Question Bank용 AI 생성 2모드. 기존 6개 모드의
    // 프롬프트/핸들러는 한 글자도 건드리지 않고 새 분기만 추가한다(ARCHITECTURE.md §14.9).
    const isGrammarGenerate = mode === "grammarGenerate";
    const isReadingGenerate = mode === "readingGenerate";
    // Reading Analysis 재설계(Phase C, 2026-08-26 설계 승인) — Passage Analysis / Question
    // Generator 2모드. Passage Variation은 새 모드 없이 기존 isTransform을 그대로 재사용한다.
    const isReadingAnalyze = mode === "readingAnalyze";
    const isReadingAnalysisGenerate = mode === "readingAnalysisGenerate";
    // Reading Library 단어 클릭 뜻풀이(2026-08-26) — reading-library.html 전용, 위 8모드와 완전히 무관.
    const isWordMeaning = mode === "wordMeaning";
    // Reading Log 제출 검증(2026-08-26) — 역시 reading-library.html 전용, 완전히 별개 기능.
    const isJournalValidate = mode === "journalValidate";

    if (!apiKey) {
      res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다. (Firebase Secret 확인)" });
      return;
    }

    if (isReport) {
      let reportRes;
      try {
        reportRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: REPORT_MODEL,
            max_tokens: 2000,
            system: REPORT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildReportPrompt({ studentName, month, rough }) }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!reportRes.ok) {
        const errText = await reportRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const reportData = await reportRes.json();
      const reportText = (reportData.content || []).map((b) => b.text || "").join("");
      let reportParsed;
      try {
        reportParsed = JSON.parse(stripFences(reportText));
      } catch {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: reportText });
        return;
      }
      res.status(200).json(reportParsed);
      return;
    }

    if (isExamKey) {
      if ((!images || images.length === 0) && !pdfBase64) {
        res.status(400).json({ error: "PDF 파일이 없습니다." });
        return;
      }
      // Prefer client-rendered high-DPI tile images (see renderPdfPageTiles in index.html) — they
      // preserve far more resolution on dense multi-column answer sheets than letting Claude's own
      // PDF-to-image conversion pick the resolution. Raw pdfBase64 is kept as a fallback only.
      const content = images && images.length > 0
        ? images.map((img) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: img } }))
        : [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }];
      content.push({
        type: "text",
        text: images && images.length > 0
          ? "이 이미지들은 같은 정답표 PDF의 각 페이지를 실제 인쇄 열(column) 경계에서 고해상도로 잘라낸 조각들입니다 (겹치는 부분 없음, 페이지 순서·좌에서 우로 정렬됨). 모든 이미지를 살펴보고, 보이는 모든 블록(회차/단원/구간)의 정답을 위 스키마대로 하나도 빠짐없이 추출해 JSON 배열로만 답하세요. 각 블록의 마지막 문항 번호와 answers 배열 길이가 일치하는지 스스로 다시 확인한 뒤 답하세요."
          : "이 정답표 PDF는 여러 페이지일 수 있습니다. 모든 페이지, 모든 블록의 정답을 하나도 빠짐없이 위 스키마대로 추출해 JSON 배열로만 답하세요. 각 블록의 마지막 문항 번호와 answers 배열 길이가 일치하는지 스스로 다시 확인한 뒤 답하세요.",
      });
      let ekRes;
      try {
        ekRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "pdfs-2024-09-25",
          },
          body: JSON.stringify({
            model: EXAM_KEY_MODEL,
            max_tokens: 16000,
            thinking: { type: "disabled" },
            system: EXAM_KEY_SYSTEM_PROMPT,
            messages: [{ role: "user", content }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!ekRes.ok) {
        const errText = await ekRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const ekData = await ekRes.json();
      const ekText = (ekData.content || []).map((b) => b.text || "").join("");
      let ekParsed;
      try {
        ekParsed = JSON.parse(stripFences(ekText));
      } catch {
        ekParsed = extractLastJsonArray(stripFences(ekText));
      }
      if (!Array.isArray(ekParsed)) {
        res.status(502).json({
          error: "AI 응답을 JSON으로 해석하지 못했습니다.",
          raw: ekText,
          debug: {
            stop_reason: ekData.stop_reason,
            usage: ekData.usage,
            blockTypes: (ekData.content || []).map((b) => ({ type: b.type, len: (b.text || "").length })),
          },
        });
        return;
      }
      res.status(200).json(ekParsed);
      return;
    }

    if (isExamVariant) {
      if (!sourceQuestion || !sourceQuestion.q) {
        res.status(400).json({ error: "원본 문제가 없습니다." });
        return;
      }
      const n = Math.max(1, Math.min(20, Number(count) || 5));
      let varRes;
      try {
        varRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4000,
            system: VARIANT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildVariantPrompt({ sourceQuestion, count: n, grade }) }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!varRes.ok) {
        const errText = await varRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const varData = await varRes.json();
      const varText = (varData.content || []).map((b) => b.text || "").join("");
      let varParsed;
      try {
        varParsed = JSON.parse(stripFences(varText));
      } catch {
        varParsed = extractLastJsonArray(stripFences(varText));
      }
      if (!Array.isArray(varParsed)) {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: varText });
        return;
      }
      res.status(200).json(varParsed);
      return;
    }

    if (isGrammarGenerate) {
      const n = Math.max(1, Math.min(20, Number(count) || 5));
      let genRes;
      try {
        genRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4000,
            system: GRAMMAR_GENERATE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildGrammarGeneratePrompt({ grade, mainCategoryLabel, subCategoryLabel, questionTypeLabel, difficultyLabel, count: n }) }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!genRes.ok) {
        const errText = await genRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const genData = await genRes.json();
      const genText = (genData.content || []).map((b) => b.text || "").join("");
      let genParsed;
      try {
        genParsed = JSON.parse(stripFences(genText));
      } catch {
        genParsed = extractLastJsonArray(stripFences(genText));
      }
      if (!Array.isArray(genParsed)) {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: genText });
        return;
      }
      res.status(200).json(genParsed);
      return;
    }

    if (isReadingGenerate) {
      if (!passageText || passageText.trim().length < 20) {
        res.status(400).json({ error: "지문이 너무 짧습니다. 20자 이상이어야 합니다." });
        return;
      }
      const n = Math.max(1, Math.min(20, Number(count) || 5));
      let rgRes;
      try {
        rgRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4000,
            system: READING_GENERATE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildReadingGeneratePrompt({ passageText, questionTypeLabel, difficultyLabel, count: n }) }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!rgRes.ok) {
        const errText = await rgRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const rgData = await rgRes.json();
      const rgText = (rgData.content || []).map((b) => b.text || "").join("");
      let rgParsed;
      try {
        rgParsed = JSON.parse(stripFences(rgText));
      } catch {
        rgParsed = extractLastJsonArray(stripFences(rgText));
      }
      if (!Array.isArray(rgParsed)) {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: rgText });
        return;
      }
      res.status(200).json(rgParsed);
      return;
    }

    if (isReadingAnalyze) {
      if (!passage || passage.trim().length < 20) {
        res.status(400).json({ error: "지문이 너무 짧습니다. 20자 이상이어야 합니다." });
        return;
      }

      // Phase B-2 §2~§5 — AI 응답을 그대로 신뢰하지 않는다. 한 번 호출해 검증하고, 실패하면
      // 딱 한 번만 재생성을 요청한다(무한 재시도로 비용이 새지 않도록). 두 번째도 실패하면
      // validation error로 응답하고 절대 저장 가능한 형태로 반환하지 않는다 — 호출한 쪽
      // (readingAnalysisService.createAnalysis)이 res.ok가 아닌 응답을 받으면 Firestore에
      // 쓰지 않는 기존 흐름을 그대로 이용한다(§2 "정상 데이터로 저장하지 마라").
      async function callAndParseOnce() {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 16000,
            system: READING_ANALYZE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildReadingAnalyzePrompt({ passage, grade, difficulty }) }],
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          throw new Error("AI 응답 오류: " + errText);
        }
        const data = await r.json();
        const text = (data.content || []).map((b) => b.text || "").join("");
        let parsed;
        try {
          parsed = JSON.parse(stripFences(text));
        } catch {
          throw new Error("AI 응답을 JSON으로 해석하지 못했습니다. raw: " + text.slice(0, 500));
        }
        return parsed;
      }

      let raParsed;
      let validation;
      try {
        raParsed = await callAndParseOnce();
        validation = validateReadingAnalysis(raParsed);
        if (!validation.valid) {
          // 재생성 1회 시도(§2 "AI에게 재생성을 요청하거나 validation error로 처리해라")
          raParsed = await callAndParseOnce();
          validation = validateReadingAnalysis(raParsed);
        }
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e.message || e) });
        return;
      }
      if (!validation.valid) {
        // 재생성까지 2번 다 실패한 원인을 서버 로그에 남긴다 — 지금까지는 클라이언트 응답의
        // detail만 있고 어디에도 기록되지 않아, 실패가 재발해도 원인을 알 방법이 없었다.
        console.error("readingAnalyze validation failed:", JSON.stringify(validation.errors));
        res.status(502).json({
          error: "AI 분석 결과가 검증을 통과하지 못했습니다(원문-chunk 불일치, chunk 순서 오류, clause 범위 오류, 또는 존재하지 않는 문장 인덱스 참조). 다시 시도해 주세요.",
          detail: validation.errors.join(" / "),
          raw: raParsed, // 디버깅용 — 검증 실패 원인을 실제 파싱 결과로 확인할 수 있도록(isExamKey의 기존 raw/debug 패턴과 동일)
        });
        return;
      }
      res.status(200).json(raParsed);
      return;
    }

    if (isReadingAnalysisGenerate) {
      if (!passageText || passageText.trim().length < 20) {
        res.status(400).json({ error: "지문이 너무 짧습니다. 20자 이상이어야 합니다." });
        return;
      }
      const n = Math.max(1, Math.min(20, Number(count) || 5));
      let ragRes;
      try {
        ragRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 4000,
            system: READING_ANALYSIS_GENERATE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildReadingAnalysisGeneratePrompt({ passageText, analysis, questionTypeLabel, difficultyLabel, count: n }) }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!ragRes.ok) {
        const errText = await ragRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const ragData = await ragRes.json();
      const ragText = (ragData.content || []).map((b) => b.text || "").join("");
      let ragParsed;
      try {
        ragParsed = JSON.parse(stripFences(ragText));
      } catch {
        ragParsed = extractLastJsonArray(stripFences(ragText));
      }
      if (!Array.isArray(ragParsed)) {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: ragText });
        return;
      }
      res.status(200).json(ragParsed);
      return;
    }

    if (isWordMeaning) {
      const w = (word || "").trim();
      const s = (sentence || "").trim();
      if (!w) {
        res.status(400).json({ error: "단어가 없습니다." });
        return;
      }
      let wmRes;
      try {
        wmRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 300,
            system: WORD_MEANING_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildWordMeaningPrompt({ word: w, sentence: s || w }) }],
          }),
        });
      } catch (e) {
        res.status(502).json({ error: "AI 서버 호출 중 오류가 발생했습니다.", detail: String(e) });
        return;
      }
      if (!wmRes.ok) {
        const errText = await wmRes.text();
        res.status(502).json({ error: "AI 응답 오류", detail: errText });
        return;
      }
      const wmData = await wmRes.json();
      const wmText = (wmData.content || []).map((b) => b.text || "").join("");
      let wmParsed;
      try {
        wmParsed = JSON.parse(stripFences(wmText));
      } catch {
        res.status(502).json({ error: "AI 응답을 JSON으로 해석하지 못했습니다.", raw: wmText });
        return;
      }
      // 모델이 스키마를 안 지켜도(필드 누락, 이상한 타입) 프론트가 그대로 신뢰하지 않도록 여기서
      // 한 번 걸러서 안전한 형태로만 내려보낸다 — hallucination을 막을 순 없어도, 최소한 잘못된
      // 타입 때문에 프론트가 깨지는 일은 막는다.
      res.status(200).json({
        lemma: typeof wmParsed.lemma === "string" ? wmParsed.lemma.trim() : "",
        partOfSpeech: typeof wmParsed.partOfSpeech === "string" ? wmParsed.partOfSpeech.trim() : "",
        meaningKo: typeof wmParsed.meaningKo === "string" ? wmParsed.meaningKo.trim() : "",
        confidence: ["high", "medium", "low"].includes(wmParsed.confidence) ? wmParsed.confidence : "low",
      });
      return;
    }

    if (isJournalValidate) {
      const lvl = Number(level) || 1;
      const ansArr = Array.isArray(answers) ? answers : [];
      if (!ansArr.some((a) => a && a.a && a.a.trim())) {
        res.status(200).json({ valid: false });
        return;
      }
      let jvRes;
      try {
        jvRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 200,
            system: JOURNAL_VALIDATE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildJournalValidatePrompt({ level: lvl, journalAnswers: ansArr }) }],
          }),
        });
      } catch (e) {
        // AI 인프라 문제로 검증 자체가 실패했을 때는 제출을 막지 않는다(fail open) — 학생이 실제
        // 내용을 성실히 썼는데 서버 오류 때문에 제출을 못 하게 되는 게 더 나쁜 실패다.
        res.status(200).json({ valid: true, degraded: true });
        return;
      }
      if (!jvRes.ok) {
        res.status(200).json({ valid: true, degraded: true });
        return;
      }
      const jvData = await jvRes.json();
      const jvText = (jvData.content || []).map((b) => b.text || "").join("");
      let jvParsed;
      try {
        jvParsed = JSON.parse(stripFences(jvText));
      } catch {
        res.status(200).json({ valid: true, degraded: true });
        return;
      }
      res.status(200).json({ valid: jvParsed.valid !== false });
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

    res.status(200).json(isTransform ? sanitizeTransformResult(parsed) : parsed);
  }
);

// ── 푸시 알림 ──
// 학생이 숙제 인증샷을 올리거나 공부 타이머를 시작하면 클라이언트가 이 엔드포인트를 직접
// 호출해서 선생님 기기로 즉시 알림을 보낸다. (Firestore 문서 변경 트리거 방식도 가능하지만,
// 이 앱은 학생/선생님이 같은 문서에 쓰기 때문에 "누가" 썼는지 문서 diff만으로는 구분할 수
// 없다 — 그래서 이벤트가 실제로 일어난 그 순간 클라이언트가 명시적으로 호출하는 방식을 쓴다.)
exports.notifyTeacher = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    const { studentName, kind, detail } = req.body || {};
    if (!studentName || !kind) { res.status(400).json({ error: "studentName, kind가 필요합니다." }); return; }

    try {
      const metaSnap = await db.collection("sarahsEnglishMeta").doc("main").get();
      const tokens = [...new Set((metaSnap.exists ? metaSnap.data().teacherFcmTokens : []) || [])];
      if (tokens.length === 0) { res.status(200).json({ sent: 0, reason: "no-teacher-tokens" }); return; }

      // title/body per event kind. `detail` (student-supplied, e.g. homework content, a score,
      // a subject+minutes string) is optional extra context used as the body when present —
      // every kind still has a sensible default body so older clients that don't send detail work fine.
      const TITLES = {
        homework_upload: `📸 ${studentName} 학생이 숙제 인증샷을 올렸어요`,
        study_start: `⏱ ${studentName} 학생이 공부를 시작했어요`,
        study_resume: `⏱ ${studentName} 학생이 공부를 이어서 시작했어요`,
        study_pause: `⏸ ${studentName} 학생이 공부를 일시정지했어요`,
        study_log_saved: `📗 ${studentName} 학생이 공부 기록을 저장했어요`,
        homework_done: `✅ ${studentName} 학생이 숙제를 완료 표시했어요`,
        mock_exam_submit: `📄 ${studentName} 학생이 모의고사 채점을 제출했어요`,
        student_login: `👋 ${studentName} 학생이 로그인했어요`,
        parent_login: `👪 ${studentName} 학생 학부모님이 로그인했어요`,
        consult_request: `💬 ${studentName} 학생 학부모님이 상담을 신청했어요`,
        level_test_booking: `🗓 ${studentName} 님이 레벨테스트·상담 예약 문의를 남겼어요`,
      };
      const DEFAULT_BODIES = {
        homework_upload: "인증샷을 확인해 보세요.",
        study_start: "공부 타이머를 시작했어요.",
        study_resume: "공부 타이머를 이어서 시작했어요.",
        study_pause: "공부 타이머를 일시정지했어요.",
        study_log_saved: "공부 기록을 저장했어요.",
        homework_done: "숙제를 완료로 표시했어요.",
        mock_exam_submit: "모의고사 결과를 저장했어요.",
        student_login: "학생용 화면에 접속했어요.",
        parent_login: "학부모용 화면에 접속했어요.",
        consult_request: "상담 신청 내용을 확인해 보세요.",
        level_test_booking: "예약 문의 내용을 확인해 보세요.",
      };
      const title = TITLES[kind] || "🔔 테스트 알림";
      const body = (detail ? String(detail).slice(0, 120) : "") || DEFAULT_BODIES[kind] || "알림이 정상적으로 도착했어요!";
      console.log("notifyTeacher", JSON.stringify({ studentName, kind, detail, title, body }));

      const resp = await admin.messaging().sendEachForMulticast({ tokens, data: { title, body } });
      res.status(200).json({ sent: resp.successCount, failed: resp.failureCount });
    } catch (e) {
      res.status(500).json({ error: "알림 전송 중 오류가 발생했습니다.", detail: String(e) });
    }
  }
);

// 선생님이 숙제/모의고사/단어 재시험을 새로 등록하면 그 학생 폰으로 바로 알림을 보낸다.
// notifyTeacher와 달리 수신 대상이 매번 다른 한 명(그 학생)이라 Firestore에서 토큰을 찾지
// 않고, 이미 로스터를 들고 있는 교사 클라이언트가 그 학생의 studentFcmToken을 그대로 실어
// 보낸다 — sendTestNotification과 같은 패턴.
exports.notifyStudent = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    const { token, kind, detail } = req.body || {};
    if (!token || !kind) { res.status(400).json({ error: "token, kind가 필요합니다." }); return; }

    const TITLES = {
      homework_assigned: "📝 새 숙제가 등록됐어요",
      mock_exam_assigned: "📄 새 모의고사가 등록됐어요",
      vocab_test_assigned: "🔤 새 단어 재시험이 등록됐어요",
    };
    const DEFAULT_BODIES = {
      homework_assigned: "숙제 내용을 확인해 보세요.",
      mock_exam_assigned: "모의고사가 등록됐어요.",
      vocab_test_assigned: "단어 재시험이 등록됐어요.",
    };
    const title = TITLES[kind] || "🔔 새 알림";
    const body = (detail ? String(detail).slice(0, 120) : "") || DEFAULT_BODIES[kind] || "새 소식이 있어요.";

    try {
      await admin.messaging().send({ token, data: { title, body } });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "알림 전송 중 오류가 발생했습니다.", detail: String(e) });
    }
  }
);

// "🔔 알림 받기" 버튼을 누른 그 순간, 방금 발급받은 토큰으로 바로 테스트 알림 하나를 보낸다.
// notifyTeacher는 항상 선생님에게만 보내므로(교사용 엔드포인트), 학생/학부모가 자기 알림
// 설정이 실제로 되는지 스스로 확인할 방법이 따로 필요해서 만든 범용 엔드포인트 —
// Firestore에 저장된 토큰을 조회하지 않고, 요청에 실린 토큰으로 즉시 보낸다.
exports.sendTestNotification = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }
    const { token } = req.body || {};
    if (!token) { res.status(400).json({ error: "token이 필요합니다." }); return; }
    try {
      await admin.messaging().send({ token, data: { title: "🔔 테스트 알림", body: "알림이 정상적으로 도착했어요!" } });
      res.status(200).json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "테스트 알림 전송 중 오류가 발생했습니다.", detail: String(e) });
    }
  }
);

// ── Phase 9-A: Teacher 로그인에 Firebase Auth 세션을 백그라운드로 붙이기 위한 배관 ──
// 기존 passcode 로그인(index.html의 TeacherLogin, sarahsEnglishMeta/main.teacherAuth.passcode를
// 클라이언트가 직접 비교) 방식은 그대로 둔다 — 이 함수는 그 로그인을 대체하지 않고, 로그인이
// 이미 성공한 뒤에 클라이언트가 추가로 호출해서 같은 passcode를 서버(Admin SDK)에서 한 번 더
// 검증하고, 맞으면 { role: "teacher" } 커스텀 클레임이 실린 Firebase Custom Token을 돌려준다.
// 이 함수가 실패해도(네트워크, 이 함수 자체 오류 등) 클라이언트 쪽 기존 로그인은 이미 끝난
// 뒤라 전혀 영향받지 않는다(index.html의 syncTeacherFirebaseAuth 참고).
// Firestore Rules는 이 Phase에서 아직 그대로 열려 있다 — 이 함수 하나만으로는 어떤 데이터
// 접근도 새로 막거나 열지 않는다. teacher 역할은 교사가 한 명뿐인 현재 구조를 그대로 반영해
// 고정 UID를 쓴다(다중 교사 계정은 이 구조의 범위 밖).
const TEACHER_AUTH_UID = "teacher";
exports.teacherLogin = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    const { passcode } = req.body || {};
    if (!passcode) { res.status(400).json({ error: "passcode가 필요합니다." }); return; }

    try {
      const metaSnap = await db.collection("sarahsEnglishMeta").doc("main").get();
      const stored = metaSnap.exists ? (metaSnap.data().teacherAuth || {}).passcode : null;
      if (!stored || passcode !== stored) {
        res.status(401).json({ error: "비밀번호가 맞지 않습니다." });
        return;
      }
      const token = await admin.auth().createCustomToken(TEACHER_AUTH_UID, { role: "teacher" });
      res.status(200).json({ token });
    } catch (e) {
      // 비밀번호/토큰 값은 절대 로그에 남기지 않는다 — 에러 코드/메시지만.
      console.error("teacherLogin error:", e && e.code, e && e.message);
      res.status(500).json({ error: "인증 토큰 발급 중 오류가 발생했습니다." });
    }
  }
);

// ── Phase 9-C: Student/Parent 로그인에도 teacherLogin과 동일한 배관을 붙인다 ──
// 기존 studentCode/parentCode 문자열 비교 로그인(index.html의 StudentParentLogin, roster를
// 클라이언트가 이미 들고 있는 방식)은 절대 바꾸지 않는다 — 이 함수는 그 로그인이 이미 성공한
// 뒤에 클라이언트가 추가로 호출해서 같은 코드를 서버(Admin SDK)에서 roster와 다시 대조하고,
// studentCode로 맞으면 role:"student", parentCode로 맞으면 role:"parent"인 Custom Token을
// 돌려준다. 두 역할이 같은 studentId를 공유하더라도 UID는 role별로 분리한다("student_"/
// "parent_" 접두사) — 학생과 학부모는 서로 다른 세션/기기로 로그인하는 별개의 신원이라, 같은
// UID를 공유시키면 나중에(9-D) "이 학생 본인만" 같은 규칙을 규칙 하나로 표현하기 어려워진다.
// 이 함수가 실패해도 기존 로그인은 이미 끝난 뒤라 전혀 영향받지 않는다(§9-A와 동일한 원칙,
// index.html의 syncStudentFirebaseAuth 참고). Firestore Rules는 이 Phase에서 손대지 않는다.
exports.studentLogin = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    const { code } = req.body || {};
    if (!code) { res.status(400).json({ error: "code가 필요합니다." }); return; }

    try {
      const metaSnap = await db.collection("sarahsEnglishMeta").doc("main").get();
      const roster = metaSnap.exists ? (metaSnap.data().roster || []) : [];
      const asStudent = roster.find((r) => r.studentCode === code);
      const asParent = !asStudent ? roster.find((r) => r.parentCode === code) : null;
      if (!asStudent && !asParent) {
        res.status(401).json({ error: "코드가 맞지 않습니다." });
        return;
      }
      const role = asStudent ? "student" : "parent";
      const studentId = (asStudent || asParent).id;
      const uid = (role === "student" ? "student_" : "parent_") + studentId;
      const token = await admin.auth().createCustomToken(uid, { role, studentId });
      res.status(200).json({ token });
    } catch (e) {
      // 코드/토큰 값은 절대 로그에 남기지 않는다 — 에러 코드/메시지만.
      console.error("studentLogin error:", e && e.code, e && e.message);
      res.status(500).json({ error: "인증 토큰 발급 중 오류가 발생했습니다." });
    }
  }
);

// ── Phase 9-D: Question Bank 보안 ──
// StudentExamRuntime/StudentExamListSection이 grammarQuestions/readingQuestions/readingPassages/
// examPapers를 통째로 직접 읽던 기존 구조(QB.listGrammarQuestions() 등, 전체 문제은행이 그대로
// 브라우저에 내려감)를 걷어내고, 이 세 함수로 좁힌다. firestore.rules는 이 네 컬렉션에 대한
// student/parent 직접 read를 전부 막으므로(아래 Rules 변경 참고), 클라이언트가 필요한 문제만
// 얻을 수 있는 유일한 경로가 이 함수들이다 — Admin SDK는 Rules를 우회하지만, 그 대신 여기서
// request.auth(ID Token)와 studentId 소유권을 직접 검증한다(이게 유일한 방어선).
//
// 정답(answer)/해설(explanation) 등 채점 관련 정보는 시험 응시 중에는 절대 내려주지 않는다 —
// getExamQuestionsForAttempt는 항상 sanitize된 필드만 반환한다. examAttemptService의 채점 로직은
// 이번 Phase에서 서버로 옮기지 않으므로(§9-D 승인 범위 — Phase 10 후보), 채점 자체는 여전히
// 클라이언트에서 일어난다. 다만 정답이 필요한 시점(제출 후 즉시 자동채점)까지는 늦춰
// getExamAnswersForGrading을 별도로 두고, 그 함수는 "이 학생 본인의 attempt"이면서 "이미
// SUBMITTED된 attempt"에 대해서만 정답을 내준다 — 응시 도중에는 어떤 경로로도 정답이 클라이언트에
// 닿지 않는다(기존 8-D 구현의 알려진 한계 — 전체 문제은행 raw 문서가 로드 시점에 이미 브라우저에
// 와 있던 것 — 를 실제로 해소한다).
async function verifyStudentOrParent(req) {
  const authHeader = req.headers.authorization || "";
  const m = /^Bearer (.+)$/.exec(authHeader);
  if (!m) {
    const err = new Error("인증 토큰이 없습니다.");
    err.status = 401;
    throw err;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    const err = new Error("인증 토큰이 유효하지 않습니다.");
    err.status = 401;
    throw err;
  }
  if (!decoded.studentId || (decoded.role !== "student" && decoded.role !== "parent")) {
    const err = new Error("학생/학부모 권한이 필요합니다.");
    err.status = 403;
    throw err;
  }
  return { uid: decoded.uid, role: decoded.role, studentId: decoded.studentId };
}

// index.html의 sanitizeQuestionForStudent()와 동일한 화이트리스트를 서버에서 한 번 더 강제한다 —
// 클라이언트 쪽 sanitize는 신뢰 경계가 아니다(이 함수가 유일한 신뢰 경계).
function sanitizeQuestionForStudentServer(qDoc) {
  return {
    id: qDoc.id,
    questionText: qDoc.questionText || "",
    choices: qDoc.choices || [],
    answerFormat: qDoc.answerFormat || "subjective",
    questionType: qDoc.questionType || "",
  };
}

// input: { assignmentId } — attemptId가 아니라 assignmentId로 키를 잡는다. 이유: 시험을 처음
// 시작할 때는 아직 attempt 문서 자체가 없고(examAttemptService.startAttempt가 클라이언트에서
// 만든다, 이번 Phase에서 손대지 않음), attempt를 만들려면 paper.sections(문제 개수 계산용)가
// 먼저 있어야 한다 — attemptId를 요구하면 최초 진입 시 순환 참조가 생긴다. assignmentId는 항상
// 이미 알고 있고(학생이 여는 배정 그 자체), 소유권 검증 기준도 동일하게 명확하다.
exports.getExamQuestionsForAttempt = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    const { assignmentId } = req.body || {};
    if (!assignmentId) { res.status(400).json({ error: "assignmentId가 필요합니다." }); return; }

    try {
      const caller = await verifyStudentOrParent(req);

      const assignSnap = await db.collection("examAssignments").doc(assignmentId).get();
      if (!assignSnap.exists) { res.status(404).json({ error: "배정을 찾을 수 없습니다." }); return; }
      const assignment = assignSnap.data();
      if (assignment.studentId !== caller.studentId) {
        res.status(403).json({ error: "본인에게 배정된 시험만 조회할 수 있습니다." });
        return;
      }

      const paperSnap = await db.collection("examPapers").doc(assignment.examPaperId).get();
      if (!paperSnap.exists || paperSnap.data().status !== "FINALIZED") {
        res.status(404).json({ error: "시험지를 찾을 수 없거나 아직 확정(FINALIZED)되지 않았어요." });
        return;
      }
      const paper = paperSnap.data();
      const sections = paper.sections || [];

      const questionIds = new Set();
      const passageIds = new Set();
      sections.forEach((s) => {
        (s.questionRefs || []).forEach((r) => questionIds.add(r.questionId));
        if (s.bank === "reading" && s.passageId) passageIds.add(s.passageId);
      });

      const [grammarSnaps, readingSnaps, passageSnaps] = await Promise.all([
        Promise.all([...questionIds].map((id) => db.collection("grammarQuestions").doc(id).get())),
        Promise.all([...questionIds].map((id) => db.collection("readingQuestions").doc(id).get())),
        Promise.all([...passageIds].map((id) => db.collection("readingPassages").doc(id).get())),
      ]);

      const questionsById = {};
      grammarSnaps.forEach((snap) => { if (snap.exists) questionsById[snap.id] = sanitizeQuestionForStudentServer({ id: snap.id, ...snap.data() }); });
      readingSnaps.forEach((snap) => { if (snap.exists) questionsById[snap.id] = sanitizeQuestionForStudentServer({ id: snap.id, ...snap.data() }); });

      const passagesById = {};
      passageSnaps.forEach((snap) => {
        if (!snap.exists) return;
        const d = snap.data();
        passagesById[snap.id] = { id: snap.id, title: d.title || "", passageText: d.passageText || "" };
      });

      res.status(200).json({
        paper: { id: paperSnap.id, title: paper.title || "", sections },
        questionsById,
        passagesById,
      });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error("getExamQuestionsForAttempt error:", e && e.code, e && e.message);
      res.status(status).json({ error: status === 500 ? "문제를 불러오는 중 오류가 발생했습니다." : e.message });
    }
  }
);

// input: { attemptId } — attempt가 "본인 것"이면서 이미 "SUBMITTED"(또는 그 이후 GRADED) 상태일
// 때만 정답을 내준다. 응시 도중(IN_PROGRESS)에는 어떤 요청을 보내도 거부된다 — 정답을 미리 훔쳐볼
// 수 없게 하는 것이 이 함수의 핵심 목적. computeGrading()이 실제로 쓰는 필드(answerFormat, answer)
// 만 반환하고 explanation/wrongChoiceExplanations 등은 애초에 포함하지 않는다(학생 화면에는 어차피
// 노출되지 않는 필드 — ExamResultDetail은 Teacher 전용, StudentDash/StudentExamRuntime에서 재사용
// 안 함).
exports.getExamAnswersForGrading = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    const { attemptId } = req.body || {};
    if (!attemptId) { res.status(400).json({ error: "attemptId가 필요합니다." }); return; }

    try {
      const caller = await verifyStudentOrParent(req);

      const attemptSnap = await db.collection("examAttempts").doc(attemptId).get();
      if (!attemptSnap.exists) { res.status(404).json({ error: "응시 기록을 찾을 수 없습니다." }); return; }
      const attempt = attemptSnap.data();
      if (attempt.studentId !== caller.studentId) {
        res.status(403).json({ error: "본인의 시험만 조회할 수 있습니다." });
        return;
      }
      if (attempt.status === "IN_PROGRESS") {
        res.status(403).json({ error: "제출 전에는 정답을 조회할 수 없습니다." });
        return;
      }

      const paperSnap = await db.collection("examPapers").doc(attempt.examPaperId).get();
      const sections = paperSnap.exists ? (paperSnap.data().sections || []) : [];
      const questionIds = new Set();
      sections.forEach((s) => (s.questionRefs || []).forEach((r) => questionIds.add(r.questionId)));

      const [grammarSnaps, readingSnaps] = await Promise.all([
        Promise.all([...questionIds].map((id) => db.collection("grammarQuestions").doc(id).get())),
        Promise.all([...questionIds].map((id) => db.collection("readingQuestions").doc(id).get())),
      ]);

      const questionsById = {};
      grammarSnaps.forEach((snap) => { if (snap.exists) questionsById[snap.id] = { id: snap.id, answerFormat: snap.data().answerFormat, answer: snap.data().answer }; });
      readingSnaps.forEach((snap) => { if (snap.exists) questionsById[snap.id] = { id: snap.id, answerFormat: snap.data().answerFormat, answer: snap.data().answer }; });

      res.status(200).json({ questionsById });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error("getExamAnswersForGrading error:", e && e.code, e && e.message);
      res.status(status).json({ error: status === 500 ? "채점 정보를 불러오는 중 오류가 발생했습니다." : e.message });
    }
  }
);

// StudentExamListSection의 "문제 N개" 표시용 — examPapers 전체가 아니라, 이 학생에게 실제로
// 배정된 examAssignments가 참조하는 시험지들의 title/totalQuestionCount만 골라서 반환한다.
// 문제 본문/정답은 이 함수에 전혀 포함되지 않는다(그건 위 두 함수만의 몫).
exports.getMyExamPaperSummaries = onRequest(
  { region: "us-central1", cors: false },
  async (req, res) => {
    const headers = corsHeaders(req.headers.origin);
    Object.entries(headers).forEach(([k, v]) => res.set(k, v));
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "POST 요청만 허용됩니다." }); return; }

    try {
      const caller = await verifyStudentOrParent(req);

      const assignSnap = await db.collection("examAssignments").where("studentId", "==", caller.studentId).get();
      const paperIds = new Set();
      assignSnap.forEach((doc) => { const d = doc.data(); if (d.examPaperId) paperIds.add(d.examPaperId); });

      const paperSnaps = await Promise.all([...paperIds].map((id) => db.collection("examPapers").doc(id).get()));
      const papers = {};
      paperSnaps.forEach((snap) => {
        if (!snap.exists) return;
        const d = snap.data();
        papers[snap.id] = { id: snap.id, title: d.title || "", totalQuestionCount: d.totalQuestionCount || 0 };
      });

      res.status(200).json({ papers });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error("getMyExamPaperSummaries error:", e && e.code, e && e.message);
      res.status(status).json({ error: status === 500 ? "시험지 정보를 불러오는 중 오류가 발생했습니다." : e.message });
    }
  }
);

// 오후 3시(한국 시간)부터 밤 11시까지 매시 정각에, 그날 마감인데 아직 완료 표시가 안 된
// 숙제와 그날 응시일인데 아직 결과가 없는 모의고사를 찾아 알림을 보낸다 (이름은 "숙제"만
// 언급하지만 모의고사 채점 제출 리마인더도 같은 스케줄로 함께 처리한다 — Cloud Scheduler
// 잡을 하나 더 만드는 대신 같은 실행에 묶었다). 학부모는 매번 알림이 가면 피로감이 크므로
// 15시 첫 실행 때 한 번만 보내고, 학생은 끝낼 때까지(= pending이 빌 때까지) 매시간 계속
// 받는다 — 완료 표시/결과 제출이 뜨는 순간 이 필터에서 자연히 빠지므로 별도의 "이미 보냈음"
// 상태를 추적할 필요가 없다.
exports.homeworkReminderCheck = onSchedule(
  { schedule: "0 15-23 * * *", timeZone: "Asia/Seoul", region: "us-central1" },
  async () => {
    const nowSeoul = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
    const isFirstRun = nowSeoul.getHours() === 15; // the 15:00 slot
    const metaSnap = await db.collection("sarahsEnglishMeta").doc("main").get();
    const roster = (metaSnap.exists ? metaSnap.data().roster : []) || [];
    const teacherTokens = [...new Set((metaSnap.exists ? metaSnap.data().teacherFcmTokens : []) || [])];
    const namesStillPending = [];

    for (const student of roster) {
      try {
        const studentSnap = await db.collection("sarahsEnglishStudents").doc(student.id).get();
        if (!studentSnap.exists) continue;
        const data = studentSnap.data();
        const pendingHw = (data.homework || []).filter((h) => h.dueDate && h.dueDate <= todayStr && !h.done);
        const submittedMockIds = new Set((data.mockExamResults || []).map((r) => r.testId));
        const pendingMock = (data.mockExams || []).filter((t) => t.date && t.date <= todayStr && !submittedMockIds.has(t.id));
        if (pendingHw.length === 0 && pendingMock.length === 0) continue;

        const tags = [pendingHw.length > 0 && "숙제", pendingMock.length > 0 && "모의고사"].filter(Boolean);
        namesStillPending.push(`${student.name}(${tags.join("·")})`);

        const tokens = [student.studentFcmToken, isFirstRun ? student.parentFcmToken : null].filter(Boolean);
        if (tokens.length === 0) continue;

        if (pendingHw.length > 0) {
          const title = `${student.name} 학생, 오늘 숙제를 아직 안 했어요`;
          const body = pendingHw.map((h) => h.content).join(", ").slice(0, 200);
          await admin.messaging().sendEachForMulticast({ tokens, data: { title, body } });
        }
        if (pendingMock.length > 0) {
          const title = `${student.name} 학생, 모의고사 답을 아직 안 올렸어요`;
          const body = pendingMock.map((t) => t.title).join(", ").slice(0, 200);
          await admin.messaging().sendEachForMulticast({ tokens, data: { title, body } });
        }
      } catch (e) {
        console.error(`homeworkReminderCheck failed for student ${student.id}`, e);
      }
    }

    // Teacher gets one aggregated push per run (not one per student) listing everyone still
    // pending (with what kind — 숙제/모의고사), same cadence as the student reminder (hourly
    // from 15:00 to 23:00 KST).
    if (namesStillPending.length > 0 && teacherTokens.length > 0) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: teacherTokens,
          data: {
            title: `📌 아직 안 한 게 있는 학생 ${namesStillPending.length}명`,
            body: namesStillPending.join(", ").slice(0, 200),
          },
        });
      } catch (e) {
        console.error("homeworkReminderCheck teacher notify failed", e);
      }
    }
  }
);

// Wall-clock KST date/time parts, computed the same hacky-but-consistent way as
// homeworkReminderCheck above: format "now" in the Asia/Seoul zone as a string, then re-parse it
// as if those numbers were the local time. The resulting Date's absolute instant is meaningless,
// but reading getFullYear/getHours/etc back out gives correct KST wall-clock numbers as long as
// every date built this way (including minutesBefore below) is read out the same way.
function seoulNowParts() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const pad = (n) => String(n).padStart(2, "0");
  return {
    dateStr: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    hm: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

// Subtracts `mins` minutes from a "YYYY-MM-DD" + "HH:mm" pair, correctly rolling over hour/day
// boundaries (e.g. 00:02 minus 5 min lands on the previous day at 23:57) via plain Date arithmetic.
function minutesBefore(dateStr, timeStr, mins) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const dt = new Date(y, m - 1, d, hh, mm - mins);
  const pad = (n) => String(n).padStart(2, "0");
  return { dateStr: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`, hm: `${pad(dt.getHours())}:${pad(dt.getMinutes())}` };
}

// Teacher records a specific date/time per vocab retest (t.retestDate/t.retestTime, set via
// VocabRetestSchedule in index.html) — e.g. a live call scheduled with the student, not just
// "whenever they get to it" like the always-open vocab tab normally is. Runs every minute (the
// only way to reliably hit an exact minute-precision target) and pushes to both the student and
// the teacher, once at 5-minutes-before and once at the exact time — each only ever matches a
// single 1-minute window so there's no need to track "already sent" state.
exports.vocabRetestReminderCheck = onSchedule(
  { schedule: "* * * * *", timeZone: "Asia/Seoul", region: "us-central1" },
  async () => {
    const { dateStr: todayKST, hm: nowHM } = seoulNowParts();
    const metaSnap = await db.collection("sarahsEnglishMeta").doc("main").get();
    const roster = (metaSnap.exists ? metaSnap.data().roster : []) || [];
    const teacherTokens = [...new Set((metaSnap.exists ? metaSnap.data().teacherFcmTokens : []) || [])];

    for (const student of roster) {
      try {
        const studentSnap = await db.collection("sarahsEnglishStudents").doc(student.id).get();
        if (!studentSnap.exists) continue;
        const data = studentSnap.data();
        for (const t of (data.vocabTests || [])) {
          if (!t.retestDate || !t.retestTime) continue;
          const isExact = t.retestDate === todayKST && t.retestTime === nowHM;
          const before = minutesBefore(t.retestDate, t.retestTime, 5);
          const isFiveBefore = before.dateStr === todayKST && before.hm === nowHM;
          if (!isExact && !isFiveBefore) continue;

          const tokens = [...new Set([student.studentFcmToken, ...teacherTokens].filter(Boolean))];
          if (tokens.length === 0) continue;

          const title = isExact
            ? `🔤 ${student.name} 학생, 지금 "${t.title}" 단어 재시험 시간이에요`
            : `🔤 ${student.name} 학생, "${t.title}" 단어 재시험이 5분 후예요`;
          await admin.messaging().sendEachForMulticast({ tokens, data: { title, body: `${t.retestDate} ${t.retestTime}` } });
        }
      } catch (e) {
        console.error(`vocabRetestReminderCheck failed for student ${student.id}`, e);
      }
    }
  }
);
