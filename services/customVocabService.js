// "나의 단어장" 허브(2026-09-15) — 학생이 직접 만드는 커스텀 단어장(사진 OCR/직접 입력) +
// 선생님 등록 교재의 진행률(Day 완료 개수) 계산을 담당하는 순수 함수 모음. Firestore 접근
// 없음 — customVocabLists/<studentId> 문서(lists: [{id,name,words,source,createdAt,updatedAt}])
// 읽기/쓰기는 index.html이 firebaseClient.getDoc/setDocAt으로 직접 한다. OCR 자체(Tesseract.js
// 호출)도 이 파일이 아니라 index.html에서 한다 — 여기 있는 건 OCR 결과 텍스트를 단어/뜻 후보로
// 쪼개는 순수 파싱 로직뿐이다.
window.SarahServices = window.SarahServices || {};

(function () {
  function uidLocal() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---- OCR 결과 텍스트 파싱 ----
  // 교재 표/목록이 보통 "단어  뜻"(공백 여러 칸) 또는 "단어 - 뜻" 형태인 점을 이용하되, OCR은
  // 공백을 안정적으로 보존하지 못하는 경우가 많아 "영어 구간 뒤에 한글이 시작되는 지점"을
  // 실제 경계로 삼는다 — 인쇄 상태/기울기에 따라 깨질 수 있으므로 완벽함을 목표하지 않고, 학생이
  // 화면에서 직접 고칠 수 있는 "그럴듯한 초안"만 만든다.
  const HANGUL_RE = /[가-힣]/;
  function splitWordMeaningLine(line) {
    const trimmed = (line || "").trim();
    if (!trimmed) return null;
    const m = trimmed.match(HANGUL_RE);
    if (!m) return { en: trimmed, ko: "" }; // 한글을 못 찾음 — 단어만 후보로, 뜻은 학생이 채움
    const idx = m.index;
    let en = trimmed.slice(0, idx).trim();
    let ko = trimmed.slice(idx).trim();
    en = en.replace(/[-–—:.\s]+$/, "").trim();
    ko = ko.replace(/^[-–—:.\s]+/, "").trim();
    if (!en) return { en: "", ko };
    return { en, ko };
  }
  function parseOcrText(rawText) {
    return (rawText || "")
      .split("\n")
      .map((l) => splitWordMeaningLine(l))
      .filter(Boolean)
      .filter((p) => p.en) // 영어 단어 후보 자체가 없는 줄(빈 줄 등)은 버림
      .map((p) => ({ id: uidLocal(), en: p.en, ko: p.ko, checked: true }));
  }

  // ---- 커스텀 단어장 CRUD (순수 배열 변환, 실제 저장은 index.html의 setDocAt) ----
  function buildCustomVocabList({ name, words, source }) {
    const now = Date.now();
    return {
      id: uidLocal(),
      name: (name || "").trim() || "새 단어장",
      words: words || [],
      source: source === "photo" ? "photo" : "manual",
      createdAt: now,
      updatedAt: now,
    };
  }
  function appendWordsToList(lists, listId, newWords, source) {
    const now = Date.now();
    return (lists || []).map((l) =>
      l.id === listId
        ? { ...l, words: [...l.words, ...newWords], source: source === "photo" ? "photo" : l.source, updatedAt: now }
        : l
    );
  }

  // ---- 선생님 등록 교재 진행률(허브 섹션 1의 "N/M" 또는 "시작 전" 칩) ----
  // dayList: [{day, count}] (flashcardService.getDayList 결과 그대로) — count>0인 Day만 "진짜
  // 분량이 있는 Day"로 친다. flashcardSessions: 학생 문서의 data.flashcardSessions[] 그대로 —
  // 같은 책(bookId)·day 조합으로 완료된 세션(mode 무관, cards든 spelling이든 "그 Day를 끝냈다"는
  // 사실은 같음)이 하나라도 있으면 그 Day는 "완료"로 센다.
  function completedDaySet(flashcardSessions, bookId) {
    const set = new Set();
    (flashcardSessions || []).forEach((s) => {
      if (s.bookId === bookId && s.day != null) set.add(s.day);
    });
    return set;
  }
  function computeBookProgress(dayList, flashcardSessions, bookId) {
    const days = (dayList || []).filter((d) => d.count > 0);
    const done = completedDaySet(flashcardSessions, bookId);
    const completedCount = days.filter((d) => done.has(d.day)).length;
    if (completedCount === 0) return { label: "시작 전", started: false, completedCount, totalCount: days.length };
    return { label: `${completedCount}/${days.length}`, started: true, completedCount, totalCount: days.length };
  }
  // 다음에 이어할 Day — 아직 완료 안 한 첫 Day, 전부 끝났으면(또는 분량 자체가 없으면) 1로.
  function nextIncompleteDay(dayList, flashcardSessions, bookId) {
    const days = (dayList || []).filter((d) => d.count > 0).map((d) => d.day).sort((a, b) => a - b);
    if (days.length === 0) return 1;
    const done = completedDaySet(flashcardSessions, bookId);
    const next = days.find((d) => !done.has(d));
    return next != null ? next : days[0];
  }

  // ---- "단어 리스트" 화면의 품사 표시 ----
  // 원본 데이터(워드뱅크/커스텀 단어장 모두 {en,ko}뿐)에 품사 필드가 없어, 한국어 뜻의 어미만
  // 보는 아주 단순한 휴리스틱으로 추정한다(vocabTestService.inferKoreanPos와 같은 아이디어를
  // 표시용 한글 라벨로 재구성한 것 — 정식 형태소 분석이 아니라 완벽하지 않다, 예: "높다"가
  // 동사인지 형용사인지 구분 못 함). "~이"로 끝나는 어미는 일부러 부사 판정에서 뺐다 — 실제
  // 브라우저 테스트에서 "고양이"(명사)가 "~이" 규칙에 걸려 "부사"로 잘못 표시되는 게 바로
  // 재현됐다: "~이"로 끝나는 흔한 명사가 너무 많아(고양이/아이/구두 등) 오탐 위험이 크다.
  // "~히"/"~게"는 그런 흔한 명사 어미 충돌이 훨씬 적어 남겨뒀다.
  function posLabelForMeaning(ko) {
    const m = String(ko || "").trim();
    if (!m) return "";
    if (/다$/.test(m)) return "동사·형용사";
    if (/(히|게)$/.test(m) && m.length <= 6) return "부사";
    return "명사";
  }

  window.SarahServices.customVocabService = {
    splitWordMeaningLine,
    parseOcrText,
    buildCustomVocabList,
    appendWordsToList,
    computeBookProgress,
    nextIncompleteDay,
    posLabelForMeaning,
  };
})();
