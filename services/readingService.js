// Phase 1-B skeleton, extended Phase 3 (Report Center), Phase 4 (Reading Log + Analytics), and
// rewritten 2026-08-26 to drop the IN_PROGRESS concept entirely (see reading-library.html's
// comments on ensureActivityStarted/markStoryCompleted for the frontend half of this change).
// reading-library.html owns four collections index.html never writes to (readingLibrary,
// readingVocab/<studentId>, readingJournal/<studentId>, readingActivity/<studentId> — see
// ARCHITECTURE.md §2.6/§8.1 and CLAUDE.md). This is the read-only seam that pulls that data into
// index.html's Daily/Monthly Report and Teacher/Parent dashboards without duplicating storage.
//
// "완료했다"는 이제 오직 readingJournal에 항목이 있다는 것만을 뜻한다 — 열었다/읽는 중이다는
// 더 이상 학습 이력이 아니다(사용자 지시, 2026-08-26). readingActivity는 여전히 존재하지만
// readingTimeSec(읽은 시간) 하나만을 위한 부가 데이터일 뿐, 이 파일의 어떤 함수도 더 이상
// activity.status를 "완료 여부" 판단에 쓰지 않는다 — Reading Log 제출 시점에 항상 status:
// "COMPLETED"로만 같이 쓰이므로(reading-library.html의 markStoryCompleted), 읽은 시간이 필요할
// 때만 storyId로 조인해서 참고한다.
window.SarahServices = window.SarahServices || {};

(function () {
  const { getDoc, getAllDocs } = window.SarahServices.firebaseClient;

  async function getReadingVocabForStudent(studentId) {
    const doc = await getDoc("readingVocab", studentId);
    return doc || { words: [] };
  }

  async function getReadingJournalForStudent(studentId) {
    const doc = await getDoc("readingJournal", studentId);
    return doc || { entries: [] };
  }

  // readingActivity/<studentId>.activities: { id, storyId, status: "COMPLETED", startedAt,
  // completedAt, readingTimeSec, quizScore, quizTotal }. 오래된 문서에 남아있을 수 있는
  // status: "IN_PROGRESS" 레코드는 어디서도 신규 생성되지 않고(2026-08-26), 이 서비스의 모든
  // 함수가 완전히 무시한다 — 삭제하지는 않았지만(기존 데이터 삭제 금지) 집계에 절대 포함되지
  // 않는다.
  async function getReadingActivityForStudent(studentId) {
    const doc = await getDoc("readingActivity", studentId);
    return (doc && doc.activities) || [];
  }

  // { [storyId]: storyDoc } — see reading-library.html's readingLibrary schema
  // (title, level 1-10, category, genre, vocabulary[], journalLevel, ...).
  async function getAllReadingLibraryStories() {
    return await getAllDocs("readingLibrary");
  }

  function toDateStr(ms) {
    if (!ms) return null;
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // readingJournal 항목은 storyTitle/level을 저장 시점에 이미 함께 담고 있어서(reading-library.html
  // buildJournalSection.submit) activities처럼 매번 stories와 조인할 필요가 없다. 다만 스토리가
  // 그 뒤 삭제됐을 수도 있으니, 확인용으로 stories를 넘겨받으면 orphan 여부만 같이 표시한다.
  function readingTimeForStory(activities, storyId) {
    const a = (activities || []).find((x) => x.storyId === storyId && x.status === "COMPLETED");
    return a ? a.readingTimeSec || 0 : 0;
  }

  // Teacher OS STEP 10 (Reading Vocabulary 책별 그룹화) — readingVocab.words에는 storyId가 없고,
  // 단어를 저장할 당시 스토리의 title 문자열만 `source` 필드에 남는다(reading-library.html의
  // addToVocab() 참고). 같은 단어를 다시 클릭하면 이전 항목을 지우고 새 source로 덮어쓰므로
  // (그 파일의 upsert 로직), 한 단어는 항상 정확히 하나의 스토리에만 속한다 — 그룹 간 중복
  // 걱정 없이 나눌 수 있다. storyId가 없는 기존 데이터 구조를 그대로 두고, 실제 저장된 관계
  // (title 문자열)로만 그룹화한다 — 새 필드/새 컬렉션 없음. 스토리가 삭제됐거나 제목이 바뀌어
  // 더는 어떤 story.title과도 안 맞는 "고아" 단어들은 숨기지 않고 source 문자열 그대로 그룹
  // 이름으로 보여준다. 순수 함수, Firestore 접근 없음.
  function groupReadingVocabByStory(words, storiesById) {
    const titleToStory = {};
    Object.entries(storiesById || {}).forEach(([id, story]) => {
      if (story && story.title && !titleToStory[story.title]) titleToStory[story.title] = { id, ...story };
    });
    const groups = {};
    (words || []).forEach((w) => {
      const key = w.source || "(출처 없음)";
      if (!groups[key]) groups[key] = { source: key, story: titleToStory[key] || null, words: [] };
      groups[key].words.push(w);
    });
    return Object.values(groups)
      .map((g) => ({
        source: g.source,
        story: g.story,
        wordCount: g.words.length,
        lastStudiedAt: g.words.reduce((max, w) => Math.max(max, w.addedAt || 0), 0) || null,
        words: [...g.words].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
      }))
      .sort((a, b) => (b.lastStudiedAt || 0) - (a.lastStudiedAt || 0));
  }

  // Daily Report's Reading panel. "New words"와 "Reading Log 제출"만 실제 "오늘의 활동"으로 본다
  // (2026-08-26 이전엔 열람/진행중(startedToday)도 별도로 보여줬으나, 그 개념 자체가 없어졌다).
  async function getReadingActivityForDate(studentId, date) {
    const [vocab, journal] = await Promise.all([
      getReadingVocabForStudent(studentId),
      getReadingJournalForStudent(studentId),
    ]);
    return {
      newWords: (vocab.words || []).filter((w) => toDateStr(w.addedAt) === date),
      journalEntries: (journal.entries || []).filter((e) => toDateStr(e.submittedAt) === date),
    };
  }

  // Monthly Report's Reading section. "완료한 Story"는 이제 readingJournal 제출 건수다(2026-08-26
  // — 사용자 지시: "Reading Log를 실제로 제출한 완료 Reading 수를 기준으로 계산해야 한다"). 읽은
  // 시간(totalReadingTimeSec)만 부가 정보로 readingActivity에서 마저 가져온다 — Reading Log
  // 제출 시점에 항상 함께 COMPLETED로 기록되므로(reading-library.html markStoryCompleted), 같은
  // 달에 제출된 journal 항목들의 storyId로 조회하면 된다.
  async function getMonthlyReadingStats(studentId, month) {
    const [vocab, journal, activities] = await Promise.all([
      getReadingVocabForStudent(studentId),
      getReadingJournalForStudent(studentId),
      getReadingActivityForStudent(studentId),
    ]);
    const newWords = (vocab.words || []).filter((w) => w.addedAt && toDateStr(w.addedAt).startsWith(month));
    const allEntries = journal.entries || [];
    const journalEntries = allEntries.filter((e) => e.submittedAt && toDateStr(e.submittedAt).startsWith(month));
    // 완료 = 이번 달에 제출된 Reading Log. 감상문(journalEntries)과 완료(completedThisMonth)가
    // 이제 정확히 같은 사건이라 두 값을 따로 계산하지 않는다(§ "복제 집계 금지"와 같은 이유).
    const completedThisMonth = journalEntries;

    const levelCounts = {};
    completedThisMonth.forEach((e) => { if (e.level != null) levelCounts[e.level] = (levelCounts[e.level] || 0) + 1; });

    const totalReadingTimeSec = completedThisMonth.reduce((sum, e) => sum + readingTimeForStory(activities, e.storyId), 0);

    const quizzed = completedThisMonth.filter((e) => e.quizTotal);
    const quizAvgPct = quizzed.length
      ? Math.round(quizzed.reduce((s, e) => s + (e.quizScore / e.quizTotal) * 100, 0) / quizzed.length)
      : null; // stays null — no quiz feature exists yet, so this is always null today, not a fabricated 0.

    const mostRecentCompleted = [...completedThisMonth].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0))[0] || null;

    return {
      storiesRead: completedThisMonth.length,
      completedActivities: completedThisMonth,
      newWordCount: newWords.length,
      journalCount: journalEntries.length,
      entries: journalEntries,
      levelCounts,
      totalReadingTimeSec,
      quizAvgPct,
      recentLevel: mostRecentCompleted ? mostRecentCompleted.level : null,
      recentStoryTitle: mostRecentCompleted ? mostRecentCompleted.storyTitle : null,
    };
  }

  // Teacher OS STEP 9 (Reading Growth Report), rewritten 2026-08-26 — "진행중" 관련 필드
  // (currentLevel/currentStoryTitle, inProgress 파생값)를 모두 제거했다. 완료 이력은
  // readingJournal에서만 가져온다. AI 분석/복잡한 알고리즘 없음 — 전부 count/filter/sort.
  function ymStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

  async function getReadingGrowthReport(studentId) {
    const [vocabDoc, journalDoc] = await Promise.all([
      getReadingVocabForStudent(studentId),
      getReadingJournalForStudent(studentId),
    ]);
    const words = vocabDoc.words || [];
    const entries = [...(journalDoc.entries || [])].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const last30Start = now - 30 * DAY;
    const thisMonth = ymStr(new Date(now));
    const lastMonth = ymStr(new Date(new Date(now).getFullYear(), new Date(now).getMonth() - 1, 1));

    // Reading Volume — "완료"만 존재하므로 "활동"과 "완료"가 이제 같은 숫자다.
    const totalStoriesCompleted = entries.length;
    const thisMonthCompleted = entries.filter((e) => e.submittedAt && toDateStr(e.submittedAt).startsWith(thisMonth)).length;
    const last30Count = entries.filter((e) => e.submittedAt && e.submittedAt >= last30Start).length;

    // Reading Level — 가장 최근/그 이전 완료 Story의 레벨 비교(공식 배정 레벨 필드가 없어서 활동
    // 기반 대체 지표, ARCHITECTURE.md §8.1과 동일한 트레이드오프).
    const mostRecentCompletedLevel = entries[0] ? entries[0].level : null;
    const mostRecentCompletedTitle = entries[0] ? entries[0].storyTitle : null;
    const previousCompletedLevel = entries[1] ? entries[1].level : null;
    const levelChanged = mostRecentCompletedLevel != null && previousCompletedLevel != null && mostRecentCompletedLevel !== previousCompletedLevel;

    // Vocabulary
    const totalNewWords = words.length;
    const last30NewWords = words.filter((w) => w.addedAt && w.addedAt >= last30Start).length;

    // Journal — 이제 "완료"와 동일한 숫자이지만, 필드 이름은 호출부 호환을 위해 그대로 유지한다.
    const totalJournal = entries.length;
    const last30Journal = last30Count;

    // Weekly Trend — last 4 weeks (28 days), oldest first.
    const weeklyTrend = [0, 1, 2, 3].map((i) => {
      const end = now - (3 - i) * 7 * DAY;
      const start = end - 7 * DAY;
      const count = entries.filter((e) => e.submittedAt && e.submittedAt >= start && e.submittedAt < end).length;
      return { label: `Week ${i + 1}`, count };
    });

    function monthCount(monthStr) {
      return entries.filter((e) => e.submittedAt && toDateStr(e.submittedAt).startsWith(monthStr)).length;
    }
    const thisMonthCount = monthCount(thisMonth);
    const lastMonthCount = monthCount(lastMonth);

    // 성장 해석 — 데이터가 실제로 있을 때만 문장을 만든다. "현재 읽는 중" 문장은 그 개념 자체가
    // 없어져 완전히 제거됐다(2026-08-26).
    const insights = [];
    if (last30Count > 0) insights.push(`최근 30일 동안 ${last30Count}개의 Reading Log를 제출했습니다.`);
    if (lastMonthCount > 0) {
      if (thisMonthCount > lastMonthCount) insights.push("지난달보다 Reading 활동이 증가했습니다.");
      else if (thisMonthCount < lastMonthCount) insights.push("지난달보다 Reading 활동이 감소했습니다.");
      else insights.push("지난달과 비슷한 수준의 Reading 활동을 유지했습니다.");
    }
    if (levelChanged) insights.push(`최근 완료한 Story의 Level이 ${previousCompletedLevel} → ${mostRecentCompletedLevel}(으)로 바뀌었습니다.`);

    return {
      totalStoriesCompleted, thisMonthCompleted, last30Count,
      mostRecentCompletedLevel, mostRecentCompletedTitle, previousCompletedLevel, levelChanged,
      totalNewWords, last30NewWords,
      totalJournal, last30Journal,
      weeklyTrend,
      insights,
      hasAnyActivity: entries.length > 0 || words.length > 0,
    };
  }

  window.SarahServices.readingService = {
    getReadingVocabForStudent,
    getReadingJournalForStudent,
    getReadingActivityForStudent,
    getAllReadingLibraryStories,
    getReadingActivityForDate,
    getMonthlyReadingStats,
    getReadingGrowthReport,
    groupReadingVocabByStory,
  };
})();
