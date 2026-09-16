// 단어 암기 기능 3종(플래시카드 세션/연습시험/선생님 복습 현황) 공용 순수 함수 모음(2026-09-15).
// Firestore 접근 없음 — 세션/연습시험 기록은 학생 문서의 flashcardSessions[]/vocabPracticeTests[]
// 필드에 그대로 쌓이고(새 컬렉션 없음, 기존 sarahsEnglishStudents 문서 재사용), index.html의
// updateData()가 실제 읽기/쓰기를 담당한다. AI 호출 없음 — 연습시험 문제 생성은 기존
// vocabTestService.buildVocabQuestions()를 그대로 재사용한다(요구사항: "기존 단어시험 생성기의
// 정답 데이터 + 동의어 채점 로직 그대로 재사용").
window.SarahServices = window.SarahServices || {};

(function () {
  function uidLocal() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function todayStr(d) {
    const dt = d || new Date();
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }

  // ---- [1] 플래시카드 세션 기록 ----
  // durationSec은 항상 endedAt/startedAt(둘 다 Date.now() ms)에서 계산 — 호출부가 따로 재는 값과
  // 어긋나지 않게 이 함수 하나로만 만든다.
  function buildFlashcardSessionRecord({ bookId, bookName, day, mode, startedAt, endedAt, wordCount }) {
    const durationSec = Math.max(0, Math.round(((endedAt || Date.now()) - (startedAt || Date.now())) / 1000));
    return {
      id: uidLocal(),
      bookId, bookName, day, mode,
      startedAt: startedAt || Date.now(),
      endedAt: endedAt || Date.now(),
      durationSec,
      wordCount: wordCount || 0,
      date: todayStr(new Date(endedAt || Date.now())),
    };
  }

  // ---- [2] 연습시험 ----
  // format: "mc"(단어→뜻 객관식) | "typing"(뜻→단어 주관식). vocabTestService.buildVocabQuestions의
  // 기존 방향 코드(w2m/m2w)를 그대로 매핑만 한다 — 새 채점/생성 로직을 만들지 않는다.
  function directionForFormat(format) {
    return format === "typing" ? "m2w" : "w2m";
  }
  function buildPracticeQuestions(words, format) {
    const svc = window.SarahServices.vocabTestService;
    // 플래시카드 단어 데이터({en,ko})를 vocabTestService가 기대하는 {word,meaning,synonyms} 모양으로만
    // 바꿔준다 — 원본 워드뱅크에는 동의어 데이터가 없으므로 빈 배열(전역 동의어 사전/checkWordAnswer가
    // 여전히 관용적 유의어를 인정한다).
    const mapped = (words || []).map((w) => ({ word: w.en, meaning: w.ko, synonyms: [] }));
    return svc.buildVocabQuestions(mapped, directionForFormat(format));
  }
  function dayRangeLabel(dayRange) {
    const days = [...(dayRange || [])].sort((a, b) => a - b);
    if (days.length === 0) return "";
    if (days.length === 1) return `Day ${days[0]}`;
    // 연속 구간이면 "Day 1~3"처럼, 아니면 콤마로 나열.
    const isConsecutive = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    return isConsecutive ? `Day ${days[0]}~${days[days.length - 1]}` : `Day ${days.join(",")}`;
  }
  function buildPracticeTestRecord({ bookId, bookName, dayRange, questionCount, format, score, total }) {
    const now = Date.now();
    return {
      id: uidLocal(),
      bookId, bookName,
      dayRange: [...(dayRange || [])].sort((a, b) => a - b),
      dayLabel: dayRangeLabel(dayRange),
      questionCount, format, score, total,
      takenAt: now,
      date: todayStr(new Date(now)),
    };
  }

  // ---- [3] 선생님 복습 현황 ----
  function daysSince(dateStr) {
    if (!dateStr) return null;
    try {
      const then = new Date(dateStr + "T00:00:00");
      const now = new Date(todayStr() + "T00:00:00");
      return Math.round((now - then) / 86400000);
    } catch { return null; }
  }
  // 오늘 복습=민트(good) / N일 전(1~6일)=주황(warn) / 7일 이상 미복습(또는 기록 전혀 없음)=빨강(danger).
  function reviewStatusFor(days) {
    if (days == null) return { level: "danger", label: "기록 없음" };
    if (days <= 0) return { level: "good", label: "오늘 복습" };
    if (days < 7) return { level: "warn", label: `${days}일 전` };
    return { level: "danger", label: `${days}일째 미복습` };
  }
  function latestDate(dates) {
    const valid = (dates || []).filter(Boolean).sort();
    return valid.length ? valid[valid.length - 1] : null;
  }
  // roster + dataCache(studentId -> 학생 문서, 교사 로그인 시 이미 전부 불러와져 있음)에서 학생별
  // 요약 한 줄씩을 만든다. 오늘 학습시간은 flashcardSessions의 durationSec 합(분 단위로 올림),
  // 카드/연습시험 횟수는 오늘 날짜 기록 개수만 센다 — 단어별 오답 상세 같은 건 의도적으로 안 만든다
  // (요구사항: "단순히 현황을 보여주기만").
  function computeVocabReviewRoster(roster, dataCache) {
    const t = todayStr();
    return (roster || []).map((s) => {
      const data = (dataCache && dataCache[s.id]) || null;
      const sessions = (data && data.flashcardSessions) || [];
      const tests = (data && data.vocabPracticeTests) || [];
      const todaySessions = sessions.filter((x) => x.date === t);
      const todayTests = tests.filter((x) => x.date === t);
      const todaySeconds = todaySessions.reduce((sum, x) => sum + (x.durationSec || 0), 0);
      const last = latestDate([...sessions.map((x) => x.date), ...tests.map((x) => x.date)]);
      const days = daysSince(last);
      return {
        id: s.id,
        name: s.name,
        status: reviewStatusFor(days),
        lastDate: last,
        todayMinutes: Math.round(todaySeconds / 60),
        todayCardSessions: todaySessions.length,
        todayPracticeTests: todayTests.length,
      };
    });
  }
  function computeVocabReviewSummary(rows) {
    return {
      reviewedToday: (rows || []).filter((r) => r.status.level === "good").length,
      staleCount: (rows || []).filter((r) => r.lastDate == null || daysSince(r.lastDate) >= 7).length,
    };
  }

  // 2026-09-17 추가 — 학생 한 명의 flashcardSessions[]/vocabPracticeTests[]를 날짜별로 묶어
  // "오늘"뿐 아니라 과거 전체 기록을 볼 수 있게 한다. computeVocabReviewRoster와 같은 두 소스를
  // 그대로 재사용하되, "오늘"로 필터링하지 않고 date별로 합산한다는 점만 다르다.
  function computeVocabDailyHistory(data) {
    const sessions = (data && data.flashcardSessions) || [];
    const tests = (data && data.vocabPracticeTests) || [];
    const byDate = new Map();
    function bucket(date) {
      if (!byDate.has(date)) byDate.set(date, { date, seconds: 0, cardSessions: 0, practiceTests: 0 });
      return byDate.get(date);
    }
    sessions.forEach((s) => { if (s && s.date) { const b = bucket(s.date); b.seconds += s.durationSec || 0; b.cardSessions += 1; } });
    tests.forEach((t) => { if (t && t.date) bucket(t.date).practiceTests += 1; });
    return [...byDate.values()]
      .map((b) => ({ date: b.date, minutes: Math.round(b.seconds / 60), cardSessions: b.cardSessions, practiceTests: b.practiceTests }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 최신 날짜가 먼저
  }

  window.SarahServices.vocabReviewService = {
    buildFlashcardSessionRecord,
    buildPracticeQuestions,
    dayRangeLabel,
    buildPracticeTestRecord,
    daysSince,
    reviewStatusFor,
    computeVocabReviewRoster,
    computeVocabReviewSummary,
    computeVocabDailyHistory,
  };
})();
