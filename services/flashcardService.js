// 단어 플래시카드 암기 기능(2026-08-29) — 교재/Day 선택, 카드 큐 진행, "모르는 단어 모아보기"를
// 담당하는 순수 함수 모음. Firestore 접근 없음 — 단어 데이터(sarahsEnglishWordbank/main)와 학생별
// 등록 교재(roster[].flashcardBooks)는 전부 index.html이 읽어서 이 함수들에 넘겨준다. AI 호출 없음
// (이 기능 자체가 AI와 무관 — 기존 단어시험 생성기에 이미 입력된 Day별 단어 리스트를 그대로 재사용).
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
  // 않는다(요구사항 1). 원래 워드뱅크 순서를 그대로 유지한다.
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

  // 세션 하나 분량의 카드 큐를 만든다 — 순서를 섞고, 재배치(모름 → 맨 뒤)에도 각 카드를 식별할
  // 수 있도록 안정적인 id를 붙인다.
  function buildDeck(words) {
    return shuffleArr(words).map((w, i) => ({ id: `${w.en}__${w.ko}__${i}`, en: w.en, ko: w.ko }));
  }

  // "알아요" — 맨 앞 카드를 큐에서 제거하고 다음 카드로. 진행률(완료 개수)은 total - deck.length로
  // 계산되므로 별도 카운터가 필요 없다.
  function markKnown(deck) {
    return deck.slice(1);
  }

  // "모름" — 맨 앞 카드를 큐 맨 뒤로 재배치해서 나중에 다시 나오게 한다(요구사항 3). 큐 길이는
  // 바뀌지 않는다.
  function markUnknown(deck) {
    if (deck.length <= 1) return deck;
    const [first, ...rest] = deck;
    return [...rest, first];
  }

  function computeProgress(total, deckLength) {
    const done = Math.max(0, total - deckLength);
    return { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  }

  // "모르는 단어 모아보기" 리스트 — 세션 중 "모름"으로 표시된 적이 있는 카드를 전부 모아둔다
  // (그 뒤 메인 큐에서 "알아요"로 넘어갔더라도 이 리스트에는 계속 남는다 — 요구사항 4는 별도
  // 화면/별도 상태다). 같은 카드가 두 번 추가되지 않게 id로 중복 제거.
  function addMissed(missedList, card) {
    if (missedList.some((m) => m.id === card.id)) return missedList;
    return [...missedList, card];
  }

  // 리스트 화면에서 "알아요"를 누르면 그 카드만 즉시 제거(요구사항 4).
  function removeMissed(missedList, cardId) {
    return missedList.filter((m) => m.id !== cardId);
  }

  window.SarahServices.flashcardService = {
    getAccessibleBooks,
    getDayList,
    getWordsForDay,
    buildDeck,
    markKnown,
    markUnknown,
    computeProgress,
    addMissed,
    removeMissed,
  };
})();
