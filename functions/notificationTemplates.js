// 푸시 알림 문구 기본값 + 선생님이 설정 화면에서 바꾼 문구(sarahsEnglishMeta/main.notificationTemplates)
// 를 합쳐서 최종 title/body를 만든다. index.html의 NOTIFICATION_CATALOG와 id/기본값을 맞춰 둘 것.
//
// 알림 모양: 제목 = "김주원 학생"(또는 "김주원 학생 학부모님"), 내용 = 한 일("로그인했어요"). 학생이 보낸 상세(detail)는
// 내용을 따로 바꾸지 않은 경우 내용 아래 줄에 덧붙는다.
// 치환 변수: {name} 학생 이름, {detail} 이벤트 상세(숙제 내용·점수 등), {count} 인원수, {title} 시험 이름, {time} 일시
// 저장 형태: notificationTemplates[id] = { emoji, title, body } — 값이 없거나 빈 문자열이면 기본값을 쓴다.

const DEFAULTS = {
  homework_upload: { emoji: "📸", title: "{name} 학생", body: "숙제 인증샷을 올렸어요" },
  study_start: { emoji: "⏱", title: "{name} 학생", body: "공부를 시작했어요" },
  study_resume: { emoji: "⏱", title: "{name} 학생", body: "공부를 이어서 시작했어요" },
  study_pause: { emoji: "⏸", title: "{name} 학생", body: "공부를 일시정지했어요" },
  study_log_saved: { emoji: "📗", title: "{name} 학생", body: "공부 기록을 저장했어요" },
  homework_done: { emoji: "✅", title: "{name} 학생", body: "숙제를 완료 표시했어요" },
  mock_exam_submit: { emoji: "📄", title: "{name} 학생", body: "모의고사 채점을 제출했어요" },
  student_login: { emoji: "👋", title: "{name} 학생", body: "로그인했어요" },
  parent_login: { emoji: "👪", title: "{name} 학생 학부모님", body: "로그인했어요" },
  consult_request: { emoji: "💬", title: "{name} 학생 학부모님", body: "상담을 신청했어요" },
  level_test_booking: { emoji: "🗓", title: "{name} 님", body: "레벨테스트·상담 예약 문의를 남겼어요" },
  vocab_test_start: { emoji: "🔤", title: "{name} 학생", body: "단어 시험을 시작했어요" },
  vocab_test_submit: { emoji: "🔤", title: "{name} 학생", body: "단어 시험을 제출했어요" },
  mock_test_start: { emoji: "📄", title: "{name} 학생", body: "모의고사 채점을 시작했어요" },
  exam_test_start: { emoji: "📝", title: "{name} 학생", body: "시험을 시작했어요" },
  exam_test_submit: { emoji: "📝", title: "{name} 학생", body: "시험을 제출했어요" },
  reading_log_submit: { emoji: "📖", title: "{name} 학생", body: "Reading Log를 제출했어요" },
  homework_assigned: { emoji: "📝", title: "새 숙제가 등록됐어요", body: "숙제 내용을 확인해 보세요." },
  mock_exam_assigned: { emoji: "📄", title: "새 모의고사가 등록됐어요", body: "모의고사가 등록됐어요." },
  vocab_test_assigned: { emoji: "🔤", title: "새 단어 재시험이 등록됐어요", body: "단어 재시험이 등록됐어요." },
  reminder_homework: { emoji: "", title: "{name} 학생", body: "오늘 숙제를 아직 안 했어요" },
  reminder_mock: { emoji: "", title: "{name} 학생", body: "모의고사 답을 아직 안 올렸어요" },
  reminder_teacher_summary: { emoji: "📌", title: "아직 안 한 게 있는 학생 {count}명", body: "{detail}" },
  retest_now: { emoji: "🔤", title: "{name} 학생", body: "지금 \"{title}\" 단어 재시험 시간이에요 ({time})" },
  retest_5min: { emoji: "🔤", title: "{name} 학생", body: "\"{title}\" 단어 재시험이 5분 후예요 ({time})" },
  test: { emoji: "🔔", title: "테스트 알림", body: "알림이 정상적으로 도착했어요!" },
};

function fill(str, vars) {
  return String(str).replace(/\{(name|detail|count|title|time)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

// custom: meta 문서의 notificationTemplates 객체(없어도 됨).
// 반환 body가 "" 이면 호출부의 기존 fallback(detail 등)을 그대로 쓰면 된다.
function renderNotification(id, custom, vars) {
  const d = DEFAULTS[id] || { emoji: "🔔", title: "새 알림", body: "" };
  const c = (custom && custom[id]) || {};
  const emoji = typeof c.emoji === "string" ? c.emoji : d.emoji;
  const titleText = fill(typeof c.title === "string" && c.title.trim() ? c.title : d.title, vars).trim();
  const title = emoji ? `${emoji} ${titleText}` : titleText;
  const hasCustomBody = typeof c.body === "string" && c.body.trim() !== "";
  return { title, body: fill(hasCustomBody ? c.body : "", vars).trim(), hasCustomBody, defaultBody: fill(d.body, vars).trim() };
}

module.exports = { DEFAULTS, renderNotification };
