// Vocabulary Test 전면 재구성(2026-08-27) — 문제 생성/랜덤화/채점 보조/Mastery 판정을 담당하는
// 순수 함수 모음. Firestore 접근 없음(index.html의 updateData()가 실제 저장을 담당). 기존
// vocabTests/vocabResults/vocabLog/computeVocabAxis/vocabPassThreshold는 이 파일에서 전혀
// 건드리지 않는다 — index.html에 그대로 남아있고, 이 서비스는 그 위에 얹히는 새 기능만 제공한다.
//
// AI 호출 없음(요구사항 명시) — 객관식 오답(distractor)은 같은 단어장의 다른 단어 뜻을 그대로
// 재사용해서 만든다(사전에서 진짜 오답을 가져오는 흔한 방식). Instant Recall도 같은 문제 생성
// 엔진을 재사용한다 — 빈칸 채우기용 예문 데이터가 현재 스토리지에 없고, 그걸 AI로 새로 만드는
// 것은 금지돼 있으므로(요구사항 §16 "AI Question Generation을 건드리지 않는다"), 대신 매번 새로
// 랜덤화된 영어→뜻/뜻→영어 문제로 "다른 기기에서 검색해 온 점수 왜곡"을 줄이는 쪽을 택했다.
window.SarahServices = window.SarahServices || {};

(function () {
  // 이 파일은 index.html의 전역 shuffle()보다 먼저 실행될 수 있어(서비스 스크립트는 defer로
  // <head>에서 로드되고, index.html의 메인 스크립트는 그보다 뒤에 파싱된다) 독립적인 셔플을
  // 따로 둔다 — 다른 services/*.js 파일들과 같은 이유로 index.html 전역에 의존하지 않는다.
  function shuffleArr(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // §3 — "선택한 범위보다 많은 단어 수"에 대한 명확한 validation 메시지. 저장/출제 어느 쪽에서든
  // 먼저 이 함수로 확인한 뒤에만 sampleWords를 부른다.
  function validateQuestionCount(availableCount, requestedCount) {
    const n = Number(requestedCount);
    if (!requestedCount || !Number.isFinite(n) || n <= 0) {
      return { ok: false, message: "출제 단어 수를 1개 이상 입력해 주세요." };
    }
    if (n > availableCount) {
      return { ok: false, message: `선택한 범위에는 ${availableCount}개의 단어만 있습니다.\n출제 단어 수를 ${availableCount}개 이하로 설정해주세요.` };
    }
    return { ok: true, message: "" };
  }

  // requestedCount가 없거나 전체 개수 이상이면 전체를 그대로 쓰고(순서만 섞음), 아니면 무작위로
  // n개를 뽑는다. 호출부가 validateQuestionCount로 먼저 확인했다는 전제 — 여기서는 다시 막지
  // 않고 Math.min으로 방어만 한다(이중 안전장치).
  function sampleWords(words, requestedCount) {
    const n = requestedCount ? Math.max(1, Math.min(Number(requestedCount), words.length)) : words.length;
    return shuffleArr(words).slice(0, n);
  }

  // §4 — mix 모드의 50/50 분배. 홀수면 영어→뜻(w2m) 쪽에 1문제 더(요구사항 예시: 21문제 →
  // w2m 11 / m2w 10). 배열 자체도 섞어서 "앞쪽은 전부 w2m" 같은 패턴이 생기지 않게 한다.
  function buildDirections(count, mode) {
    if (mode === "w2m") return Array.from({ length: count }, () => "w2m");
    if (mode === "m2w") return Array.from({ length: count }, () => "m2w");
    const w2mCount = Math.ceil(count / 2);
    const dirs = Array(w2mCount).fill("w2m").concat(Array(Math.max(0, count - w2mCount)).fill("m2w"));
    return shuffleArr(dirs);
  }

  function normalizeForCompare(s) {
    return String(s || "").trim().toLowerCase();
  }

  // TYPE 1(영어→뜻) 객관식의 오답 — 같은 단어장의 다른 단어들의 실제 뜻을 그대로 가져다 쓴다
  // (사전 조회/AI 없이도 "그럴듯한 오답"이 되는 흔한 출제 방식). 정답과 중복되거나 서로 같은
  // 뜻이 두 번 나오지 않도록 정규화 비교로 거른다. 단어장이 작으면(예: 3단어) 오답이 부족할 수
  // 있으므로 최대 n개까지만, 그보다 적으면 있는 만큼만 돌려준다 — 호출부가 최소 2지선다까지는
  // 허용한다.
  //
  // 품사 추정(AI 없이, 한국어 뜻 문자열의 어미만 보는 아주 단순한 휴리스틱) — "그럴싸한 오답"의
  // 최소 조건은 적어도 품사가 맞아야 한다는 것(사용자 지시: "품사같은 것도 다 맞아야하고"). 정식
  // 형태소 분석이 아니라 어미 패턴 매칭이라 완벽하지 않지만(예: "높다"처럼 동사/형용사를 구분 못함),
  // 최소한 명사 뜻 옆에 "~다"로 끝나는 동사/형용사 뜻이 섞여 나오는 것 같은 명백한 오답은 막는다.
  function inferKoreanPos(meaning) {
    const m = String(meaning || "").trim();
    if (!m) return "unknown";
    if (/다$/.test(m)) return "verb_or_adj"; // 동사·형용사(버리다/상당한 등, "~다"로 끝남)
    if (/(히|게|이)$/.test(m) && m.length <= 6) return "adverb"; // 짧고 부사형 어미로 끝남
    return "noun_or_other";
  }

  // 같은 품사 후보를 먼저 채우고(§ "품사도 다 맞아야"), 그래도 모자라면 나머지 품사에서 채운다 —
  // 단어장이 작아서 같은 품사가 부족할 때 억지로 오답을 만들어내지 않고 있는 만큼만 쓴다.
  function buildDistractors(correctMeaning, poolMeanings, n) {
    const seen = new Set([normalizeForCompare(correctMeaning)]);
    const correctPos = inferKoreanPos(correctMeaning);
    const samePos = []; const otherPos = [];
    shuffleArr(poolMeanings).forEach((m) => {
      const norm = normalizeForCompare(m);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      (inferKoreanPos(m) === correctPos ? samePos : otherPos).push(m);
    });
    return [...samePos, ...otherPos].slice(0, n);
  }

  // 학생별 랜덤화(§5) 핵심 — 같은 단어 목록이라도 부를 때마다: 문제 순서, 방향(w2m/m2w, mix일 때),
  // 객관식 선지 순서가 전부 다시 섞인다. 각 문제에는 이번 응시(attempt) 동안 안정적으로 유지되는
  // id를 붙여서(제출/재개 시 답안-문제 매칭이 꼬이지 않게) 채점 데이터가 랜덤화 때문에 어긋나지
  // 않게 한다. 뜻→영어(m2w) 문제의 "정답 단어 자체"는 절대 바뀌지 않는다 — 여기서 만드는 건
  // 문제 순서/방향/객관식 선지 순서뿐, 정답 데이터(w.word/w.meaning)는 그대로 참조만 한다.
  function buildVocabQuestions(words, mode) {
    const directions = buildDirections(words.length, mode);
    const allMeanings = words.map((w) => w.meaning);
    const questions = words.map((w, i) => {
      const questionType = directions[i];
      const base = {
        id: `${(w.word || "").toLowerCase()}__${i}__${Math.random().toString(36).slice(2, 8)}`,
        wordId: w.word,
        questionType,
        word: w.word,
        meaning: w.meaning,
        synonyms: w.synonyms || [],
      };
      if (questionType !== "w2m") return base; // m2w — 직접 입력 방식, 선지 없음(§4 TYPE 2)
      // 5지선다(정답 1 + 오답 4) — 단어장이 작으면 자연히 그보다 적게 나올 수 있다(억지로 채우지 않음).
      const distractors = buildDistractors(w.meaning, allMeanings.filter((_, mi) => mi !== i), 4);
      const choices = shuffleArr([w.meaning, ...distractors]);
      return { ...base, choices, correctIndex: choices.indexOf(w.meaning) };
    });
    return shuffleArr(questions);
  }

  // §11 Instant Recall — Main Test에 나온 단어 중 기본 5개를 무작위로 다시 뽑아 같은 문제 생성
  // 엔진(mix 모드)으로 새로 문제를 만든다. Main Test와 방향(w2m/m2w)이 독립적으로 다시
  // 랜덤화되므로 "다른 형태"가 될 수 있다(항상 다르다고 보장하지는 않음 — 요구사항도 "다른 형태를
  // 사용할 수 있도록 설계"이지 "반드시 달라야 한다"는 아님).
  function pickInstantRecallQuestions(words, count) {
    const n = Math.min(count || 5, words.length);
    const pool = shuffleArr(words).slice(0, n);
    return buildVocabQuestions(pool, "mix");
  }

  // §13 Mastery 판정 — recall 데이터가 아예 없으면(예: 옛날 기록, 또는 이번 시험에 Recall을
  // 안 붙인 경우) null을 돌려준다. 절대 "recallTotal 0"을 "0점 처리"해서 억지로 RECHECK을
  // 만들지 않는다 — 데이터가 없다는 것과 낮은 점수라는 것은 다르다(§14 "기존 학생 과거 기록은
  // 그대로 정상 표시"와 같은 원칙). 기본 기준(요구사항 §13): Main >= 90% AND Recall >= 80% → PASS,
  // 아니면 RECHECK_REQUIRED. 이 함수는 기존 vocabPassThreshold(80%/90%, 시험 제목 기준)를
  // 대체하지 않는다 — 완전히 별개의 새 축이다.
  const MASTERY_THRESHOLDS = { MAIN_PCT: 90, RECALL_PCT: 80 };
  function computeVocabMastery({ mainScore, mainTotal, recallScore, recallTotal }) {
    if (!recallTotal) return null;
    const mainPct = mainTotal > 0 ? (mainScore / mainTotal) * 100 : 0;
    const recallPct = (recallScore / recallTotal) * 100;
    return (mainPct >= MASTERY_THRESHOLDS.MAIN_PCT && recallPct >= MASTERY_THRESHOLDS.RECALL_PCT) ? "PASS" : "RECHECK_REQUIRED";
  }

  // §8/§15 — integrity는 "컨닝 확정 증거"가 아니라 확인 신호다. 여기 임계값을 넘으면 REVIEW_REQUIRED
  // (선생님이 한 번 더 보면 좋겠다는 신호)일 뿐, 자동 감점/불합격에는 어디에도 쓰이지 않는다.
  const INTEGRITY_REVIEW_THRESHOLDS = { VISIBILITY_EXITS: 3, PASTE_ATTEMPTS: 1, COPY_ATTEMPTS: 1 };
  function computeVocabIntegritySignal(integrity) {
    if (!integrity) return "NORMAL";
    const T = INTEGRITY_REVIEW_THRESHOLDS;
    const flagged = (integrity.visibilityExitCount || 0) >= T.VISIBILITY_EXITS
      || (integrity.pasteAttemptCount || 0) >= T.PASTE_ATTEMPTS
      || (integrity.copyAttemptCount || 0) >= T.COPY_ATTEMPTS;
    return flagged ? "REVIEW_REQUIRED" : "NORMAL";
  }

  // 선생님 결과 화면(§15)에 보여줄 최종 한 줄 상태. mastery가 임계값에 못 미치면(점수 자체의
  // 문제) RECHECK_REQUIRED가 최우선 — 점수가 기준 미달인데 "이상행동 없음"이라고 안심시키면 안
  // 되기 때문. mastery를 통과했어도 integrity 신호가 있으면(행동 기반 신호) REVIEW_REQUIRED로
  // 낮춰서 보여준다. recall 데이터 자체가 없으면(레거시) null — 이 경우 화면은 기존 합격/재시험
  // 배지(vocabPassThreshold 기반)만 그대로 보여주고 이 최종 상태 줄 자체를 표시하지 않는다.
  function computeVocabFinalStatus({ mainScore, mainTotal, recallScore, recallTotal, integrity }) {
    const mastery = computeVocabMastery({ mainScore, mainTotal, recallScore, recallTotal });
    if (mastery == null) return null;
    if (mastery === "RECHECK_REQUIRED") return "RECHECK_REQUIRED";
    const integritySignal = computeVocabIntegritySignal(integrity);
    return integritySignal === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "PASS";
  }

  window.SarahServices.vocabTestService = {
    validateQuestionCount,
    sampleWords,
    buildDirections,
    inferKoreanPos,
    buildDistractors,
    buildVocabQuestions,
    pickInstantRecallQuestions,
    computeVocabMastery,
    computeVocabIntegritySignal,
    computeVocabFinalStatus,
    MASTERY_THRESHOLDS,
    INTEGRITY_REVIEW_THRESHOLDS,
  };
})();
