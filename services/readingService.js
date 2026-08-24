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

  window.SarahServices.readingService = {
    getReadingVocabForStudent,
    getReadingJournalForStudent,
    getReadingActivityForStudent,
    getAllReadingLibraryStories,
    getReadingActivityForDate,
    getMonthlyReadingStats,
  };
})();
