// Phase 1-B skeleton, extended Phase 3 (Report Center) and Phase 4 (Reading Log + Analytics).
// reading-library.html owns four collections index.html never writes to (readingLibrary,
// readingVocab/<studentId>, readingJournal/<studentId>, readingActivity/<studentId> — see
// ARCHITECTURE.md §2.6/§8.1 and CLAUDE.md). This is the read-only seam that pulls that data into
// index.html's Daily/Monthly Report and Teacher/Parent dashboards without duplicating storage —
// reading-library.html itself only gained the new readingActivity collection in Phase 4; its
// other three collections and all existing screens are unchanged.
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

  // Phase 4 — readingActivity/<studentId>.activities: { id, storyId, status, startedAt,
  // completedAt, readingTimeSec, quizScore, quizTotal }. See ARCHITECTURE.md §8.1 for why
  // storyTitle/level/newWords are deliberately NOT stored here (joined live instead, below).
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

  // Joins one activity record with its story (title/level) — activities never store this
  // themselves (§8.1). Returns null if the story was since deleted (orphaned activity record;
  // silently excluded rather than shown with blank fields).
  function joinActivity(activity, storiesById) {
    const story = storiesById[activity.storyId];
    if (!story) return null;
    return { ...activity, storyTitle: story.title, level: story.level };
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

  // Daily Report's Reading panel (Phase 3, extended Phase 4). "New words" and journal entries
  // are real (readingVocab.addedAt / readingJournal.submittedAt). Activity status changes
  // (started/completed) that happened on this date are now also real, via readingActivity —
  // Word Count/Reading Time-per-day/Quiz Score still aren't meaningfully "per day" concepts the
  // UI should imply beyond what's here, so this does not add fabricated per-day totals for those.
  async function getReadingActivityForDate(studentId, date) {
    const [vocab, journal, activities, stories] = await Promise.all([
      getReadingVocabForStudent(studentId),
      getReadingJournalForStudent(studentId),
      getReadingActivityForStudent(studentId),
      getAllReadingLibraryStories(),
    ]);
    const startedToday = activities.filter((a) => toDateStr(a.startedAt) === date);
    const completedToday = activities.filter((a) => toDateStr(a.completedAt) === date);
    return {
      newWords: (vocab.words || []).filter((w) => toDateStr(w.addedAt) === date),
      journalEntries: (journal.entries || []).filter((e) => toDateStr(e.submittedAt) === date),
      startedToday: startedToday.map((a) => joinActivity(a, stories)).filter(Boolean),
      completedToday: completedToday.map((a) => joinActivity(a, stories)).filter(Boolean),
    };
  }

  // Monthly Report's Reading section (Phase 3, corrected in Phase 4). Before Phase 4 there was no
  // activity tracking, so "storiesRead" was approximated from readingJournal entries (writing a
  // journal != actually finishing a story, but it was the only signal available). Now that
  // readingActivity exists, `storiesRead`/`completedCount` use the real COMPLETED count instead —
  // journal entries are kept separately (`journalCount`) since writing a reflection is still its
  // own real, useful signal, just no longer conflated with "finished reading."
  async function getMonthlyReadingStats(studentId, month) {
    const [vocab, journal, activities, stories] = await Promise.all([
      getReadingVocabForStudent(studentId),
      getReadingJournalForStudent(studentId),
      getReadingActivityForStudent(studentId),
      getAllReadingLibraryStories(),
    ]);
    const newWords = (vocab.words || []).filter((w) => w.addedAt && toDateStr(w.addedAt).startsWith(month));
    const journalEntries = (journal.entries || []).filter((e) => e.submittedAt && toDateStr(e.submittedAt).startsWith(month));

    const completedThisMonth = activities
      .filter((a) => a.status === "COMPLETED" && a.completedAt && toDateStr(a.completedAt).startsWith(month))
      .map((a) => joinActivity(a, stories))
      .filter(Boolean);
    const inProgressThisMonth = activities
      .filter((a) => a.status === "IN_PROGRESS" && a.startedAt && toDateStr(a.startedAt).startsWith(month))
      .map((a) => joinActivity(a, stories))
      .filter(Boolean);

    const levelCounts = {};
    completedThisMonth.forEach((a) => { if (a.level != null) levelCounts[a.level] = (levelCounts[a.level] || 0) + 1; });

    const totalReadingTimeSec = activities
      .filter((a) => (a.completedAt && toDateStr(a.completedAt).startsWith(month)) || (a.startedAt && toDateStr(a.startedAt).startsWith(month)))
      .reduce((sum, a) => sum + (a.readingTimeSec || 0), 0);

    const quizzed = completedThisMonth.filter((a) => a.quizTotal);
    const quizAvgPct = quizzed.length
      ? Math.round(quizzed.reduce((s, a) => s + (a.quizScore / a.quizTotal) * 100, 0) / quizzed.length)
      : null; // stays null — no quiz feature exists yet, so this is always null today, not a fabricated 0.

    // "가장 최근 완료한 Story의 레벨" — 공식 레벨 배정 필드가 없어서, 활동 기반의 정직한 대체
    // 지표로 사용한다(ARCHITECTURE.md §8.1). 지난달 것과 비교하려는 호출부는 이 값을 두 달에 대해
    // 각각 불러와 직접 비교한다.
    const mostRecentCompleted = [...completedThisMonth].sort((a, b) => b.completedAt - a.completedAt)[0] || null;

    return {
      storiesRead: completedThisMonth.length,
      completedActivities: completedThisMonth,
      inProgressCount: inProgressThisMonth.length,
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

  // Teacher OS STEP 9 (Reading Growth Report) — deterministic aggregation over the same four
  // read-only calls every other function in this file already uses (no new collection, no new
  // Firestore access pattern). AI 분석/복잡한 알고리즘 없음 — 전부 count/filter/sort. Self-
  // contained date math (no dependency on index.html's `today()`/`monthOffset()` — those are
  // private to index.html's own DOMContentLoaded closure and are not reachable from this file;
  // see examPaperService.js's own local `uid()` for the same reasoning applied to a different
  // helper).
  function ymStr(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }

  async function getReadingGrowthReport(studentId) {
    const [vocabDoc, journalDoc, activities, stories] = await Promise.all([
      getReadingVocabForStudent(studentId),
      getReadingJournalForStudent(studentId),
      getReadingActivityForStudent(studentId),
      getAllReadingLibraryStories(),
    ]);
    const words = vocabDoc.words || [];
    const entries = journalDoc.entries || [];
    const joined = activities.map((a) => joinActivity(a, stories)).filter(Boolean);
    const completed = joined.filter((a) => a.status === "COMPLETED").sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    const inProgress = joined.filter((a) => a.status !== "COMPLETED").sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const last30Start = now - 30 * DAY;
    const thisMonth = ymStr(new Date(now));
    const lastMonth = ymStr(new Date(new Date(now).getFullYear(), new Date(now).getMonth() - 1, 1));

    // Reading Volume
    const totalStoriesCompleted = completed.length;
    const thisMonthCompleted = completed.filter((a) => a.completedAt && toDateStr(a.completedAt).startsWith(thisMonth)).length;
    const last30Activities = joined.filter((a) => (a.startedAt && a.startedAt >= last30Start) || (a.completedAt && a.completedAt >= last30Start));
    const last30ActivityCount = last30Activities.length;
    const last30CompletedCount = last30Activities.filter((a) => a.status === "COMPLETED" && a.completedAt && a.completedAt >= last30Start).length;

    // Reading Level — no official "assigned level" field exists (see getMonthlyReadingStats'
    // comment above), so "current level" = the level of the most recently started in-progress
    // story, and "most recent completed level" = the level of the most recently completed story.
    const currentLevel = inProgress[0] ? inProgress[0].level : null;
    const currentStoryTitle = inProgress[0] ? inProgress[0].storyTitle : null;
    const mostRecentCompletedLevel = completed[0] ? completed[0].level : null;
    const mostRecentCompletedTitle = completed[0] ? completed[0].storyTitle : null;
    const previousCompletedLevel = completed[1] ? completed[1].level : null;
    const levelChanged = mostRecentCompletedLevel != null && previousCompletedLevel != null && mostRecentCompletedLevel !== previousCompletedLevel;

    // Vocabulary
    const totalNewWords = words.length;
    const last30NewWords = words.filter((w) => w.addedAt && w.addedAt >= last30Start).length;

    // Journal
    const totalJournal = entries.length;
    const last30Journal = entries.filter((e) => e.submittedAt && e.submittedAt >= last30Start).length;

    // Activity Trend — last 4 weeks (28 days, not a fabricated 30/4 split), oldest first so the
    // UI reads left-to-right chronologically. Each activity counted once per week its startedAt
    // OR completedAt falls into (an activity that starts in one week and completes in a later one
    // legitimately shows up in both, same as getReadingActivityForDate's per-day behavior above).
    const weeklyTrend = [0, 1, 2, 3].map((i) => {
      const end = now - (3 - i) * 7 * DAY;
      const start = end - 7 * DAY;
      const count = joined.filter((a) => (a.startedAt && a.startedAt >= start && a.startedAt < end) || (a.completedAt && a.completedAt >= start && a.completedAt < end)).length;
      return { label: `Week ${i + 1}`, count };
    });

    // Month-over-month comparison — computed from the same `joined` array already in memory
    // (no second Firestore round-trip via getMonthlyReadingStats).
    function monthActivityCount(monthStr) {
      return joined.filter((a) => (a.startedAt && toDateStr(a.startedAt).startsWith(monthStr)) || (a.completedAt && toDateStr(a.completedAt).startsWith(monthStr))).length;
    }
    const thisMonthActivityCount = monthActivityCount(thisMonth);
    const lastMonthActivityCount = monthActivityCount(lastMonth);

    // 성장 해석 — 데이터가 실제로 있을 때만 문장을 만든다. 비교 문장은 비교 대상(지난달)이 진짜
    // 0보다 클 때만("이전 기간 데이터가 없으면 비교 문장을 만들지 않는다").
    const insights = [];
    if (last30CompletedCount > 0) insights.push(`최근 30일 동안 ${last30CompletedCount}개의 Story를 완료했습니다.`);
    if (currentStoryTitle != null) insights.push(`현재 Level ${currentLevel} Story("${currentStoryTitle}")를 읽고 있습니다.`);
    if (lastMonthActivityCount > 0) {
      if (thisMonthActivityCount > lastMonthActivityCount) insights.push("지난달보다 Reading 활동이 증가했습니다.");
      else if (thisMonthActivityCount < lastMonthActivityCount) insights.push("지난달보다 Reading 활동이 감소했습니다.");
      else insights.push("지난달과 비슷한 수준의 Reading 활동을 유지했습니다.");
    }
    if (levelChanged) insights.push(`최근 완료한 Story의 Level이 ${previousCompletedLevel} → ${mostRecentCompletedLevel}(으)로 바뀌었습니다.`);

    return {
      totalStoriesCompleted, thisMonthCompleted, last30ActivityCount,
      currentLevel, currentStoryTitle,
      mostRecentCompletedLevel, mostRecentCompletedTitle, previousCompletedLevel, levelChanged,
      totalNewWords, last30NewWords,
      totalJournal, last30Journal,
      weeklyTrend,
      insights,
      hasAnyActivity: joined.length > 0 || words.length > 0 || entries.length > 0,
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
