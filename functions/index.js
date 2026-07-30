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
- 답변에 <thinking> 같은 내부 태그나 메타 설명을 절대 포함하지 마세요. 오직 JSON 배열만 출력합니다.

[JSON 스키마]
[{"name":"01회","answers":[5,1,2,4,3,5,2,1,3,1,1,2]},{"name":"어법편 Ⅰ. 문장의 기초","answers":[3,4,5,3,5]},{"name":"어법편 Ⅰ. 문장의 기초 (경찰대/사관학교 입학시험)","answers":[5,3,5,2,2]}]`;

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
    const { passage, includeAnalysis, questionTypes, level, countPerType, mode, pdfBase64, images, studentName, month, rough } = body;
    const isTransform = mode === "transform";
    const isNelt = mode === "nelt";
    const isReport = mode === "monthlyReport";
    const isExamKey = mode === "examkey";

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
        study_pause: `⏸ ${studentName} 학생이 공부를 일시정지했어요`,
        study_log_saved: `📗 ${studentName} 학생이 공부 기록을 저장했어요`,
        homework_done: `✅ ${studentName} 학생이 숙제를 완료 표시했어요`,
        mock_exam_submit: `📄 ${studentName} 학생이 모의고사 채점을 제출했어요`,
        student_login: `👋 ${studentName} 학생이 로그인했어요`,
        parent_login: `👪 ${studentName} 학생 학부모님이 로그인했어요`,
        consult_request: `💬 ${studentName} 학생 학부모님이 상담을 신청했어요`,
      };
      const DEFAULT_BODIES = {
        homework_upload: "인증샷을 확인해 보세요.",
        study_start: "공부 타이머를 시작했어요.",
        study_pause: "공부 타이머를 일시정지했어요.",
        study_log_saved: "공부 기록을 저장했어요.",
        homework_done: "숙제를 완료로 표시했어요.",
        mock_exam_submit: "모의고사 결과를 저장했어요.",
        student_login: "학생용 화면에 접속했어요.",
        parent_login: "학부모용 화면에 접속했어요.",
        consult_request: "상담 신청 내용을 확인해 보세요.",
      };
      const title = TITLES[kind] || "🔔 테스트 알림";
      const body = (detail ? String(detail).slice(0, 120) : "") || DEFAULT_BODIES[kind] || "알림이 정상적으로 도착했어요!";

      const resp = await admin.messaging().sendEachForMulticast({ tokens, data: { title, body } });
      res.status(200).json({ sent: resp.successCount, failed: resp.failureCount });
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

// 밤 10시(한국 시간)부터 10시 30분 간격으로(10:00/10:30/11:00/11:30) 그날 마감인데 아직
// 완료 표시가 안 된 숙제가 있는 학생을 찾아 알림을 보낸다. 학부모는 매번 알림이 가면 피로감이
// 크므로 10시 첫 실행 때 한 번만 보내고, 학생은 숙제를 끝낼 때까지(= pending이 빌 때까지)
// 30분마다 계속 받는다 — 완료 표시가 뜨는 순간 이 필터에서 자연히 빠지므로 별도의 "이미
// 보냈음" 상태를 추적할 필요가 없다.
exports.homeworkReminderCheck = onSchedule(
  { schedule: "0,30 22,23 * * *", timeZone: "Asia/Seoul", region: "us-central1" },
  async () => {
    const nowSeoul = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
    const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
    const isFirstRun = nowSeoul.getHours() === 22 && nowSeoul.getMinutes() < 15; // the 22:00 slot
    const metaSnap = await db.collection("sarahsEnglishMeta").doc("main").get();
    const roster = (metaSnap.exists ? metaSnap.data().roster : []) || [];
    const teacherTokens = [...new Set((metaSnap.exists ? metaSnap.data().teacherFcmTokens : []) || [])];
    const namesStillPending = [];

    for (const student of roster) {
      try {
        const studentSnap = await db.collection("sarahsEnglishStudents").doc(student.id).get();
        if (!studentSnap.exists) continue;
        const data = studentSnap.data();
        const pending = (data.homework || []).filter((h) => h.dueDate && h.dueDate <= todayStr && !h.done);
        if (pending.length === 0) continue;
        namesStillPending.push(student.name);

        const tokens = [student.studentFcmToken, isFirstRun ? student.parentFcmToken : null].filter(Boolean);
        if (tokens.length === 0) continue;

        const title = `${student.name} 학생, 오늘 숙제를 아직 안 했어요`;
        const body = pending.map((h) => h.content).join(", ").slice(0, 200);
        await admin.messaging().sendEachForMulticast({ tokens, data: { title, body } });
      } catch (e) {
        console.error(`homeworkReminderCheck failed for student ${student.id}`, e);
      }
    }

    // Teacher gets one aggregated push per run (not one per student) listing everyone still
    // pending, same cadence as the student reminder (every 30 min from 22:00 to 23:30 KST).
    if (namesStillPending.length > 0 && teacherTokens.length > 0) {
      try {
        await admin.messaging().sendEachForMulticast({
          tokens: teacherTokens,
          data: {
            title: `🌙 오늘 숙제 안 한 학생 ${namesStillPending.length}명`,
            body: namesStillPending.join(", ").slice(0, 200),
          },
        });
      } catch (e) {
        console.error("homeworkReminderCheck teacher notify failed", e);
      }
    }
  }
);
