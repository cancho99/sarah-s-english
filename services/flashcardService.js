// 단어 플래시카드 암기 기능 — 교재/Day 선택, 세션 큐, 스펠링 채점, "모르는 단어 모아보기"
// (Firestore roster[].flashcardBooks / 학생 문서의 flashcardUnknown[]) 순수 함수 모음.
// Firestore 접근 없음 — 단어 데이터(sarahsEnglishWordbank/main)와 학생별 등록 교재/모르는 단어
// 목록은 전부 index.html이 읽고 써서 이 함수들에 넘겨준다. AI 호출 없음(기존 단어시험 생성기에
// 이미 입력된 Day별 단어 리스트를 그대로 재사용).
window.SarahServices = window.SarahServices || {};

(function () {
  // 다른 services/*.js 파일들과 같은 이유로(스크립트 로드 순서가 index.html 메인 스크립트보다
  // 앞설 수 있음) index.html 전역 shuffle()에 의존하지 않고 독립적으로 둔다.
  function shuffleArr(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 선생님이 이 학생에게 등록해 준 교재만 — registeredIds에 없는 교재는 아예 목록에 나타나지
  // 않는다. 원래 워드뱅크 순서를 그대로 유지한다.
  function getAccessibleBooks(allBooks, registeredIds) {
    const ids = new Set(Array.isArray(registeredIds) ? registeredIds : []);
    return (Array.isArray(allBooks) ? allBooks : []).filter((b) => b && ids.has(b.id));
  }

  // Day 1..totalDays 전부를 돌려주되(단어가 없는 Day도 포함, count:0) — 호출부가 count===0인
  // Day를 선택 불가로 표시할지는 UI 쪽 판단.
  function getDayList(book) {
    const totalDays = Math.max(0, Number(book && book.totalDays) || 0);
    const days = (book && book.days) || {};
    return Array.from({ length: totalDays }, (_, i) => {
      const day = i + 1;
      const count = (days["day" + day] || []).length;
      return { day, count };
    });
  }

  function getWordsForDay(book, day) {
    if (!book || !day) return [];
    return ((book.days || {})["day" + day] || []).filter((w) => w && w.en && w.ko);
  }

  // 세션 하나 분량의 카드 큐 — 순서를 섞고, React key용 안정적인 id를 붙인다. 재배치(요구사항에
  // 없음)는 하지 않는다 — 카드/스펠링 두 모드 다 각 단어를 한 세션에 한 번씩만 지나간다.
  function buildDeck(words) {
    return shuffleArr(words).map((w, i) => ({ id: `${w.en}__${w.ko}__${i}`, en: w.en, ko: w.ko }));
  }

  function computeProgress(total, index) {
    const done = Math.max(0, Math.min(index, total));
    return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }

  // ---- "모르는 단어 모아보기" (Firestore studentData.flashcardUnknown[], 교재/Day 안 가리고
  // 누적) — 카드로 외우기 모드의 "몰라요"에서만 여기 추가된다(스펠링 연습의 오답은 세션
  // 한정이라 여기 안 들어간다). bookId+word 조합으로 중복 방지.
  function unknownKey(bookId, word) {
    return `${bookId}::${word}`;
  }
  function hasUnknownWord(list, bookId, word) {
    const key = unknownKey(bookId, word);
    return (Array.isArray(list) ? list : []).some((u) => unknownKey(u.bookId, u.word) === key);
  }
  function addUnknownWord(list, entry) {
    const safeList = Array.isArray(list) ? list : [];
    if (hasUnknownWord(safeList, entry.bookId, entry.word)) return safeList;
    return [...safeList, entry];
  }
  function removeUnknownWord(list, bookId, word) {
    const key = unknownKey(bookId, word);
    return (Array.isArray(list) ? list : []).filter((u) => unknownKey(u.bookId, u.word) !== key);
  }

  // ---- 스펠링 연습 채점 — 앞뒤 공백 무시 + 대소문자 무시로 비교한다(단어시험 채점처럼 AI나
  // 유의어 판정은 쓰지 않는, 정확한 스펠링 자체를 연습시키는 모드라 정규화만 최소로 한다).
  function normalizeSpelling(s) {
    return (s || "").trim().toLowerCase();
  }
  function checkSpelling(input, answer) {
    return normalizeSpelling(input) === normalizeSpelling(answer) && normalizeSpelling(input) !== "";
  }

  window.SarahServices.flashcardService = {
    getAccessibleBooks,
    getDayList,
    getWordsForDay,
    buildDeck,
    computeProgress,
    hasUnknownWord,
    addUnknownWord,
    removeUnknownWord,
    normalizeSpelling,
    checkSpelling,
  };
})();
