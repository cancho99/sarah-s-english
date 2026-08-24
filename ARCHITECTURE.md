# Sarah's English — Architecture Report (Phase 0)

> 작성일: 2026-08-24. 이 문서는 현재 repository 전체(정적 HTML 4개 + Cloud Functions)를 읽고 작성한 현황 분석 + 재구조화 제안이다. **아직 코드는 한 줄도 수정하지 않았다.** 사용자 승인 전에는 대규모 migration이나 기존 기능 삭제를 하지 않는다(요청 원칙 §31).

---

## 0. TL;DR — 가장 중요한 3가지

1. **CLAUDE.md가 실제와 어긋나 있다.** "이 repo에는 Cloudflare Worker 외 서버 코드가 없다"는 설명과 달리, `functions/index.js`는 그 Worker를 대체하려고 만든 **완전한 AI 백엔드 이식본**이다(지문 변형/문제 생성/NELT 파싱/오답노트 변형/모의고사 등 6개 모드, Anthropic API 직접 호출). 그리고 CLAUDE.md의 3파일 구성(`index.html`/`wordtest.html`/`passage-transform.html`) 설명에는 **`reading-library.html`(1,096줄)이 통째로 빠져 있다** — 이 파일은 자체 Firestore 컬렉션 3개(`readingLibrary`, `readingVocab`, `readingJournal`)를 갖는, 사실상 4번째 핵심 페이지다.
2. **Firestore 컬렉션은 문서화된 4개가 아니라 11개다(Phase 4에서 `readingActivity` 추가로 10→11).** `sarahsEnglishMeta/main`, `sarahsEnglishStudents/{id}`, `sarahsEnglishWordbank/main`, `passageArchive` 외에 `readingLibrary`, `readingVocab/{id}`, `readingJournal/{id}`, `materialsLibrary`, `sharedMaterialsLibrary`, `materialDownloadLog`가 더 있다. 이 중 뒤 3개+wordbank는 `index.html`의 중앙 데이터 레이어(`App()`의 `loadStore`/`saveMeta`/`ensureData`/`updateData`)를 거치지 않고 leaf 컴포넌트가 직접 읽고 쓴다.
3. **매출관리(Business), Reading, Roadmap 기능은 이미 존재한다** — 요청서가 "새로 만들라"고 한 것처럼 보이는 기능 중 상당수가 이미 구현돼 있다: `tuitionRecords`(학생 doc) + `RevenueOverviewSection`(매출 집계), `roadmap`(학생 doc) + `ParentRoadmapSection`, `monthlyReports`/`MonthlyReportView`(월간 리포트), `attendance`(출결). 이것들을 삭제 후 재작성하는 게 아니라 **재배치/재구성**하는 게 이번 작업의 실제 성격이다.

---

## 1. Current Architecture

### 1.1 페이지 구성 (A)

| 파일 | 줄 수 | 프레임워크 | 역할 |
|---|---|---|---|
| `index.html` | 9,618줄 (~674KB) | React 18 UMD + `htm` (JSX 없음, 빌드 없음) | 메인 앱 — 교사/학생/학부모 포털 |
| `reading-library.html` | 1,096줄 | 순수 JS/DOM | 영어 동화·소설 리딩 라이브러리 + 학생별 단어장/독서기록 (**CLAUDE.md 미기재**) |
| `wordtest.html` | 930줄 | 순수 JS/DOM | 단어시험지 생성/관리 |
| `passage-transform.html` | 703줄 | 순수 JS/DOM | AI 지문 변형/문제 생성 + 아카이브 |
| `functions/index.js` | 935줄 | Firebase Functions v2 (Node 20) | AI 프록시 6모드 + FCM 알림 2종 + 스케줄 알림 2종 |

4개 HTML 모두 **동일한 `firebaseConfig`를 각자 인라인으로 복붙**하고 있다(`index.html:108-117`, `reading-library.html:188-197`, `wordtest.html:262-271`, `passage-transform.html:265-274`) — 프로젝트 설정이 바뀌면 4곳을 손으로 고쳐야 한다.

임베딩 관계:
```
index.html
 ├─ <iframe src="wordtest.html">              (WordbankSection)
 ├─ <iframe src="reading-library.html#admin"> (ReadingLibraryAdminSection)
 ├─ <iframe src="passage-transform.html">     (PassageToolSection)
 ├─ <iframe src="passage-transform.html#archive"> (ArchiveSection)
 └─ <a href="reading-library.html?student=<id>&name=<name>">  (학생 홈에서 링크 이동, 임베딩 아님)
```
**iframe 간 `postMessage`/`contentWindow` 통신은 전혀 없다** (전체 grep 확인). 부모-자식 페이지는 URL 해시(`#admin`, `#archive`)로 초기 모드만 전달하고, 이후 상태 공유는 전부 같은 Firebase 프로젝트를 통해서만 이뤄진다. 즉 오늘 시점엔 "DOM 경계를 넘는 이벤트/상태 브릿지"를 고려할 필요가 없다는 뜻이지만, 반대로 나중에 실시간 연동(예: 학생이 리딩 라이브러리에서 읽은 걸 index.html 대시보드에 즉시 반영)이 필요해지면 새로 만들어야 한다.

### 1.2 `index.html`의 React/htm 구조 (B)

- 로딩: `<script defer>`로 React 18 UMD + `htm` + `pdf.js` CDN 로드, Firebase는 `<script type="module">`로 별도 로드되며 필요한 함수들을 전부 `window.__db`/`window.__doc`/`window.__getDoc`/... 형태로 전역에 걸어둔다(`:104-140`) — 이래야 모듈이 아닌 이후의 일반 `<script>`(앱 본체, `:148-9615`)가 그것들을 쓸 수 있기 때문. 이 "모듈→전역 브릿지" 자체가 향후 진짜 ES 모듈 구조로 옮길 때 반드시 없애야 할 임시 다리다.
- `App()` (`:1294-1517`, 약 224줄)이 유일한 최상위 상태 소유자: `roster`, `teacherAuth`, `levelTestBookings`, `announcement`, `examKeyLibrary`, `teacherTodos`, `sharedDriveFolderLink`, `session`, `dataCache`, `selectedStudentId`. `screen` 상태值로 화면을 전환한다(라우터 없음).
- `screen` 값: `home`(마케팅 랜딩) / `teacherDash` / `studentDash` / `parentDash` / 모달 3종(`levelTest`, `teacherLogin`, `studentLogin`/`parentLogin`).
- 세 대시보드 내부에 **각자 독립적인 2차 상태 머신**이 있다 — `TeacherDash.section`(+`studentCategory`/`selectedStudentId`), `StudentDash.tab`, `ParentDash.tab`. 총 4개의 서로 조율되지 않는 네비게이션 상태가 공존하며, 어느 것도 URL로 표현되지 않는다(뒤로가기/딥링크/북마크 불가).
- 공용 프리미티브(`Card`/`Button`/`Field`/`Tabs`/`SideNav`/`Shell`/`Empty`/`Modal`/`TopBar`/`SectionLabel`/`BackBtn`)는 파일 상단(`:1130-1289`)에 정의돼 있고 전체 앱이 이를 재사용한다. 다만 `Tabs`는 실제로는 잘 안 쓰이고, 대부분의 화면 전환은 `SideNav`/아이콘그리드/버튼배열로 각자 구현돼 있다.
- CSS는 반응형 어드민 셸(`.ap-*` 클래스 + `@media max-width:760px`)만 진짜 CSS로 스코프돼 있고, 나머지 전부는 공유 색상 토큰 객체 `C`를 쓰는 **인라인 `style={{...}}`**다. 충돌 위험은 낮지만 재사용/캐싱이 안 되고 매우 장황하다.
- **`App()`이 실제로 거대한 함수는 아니다.** 진짜 거대한 건 `TeacherDash`가 렌더하는 서브트리(`StudentsSection`→`StudentTabBody`→15개 에디터, 대략 `:2817~7507`, ~4,690줄)와 `StudentDash`(`:7508~9380` 범위 안에서 헬퍼 다수 공유). `ParentDash`(`:9381-9517`, ~137줄)는 오히려 작은데, Teacher/Student 쪽 컴포넌트(`HomeworkProgressCard`, `MaterialsLibrarySection`, `ParentMonthlyReportCard` 등)를 `readOnly`/`viewerStudent` 같은 prop 플래그로 재사용하기 때문 — 재사용은 잘 되고 있지만 그만큼 공유 컴포넌트가 3곳 호출부의 가정을 동시에 만족해야 한다.

### 1.3 Firebase 구조 (C)

- 프로젝트 id: `sarah-s-english` (`.firebaserc`). **Firebase Hosting은 설정돼 있지 않다** (`firebase.json`에 `functions` 키만 있음) — 실제 사이트는 GitHub Pages(`https://cancho99.github.io/sarah-s-english/`)에서 서빙되고, `functions/index.js`의 CORS 허용 목록(`ALLOWED_ORIGINS`, `:23-26`)도 `https://cancho99.github.io`와 `http://localhost:8080`만 허용한다.
- **Firestore 보안 규칙 파일이 repo 어디에도 없다** (`firestore.rules` 검색 결과 없음, `firebase.json`에 `firestore` 키도 없음) — 접근 제어는 Firebase Console에서 관리되고 있고 이 repo에서는 감사 불가능하다. 매출/개인정보(주소·생년월일·연락처)가 걸린 프로젝트인 만큼, 규칙 관리를 repo로 끌어오는 것을 Phase 1 이전에 짧게 짚고 넘어갈 가치가 있다(선택사항으로 사용자에게 확인 필요, 이번 요청 범위 밖일 수 있음).
- Firestore 쓰기는 두 가지 패턴이 공존한다: (a) `sarahsEnglishMeta`/`sarahsEnglishStudents`는 `App()`이 소유하고 전부 `runTransaction` 기반 read-modify-write(`updateData`, `updateStudentRosterEntry`, `addTeacherFcmToken`)로 나간다. (b) `materialsLibrary`/`sharedMaterialsLibrary`/`materialDownloadLog`/`sarahsEnglishWordbank`(읽기)는 leaf 컴포넌트가 모듈 레벨 헬퍼 함수로 직접 접근한다 — 의도적 설계(1MB 캡을 피하려고 큰 base64를 별도 컬렉션에 분리)지만, "Firestore 접근은 전부 한 데이터 레이어를 거친다"는 가정은 컬렉션의 약 1/3에는 적용되지 않는다.

---

## 2. Current Firestore Schema

### 2.1 컬렉션 전체 목록 (11개, Phase 4에서 `readingActivity` 추가)

| 컬렉션 | 소유 파일 | 구조 |
|---|---|---|
| `sarahsEnglishMeta/main` | index.html | 단일 meta 문서 |
| `sarahsEnglishStudents/{studentId}` | index.html | 학생당 1문서 |
| `sarahsEnglishWordbank/main` | wordtest.html (index.html·reading-library.html이 읽기/쓰기로 개입) | 단일 문서, 교재별 Day 단어장 |
| `passageArchive` | passage-transform.html | 저장 결과당 1문서 |
| `readingLibrary` | reading-library.html | 스토리당 1문서 |
| `readingVocab/{studentId}` | reading-library.html | 학생당 1문서 |
| `readingJournal/{studentId}` | reading-library.html | 학생당 1문서 |
| `readingActivity/{studentId}` | reading-library.html (Phase 4 신규) | 학생당 1문서 — 읽기 상태/시간, §8.1 |
| `materialsLibrary` | index.html | 자료당 1문서 (학생 개인 자료실) |
| `sharedMaterialsLibrary` | index.html | 자료당 1문서 (전체 공유 자료실) |
| `materialDownloadLog` | index.html | 다운로드 이벤트당 1문서 |

### 2.2 학생 데이터 schema (D) — `sarahsEnglishStudents/{studentId}`

`emptyData()`(`index.html:821`)가 선언하는 기본 필드:
```js
{
  logs: [], scores: [], feedback: [],           // scores/feedback는 죽은 필드 — 아래 참고
  homework: [], vocabTests: [], examTests: [],
  vocabResults: [], examResults: [],
  mockExams: [], mockExamResults: [],
  vocabLog: [], regularExams: [],
  consultRequests: [], tuitionRecords: {},
  notes: [], roadmap: null,
}
```
**`emptyData()`에 빠져 있지만 실사용 중인 필드 7개** (전부 `data.field || 기본값` 폴백 패턴으로만 존재):
```js
hourlyRate, sessionHours          // 시급/회당 시간 — index.html:8077-8093
activeTestSession                 // {type,testId,testTitle,startedAt}|null — 응시중 배지용, :7634-7642
studyLog                          // 학습 타이머 세션 배열 — :1642, 7621-7662
neltResults                       // NELT 성적표 파싱 결과 배열 — :5441, 5490
attendance                        // { "YYYY-MM-DD": {status, makeupDone} } — :4898-4915
monthlyReports                    // { "YYYY-MM": {...} } — :5871-5921
monthlyStats                      // { "YYYY-MM": {hwTotal,hwDone,vocabTotal,vocabPassed} } — :657-693, 오래된 달 정리 후 집계 보존용
dailyReports                      // { "YYYY-MM-DD": {text, published, updatedAt} } — DailyReportGenerator, :5761/:5790. Phase 0 최초 감사에서 누락됐다가 Phase 1(services/reportService.js) 작업 중 확인됨.
```
**죽은 필드**: `scores[]`는 어디서도 안 쓰인다(선언만 존재). `feedback[]`은 한 곳(`:9090`)에서 읽기만 하고 쓰는 곳이 없다. 새 구조 설계 시 둘 다 마이그레이션 대상에서 제외해도 안전하다.

### 2.3 숙제 schema (E)
```js
{ id, assignedDate, dueDate, content, done: false, photos: [] }
// 이후 추가되는 필드: doneAt, expired
// photos: [{ url: dataURL, uploadedAt }]  — 레거시는 단일 `photo` 문자열 필드, withoutLegacyPhoto()로 정리
```
사진 예산: 숙제 1건당 총 550,000바이트, 장당 180,000바이트 상한(`:8817-8821`).

### 2.4 시험 schema (F) — 3계통이 공존

```js
// examTests[] — 교사가 직접 만든 시험
{ id, title, date, questions: [
  { q, type: undefined|"mc", choices: [], answer: number },      // 객관식
  { q, type: "subjective", answer: string, synonyms?: [] }        // 서술형
]}
// examResults[]
{ id, testId, date, score, total, breakdown: [{prompt, given, correct, ok, manualOverride?}] }

// mockExams[] — 공식 모의고사 정답지
{ id, title, date, pageRange, answerKey: number[] }
// mockExamResults[]
{ id, testId, date, score, total, wrong: number[], answers, startedAt, submittedAt, editedAt? }

// regularExams[] — 내신/모의고사/교재성취평가 성적 기록 (진짜 "성적표"에 가까움)
{ id, date, examType, examDetail, subject, score, scoreNum, target, note, materialCategory? }
// examType ∈ [중간고사,기말고사,모의고사,교재성취평가,기출고사,기타]
```

### 2.5 단어시험 schema (G)
```js
// vocabTests[]
{ id, title, date, words: [{word, meaning, synonyms: []}], mode: "mix"|"w2m"|"m2w", retestDate, retestTime, expired? }
// vocabResults[]
{ id, testId, date, score, total, breakdown, startedAt, submittedAt }
// vocabLog[] — 별도의, 더 단순한 세션 로그(오래된 흐름으로 추정)
{ id, date, book, range, correct, total, score, passed, retest }
```
통과 기준: 제목에 "누적" 포함 시 90%, 아니면 80% (`vocabPassThreshold`, `:635`).

### 2.6 Reading schema (H)

`index.html` 자체에는 리딩 로그가 전혀 없다 — 전부 `reading-library.html` 소유 3개 컬렉션에 있다.
```js
// readingLibrary/{autoId}
{
  title, level: 1-10, category: "Fiction"|"Nonfiction"|"Informational",
  genre, source, sourceUrl, license, text,
  vocabulary: [ {word, meaning, example} | {word, pos, meaningInContext, example} ],  // 레벨에 따라 3/4필드 혼용
  journalLevel: "1-3"|"4-6"|"7-8"|"9-10",
  createdAt,
}
// readingVocab/{studentId}
{ words: [{ word, meaning, source, addedAt }] }
// readingJournal/{studentId}
{ entries: [{ id, storyId, storyTitle, level, tier, answers: [{q,a}], submittedAt }] }
```
Level 1~10 / 초3~고3 커리큘럼은 **완전히 JS 하드코딩**(`LEVELS`/`GRADE_BY_LEVEL`, `reading-library.html:359-363`)이며, 스토리의 `level` 값이 실제로 그 설계를 따르는지 강제하는 검증은 없다. "읽음/완료" 플래그 자체가 없다 — 단어를 클릭했거나 독서기록을 썼을 때만 흔적이 남는다.

### 2.7 Report schema (I)

```js
// data.monthlyReports["YYYY-MM"]
{
  ratings: { vocab, grammar, reading, writing, attitude, homework: "매우 우수"|"우수"|"보통"|"노력 요함" },
  attendance: { classDays, attended, absent, hwRate, vocabRate },  // tuitionRecords와 무관한 요약 스냅샷
  content, good, improve, comment, nextMonth, neltComment,
  published: bool,
}
```
학부모는 `published === true`인 것만 본다(`ParentDash`). 출력은 실제 PDF 생성 라이브러리가 아니라 **새 창을 열어 HTML을 그린 뒤 브라우저 인쇄**하는 방식(`MonthlyReportView.printReport`, `:5967-6087`) — `TuitionEditor`의 청구서 인쇄(`:8246-8250`)도 동일 패턴을 독립적으로 복붙해 구현했고, `wordtest.html`/`passage-transform.html`도 각자 또 구현했다. 총 4곳에 유사한 "새 창 인쇄" 로직이 중복돼 있다.

**Phase 3 갱신 (2026-08-24)**: Phase 3 착수 전 실제 코드를 다시 확인한 결과 — `data.dailyReports["YYYY-MM-DD"]`는 원래 `{ text, published, updatedAt }`뿐인, `logs`/`vocabLog`/`homework`에서 자동 생성된 **자유 텍스트 한 블록**이었다(`buildDailyReportText`, `DailyReportGenerator` — 학부모께 보낼 문자 메시지 초안 도구에 가까움. 구조화된 필드는 전혀 없었다). Phase 3에서 다음을 **추가**했다(기존 `text`/`published`/`updatedAt`는 그대로 유지, 별개 필드로 병존):
```js
// data.dailyReports["YYYY-MM-DD"] — text/published/updatedAt(기존, 그대로) +
{
  status: "DRAFT" | "COMPLETED" | "REVIEWED",
  lessonInfo: { textbook, unit, classDuration, actualDuration },
  lessonContent: { grammar, reading, vocabulary, writing, listening, other },
  ratings: { focus, participation, comprehension, homeworkDiligence },  // 1~5, DailyReportWorkspace의 신규 "수업 평가" — data.monthlyReports.ratings(vocab/grammar/reading/writing/attitude/homework, 월 1회 수동 평가)와는 별개의, 일 단위 평가다.
  teacherComment: { good, improve, next, note },
}
```
`getReportStatus()`(services/reportService.js)가 하위호환을 처리한다: `status` 필드가 없는 기존 리포트는 `published:true`면 COMPLETED, 아니면 DRAFT로 간주 — 기존 데이터에 아무것도 새로 쓰지 않는다.

Homework/Vocabulary/Exam/Reading은 Daily/Monthly Report에 복제 저장하지 않고, 매번 각자의 원본 소스(`data.homework`/`data.vocabTests`+`vocabResults`/`data.regularExams`+`mockExamResults`+`examResults`/`readingVocab`+`readingJournal`)에서 `services/*.js`를 통해 실시간 계산한다 — 상세는 §7 참고.

### 2.8 매출관리(Business) schema (J)

이미 구현돼 있다 — 신규 기능이 아니라 재배치 대상:
```js
// data.tuitionRecords["YYYY-MM"]
{
  plannedCount, hourlyRate, sessionHours, calculatedAmount, sessionDates,
  managementFee, overrideAmount, note, amount,
  published, paid, paidAt, confirmed, updatedAt,
}
```
`plannedCount`/`calculatedAmount`/`sessionDates`는 스케줄에서 실시간 계산되다가 `confirmed:true`가 되면 값이 고정된다. `RevenueOverviewSection`(`index.html:2710-2809`, 교사 전용 "매출" 탭)은 **별도 매출 컬렉션 없이** 전 학생의 `tuitionRecords`를 순회 집계해서 월 매출/미입금/6개월 추이를 만든다.

### 2.9 기타 컬렉션 (요청서 A-N에는 없지만 발견됨)

```js
// sarahsEnglishMeta/main.roster[]  — 학생 1명당
{
  id, name, studentCode, parentCode, school, grade, birthdate, address, driveFolderLink,
  lastStudentLoginAt, lastParentLoginAt, studentFcmToken, parentFcmToken,
  schedule: [{day,time,endTime}],              // 레거시
  scheduleMonth,                                 // 레거시
  scheduleByMonth: { "YYYY-MM": [{day,time,endTime}] },   // 현재 소스
  monthlyInstances: { "YYYY-MM": [{date,time,endTime,type}] },
  tutoringExceptions: [{date,time,endTime}],
}
// data.roadmap  — 이미 구현된 "로드맵"
{
  finalGoal, currentPhaseIndex, overallNotes, currentLevelLabel, targetLevelLabel,
  skills: [{label,current,target,pct,nextFocus}],
  whyRoadmap: null | {diagnosis,priority,intervention,outcome},
  phases: [blankPhase(1)..blankPhase(5)],   // 생성 시 항상 5개
}
// data.consultRequests[]  — 상담 요청(요청서의 "상담/메모" 중 상담 부분)
{ id, createdAt, method, note, status:"대기", choices:[{date,time}] }  // 최대 3개 후보
// data.notes[]  — 교사 메모(상담/메모 중 메모 부분)
{ id, content, createdAt }
// materialsLibrary / sharedMaterialsLibrary
{ title, subject, level, note, fileName, fileType, fileSizeKB, dataUrl, studentId?, createdAt }
// materialDownloadLog
{ materialId, materialTitle, shared, studentId, studentName, downloadedAt }
```

---

## 3. Current Feature Map

### TeacherDash (`index.html:2817`) — nav 항목 13개 + 학생별 드릴다운 탭 15개

| section | 설명 |
|---|---|
| `mainpage` | 오늘 할 일 종합 대시보드(TeacherOverview) — **요청서 §4 "Teacher Center"가 요구하는 화면과 사실상 동일 개념이 이미 있음** |
| `studentInfo` | 학생 정보 CRUD |
| `students` | 학생별 데이터 15개 탭(아래) |
| `schedule` | 전체 수업 일정 |
| `bookings` | 레벨테스트/상담 예약함 |
| `passage` / `archive` | AI 지문 변형 도구 (iframe) |
| `wordbank` | 단어시험 관리 (iframe) |
| `examkeys` | 정답표 라이브러리 (AI vision PDF 파싱) |
| `readingLibrary` | 리딩 라이브러리 관리 (iframe) |
| `reports` | Daily/Monthly Report |
| `revenue` | 매출 개요 |
| `settings` | 교사 비밀번호 |
| `hwstatus` | 숙제 현황판 (nav엔 없고 mainpage에서만 진입) — **요청서 §4 "오늘 확인할 숙제" 요구사항과 거의 일치** |

학생별 15개 탭: `logs`(학습기록), `notes`(메모), `progress`(현황), `todo`, `vocabLog`, `dailyReport`, `homework`, `vocab`, `mock`, `examTests`, `wrongNote`(오답노트+AI 변형), `regularExam`(성적), `materials`, `consult`, `storage`(용량 정리). + 데스크톱 전용 `attendance`(출결).

### StudentDash / ParentDash

StudentDash: 홈/`studyTimer`/`homework`/`vocab`/`mock`/`examTests`/`materials`/`schedule`. ParentDash는 의도적으로 더 좁음 — 시험 응시 탭 없음, `materials` 없음, `published`된 report/tuition만, 대신 `roadmap`(학생 쪽엔 전용 탭이 없음)과 `studyTime`(읽기전용 집계)을 가짐.

### reading-library.html / wordtest.html / passage-transform.html

기능 인벤토리는 §2.6, CLAUDE.md 원문에 이미 정확히 기술돼 있어 반복하지 않음. 다만 `reading-library.html`은 관리자 모드(`#admin`)에서 스토리 CRUD + 학생별 단어장/독서기록 열람 + 선택 단어를 wordtest.html 단어장으로 전송 + 온라인 단어시험 생성까지 수행하는, CLAUDE.md 미기재 대비 실제로는 매우 무거운 페이지다.

---

## 4. Current Data Dependencies (L)

```
sarahsEnglishMeta/main ──┬── index.html (App, 중앙 관리)
                          └── functions/index.js (읽기 전용: roster/teacherFcmTokens)

sarahsEnglishStudents/{id} ──┬── index.html (App, 중앙 관리, updateData 트랜잭션)
                               ├── reading-library.html (vocabTests 배열에 트랜잭션으로 append)
                               └── functions/index.js (읽기 전용: homework/mockExams/vocabTests)

sarahsEnglishWordbank/main ──┬── wordtest.html (소유, 중앙 관리)
                               ├── index.html VocabEditor (읽기, App() 우회 — window.__doc 직접 호출)
                               └── reading-library.html sendToWordbank() (쓰기 — books/days/day1/{en,ko} 구조를 코드 공유 없이 하드코딩)

passageArchive ── passage-transform.html (단독 소유, 다른 파일 접근 없음)

readingLibrary / readingVocab / readingJournal ── reading-library.html (단독 소유)
   └─ readingVocab에서 선택한 단어 → sarahsEnglishWordbank로 전송 (위 참고)

materialsLibrary / sharedMaterialsLibrary / materialDownloadLog ── index.html
   (App()을 거치지 않는 모듈 레벨 헬퍼 함수로 직접 접근)
```

**functions/index.js `aiWorker`는 Firestore를 전혀 건드리지 않는 순수 프록시**다 — 호출부(`passage-transform.html`, `index.html`의 NELT/정답표/오답노트 변형 화면)가 응답을 받아 각자의 컬렉션에 저장하는 구조.

---

## 5. Existing Functions (K) — `functions/index.js`, Firebase Functions v2, `us-central1`

| 함수 | 트리거 | 역할 |
|---|---|---|
| `aiWorker` | `onRequest` (secret: `ANTHROPIC_API_KEY`) | 단일 엔드포인트, `mode`로 분기: (기본)문제생성 / `transform`지문변형 / `monthlyReport`월간리포트초안 / `examkey`정답표AI비전파싱 / `examVariant`오답노트변형생성 / `nelt`NELT성적표파싱. 전부 Anthropic Messages API를 raw `fetch`로 직접 호출(SDK 미사용). `claude-haiku-4-5-20251001`(기본/변형/변형생성/리포트/NELT) + `claude-sonnet-5`(정답표 비전 파싱, 정확도 우선). **Firestore 접근 없음.** |
| `notifyTeacher` | `onRequest` | `sarahsEnglishMeta/main.teacherFcmTokens`로 data-only FCM 발송, 이벤트 종류 11가지 |
| `notifyStudent` | `onRequest` | 호출자가 넘긴 토큰 1개로 FCM 발송, 이벤트 3가지 |
| `sendTestNotification` | `onRequest` | 알림 테스트용 단발 발송 |
| `homeworkReminderCheck` | `onSchedule` (매시 정각, 15-23시 KST) | 학생별 미완료 숙제/모의고사 스캔 → 학생(매시간)/학부모(15시 1회)/교사(종합) 푸시 |
| `vocabRetestReminderCheck` | `onSchedule` (매분) | `vocabTests[].retestDate/retestTime` 스캔 → 정시/5분전 알림 |

`firebase-messaging-sw.js`는 모든 발송이 data-only(FCM `notification` 필드 미사용)인 이유(포그라운드/백그라운드 표시 로직 통일)에 맞춰 `onBackgroundMessage`에서 `showNotification`을 직접 호출한다. `notificationclick` 핸들러는 없음(클릭 시 커스텀 동작 없음).

`functions/package.json`: Node 20, 의존성은 `firebase-admin`/`firebase-functions`뿐 — **`@anthropic-ai/sdk` 없음**(raw fetch 사용).

---

## 6. Problems (M, N)

### M. 중복되거나 지나치게 결합된 코드

1. **"새 창 인쇄" 로직이 4곳에 독립 구현**: `index.html`의 `MonthlyReportView.printReport()`(`:5967-6087`)와 `TuitionEditor` 청구서 인쇄(`:~8246-8250`), `wordtest.html`의 `printSheet()`, `passage-transform.html`의 print 핸들러. 견고함이 제각각이다 — `wordtest.html`만 `printed` 가드 + onload/700ms 폴백 타이머 + 팝업 차단 시 인라인 인쇄 폴백까지 갖췄고, `passage-transform.html`은 단일 300ms 타이머뿐이라 가장 취약하다.
2. **`firebaseConfig` 4중 복붙** — 프로젝트 설정 변경 시 4개 파일을 손으로 동기화해야 함.
3. **`reading-library.html` ↔ `wordtest.html`/`index.html` 스키마 결합**: `sendToWordbank()`가 wordbank의 `books/days/day1/{en,ko}` 구조를, `createOnlineVocabTest()`가 index.html의 `vocabTests` 구조를 공유 코드 없이 하드코딩. 한쪽 스키마가 바뀌면 다른 쪽이 조용히 깨진다.
4. **`index.html` 내부 상태 이중 관리**: 모듈 레벨 `let store`(`:194`)가 React 상태와 나란히 수동으로 동기화된다(`if (store) store.X = ...`가 거의 모든 setter에 반복). 둘 중 하나만 갱신하면 드리프트 발생 — 이번 감사에서 실제로 몇 군데 setter가 그렇게 돼 있는지까진 확인하지 않았지만, 패턴 자체가 위험 소지다.
5. **Firestore 접근 3분의 1가량이 중앙 데이터 레이어 우회**: `materialsLibrary`/`sharedMaterialsLibrary`/`materialDownloadLog`(쓰기까지)와 `sarahsEnglishWordbank`(읽기)는 leaf 컴포넌트가 직접 호출한다.
6. ~~(Phase 3에서 발견) 학부모 월말리포트 화면에 "숙제/단어" 관련 지표가 두 세트 나란히 노출됨~~ — **Phase 4 STEP 1에서 해결함.** §7 "Historical Snapshot vs Live Analytics" 참고.

### N. 리팩토링 위험 요소

1. **9,618줄 단일 파일, 빌드 없음, `htm` 태그드 템플릿(JSX 아님)**. 모듈화하려면 "번들러 없이 CDN 스크립트 로딩 순서를 유지하면서 어떻게 코드를 여러 파일로 쪼갤 것인가"부터 풀어야 한다. React/htm은 ESM으로 바로 못 옮긴다(전역 `window.__db` 브릿지가 그 증거).
2. **CLAUDE.md 자체가 부정확** — 그대로 믿고 설계하면 안 되는 지점 2곳: (a) AI 백엔드가 Worker 단독이 아니라 `functions/index.js`와 이중화돼 있음, (b) `reading-library.html`이 문서에서 완전히 빠짐. Phase 1 착수 전에 CLAUDE.md 갱신을 권장(선택, 승인 필요).
3. **`emptyData()`가 스키마 문서로서 신뢰 불가** — 실사용 필드 7개가 빠져 있다. 새 스키마를 설계할 때 `emptyData()`만 보고 판단하면 안 되고, 위 §2.2 표를 참고해야 한다.
4. **네비게이션 상태 4중 분열**(App.screen / TeacherDash.section / StudentDash.tab / ParentDash.tab) — 전부 React state뿐, URL 비반영. 요청서가 원하는 "HOME / TEACHER CENTER / STUDENTS / ..." 같은 상위 네비게이션 구조로 재편하려면 이 4개를 하나의 라우팅 개념으로 통합할지, 아니면 유지한 채 상위에 한 겹 더 씌울지 결정이 필요함(§7에서 제안).
5. **Firestore 보안 규칙이 repo 밖에 있다** — 새 컬렉션(예: `dailyReports`, `grammarQuestions`)을 추가해도 이 repo만 봐서는 권한 설계가 맞는지 검증할 수 없다.
6. **정답표 파싱은 CLAUDE.md가 설명한 로컬 텍스트 파서(`extractPdfTextForKeys`/`parseExamKeyPdfText`)가 이미 폐기되고 AI 비전 파싱으로 대체된 상태** — 문서와 코드가 어긋난 또 하나의 사례. 마스너리형(단마다 배치가 다른) 정답지 레이아웃 때문에 좌표 클러스터링이 실패해서 버린 것으로 코드 주석에 명시돼 있음 — 향후 "Grammar/Reading Exam Builder"에서 유사한 PDF 파싱이 필요하면 로컬 파서보다 AI 비전 경로를 우선 고려해야 함.
7. **`passage-transform.html`에 쓰이지 않는 `.sidenav` CSS**(장식용으로 만들었다가 실제 DOM엔 없음) — 사소하지만 정리 대상.
8. **`reading-library.html`이 문서화 안 된 Google 번역 공개 엔드포인트에 의존** — 폴백 없음, 차단되면 리딩 라이브러리의 "단어 클릭 → 자동 번역" 기능 전체가 조용히 멈춤.
9. **실데이터에서 확인된 로스터-학생문서 불일치 (조사 완료, 2026-08-24)**: `sarahsEnglishStudents` 컬렉션에 `sarahsEnglishMeta/main.roster`(8명)에는 없는 학생 문서가 1건 존재한다. **원인 코드까지 특정했다** — `removeStudent(id)` (`index.html:2856-2859`, `TeacherDash` 내부)는 `saveRosterList(roster.filter(...))`로 로스터 배열에서만 해당 학생을 지우고, `sarahsEnglishStudents/<id>` Firestore 문서 자체는 **한 번도 삭제하지 않는다.** 즉 교사가 "학생 정보"에서 학생을 삭제할 때마다 구조적으로 이런 orphan 문서가 만들어진다 — 이번 건은 우연한 1건짜리 사고가 아니라 재현 가능한 설계상의 동작이다.

   **문서 상세** (읽기 전용 조사, 데이터는 수정/삭제하지 않음):
   - Document ID: `sarahsEnglishStudents/mrn5c405it3kwv`
   - homework: 5건 (전부 `done:false`, `assignedDate`/`dueDate` 전부 2026-07-16~07-17)
   - logs (학습기록): 1건 (2026-07-16, 내용 중 "이하준] 7/16(목) 수업 안내"로 학생 이름 추정 가능)
   - vocabTests: 1건 ("Day 1-5 누적 재시험", 2026-07-16, 40단어)
   - feedback: 1건 (2026-07-16) — **주의**: `ARCHITECTURE.md`의 기존 §2.2는 `feedback[]`을 "죽은 필드(현재 코드에 쓰는 곳 없음)"로 분류했고 그 판단 자체는 여전히 맞다(현재 `index.html`에 `feedback`을 쓰는 코드가 없음, `:9149`에서 읽기만 함) — 다만 이 문서에 실제 `feedback` 데이터가 남아 있다는 것은, **과거 어느 시점엔 이 필드를 쓰는 코드가 존재했다가 이후 제거됐다**는 뜻이다. 지금 코드만 보고 "한 번도 안 쓰인 필드"라고 오해하면 안 된다는 근거로 기록해 둔다.
   - 데이터 시점: 확인 가능한 모든 날짜(homework/logs/vocabTests/feedback)가 **2026-07-16~2026-07-17**로 일관됨 — 이 학생의 수업이 그 무렵 종료되고 이후 로스터에서 삭제된 것으로 추정된다(추정일 뿐, 확정 아님).
   - **`removeStudent` 외에 이 문서를 생성/수정하는 다른 코드 경로**: 일반적인 학생과 동일하게 `updateData(id, updater)`(`index.html:1387-1404`, `HomeworkEditor`/`LogsEditor`/`VocabTestEditor` 등에서 호출)가 생성 당시 이 문서를 썼을 것이다 — 학생이 로스터에 있던 동안은 여느 학생과 똑같은 코드 경로를 탔고, 로스터 삭제 이후로는 어떤 코드도 이 문서를 건드리지 않는다(고아가 된 뒤로는 조용히 방치됨).

   **TODO (구현하지 않음, 향후 Phase 후보로만 기록)**: 교사 관리 화면에 "Unlinked Student Data" / "Orphaned Student Data" 패널을 추가해, `sarahsEnglishStudents`를 컬렉션째로 스캔해 로스터에 없는 문서 ID를 나열하고(이미 `services/studentService.js`의 `getAllStudentDocs()`가 컬렉션 전체를 읽으므로 로스터와 diff만 뜨면 됨), 교사가 직접 보고 "복구(로스터에 재등록)" 또는 "영구 삭제"를 선택하게 하는 화면. **지금은 만들지 않는다** — 사용자가 명시적으로 보류를 지시함.

## 6.1 Historical Snapshot vs Live Analytics (Phase 4 STEP 1, 2026-08-24)

Phase 3에서 학부모 월말리포트 화면에 같은 의미의 지표(숙제/단어 관련)가 서로 다른 두 값으로 동시에 노출되는 문제가 발견됐다(§6-M-6, 해결됨). 재발 방지를 위해 이 프로젝트에서 "저장된 스냅샷"과 "실시간 계산값"을 구분하는 원칙을 명문화한다.

**두 종류의 숫자가 이 앱에는 원래부터 공존한다:**

| | Historical Snapshot | Live Analytics |
|---|---|---|
| 예시 | `data.monthlyReports[month].attendance` (`{classDays, attended, absent, hwRate, vocabRate}`) | `services/homeworkService.js`의 `getMonthlyHomeworkStats()` 등 |
| 언제 계산되는가 | 교사가 `MonthlyReportView`에서 그 리포트를 만들 때 1회 계산되어 **저장**됨. 이후 교사가 수기로 고칠 수 있음(예: 결석 처리를 나중에 조정) | 화면을 열 때마다 원본 데이터(`homework`/`vocabTests`+`vocabResults`/`regularExams`/`logs`/`readingVocab`+`readingJournal`)에서 **매번 다시 계산**됨. 저장되지 않음 |
| 나중에 원본 데이터가 바뀌면? | 안 바뀜 (저장 당시 값 그대로 고정) | 바뀜 (다음에 열 때 최신값 반영) |
| 용도 | 그 시점에 교사가 "확정"한 기록 — 인쇄물(`printReport()`)의 근거 데이터, 감사/이력 추적용 | 지금 이 순간의 실제 상태를 보여주는 대시보드 |
| 어디서 보이는가 | 교사용 `MonthlyReportView`(편집 탭)와 그 인쇄 출력 — **교사 전용** | `MonthlyReportDashboard`("월간 분석" 탭, 교사), `ParentMonthlySummary`(학부모) |

**원칙 (Phase 4 STEP 1부터 적용)**:
1. **같은 화면·같은 대상(특히 학부모)에게 같은 개념의 숫자를 두 세트 보여주지 않는다.** 교사는 "편집 탭"과 "분석 탭"이 서로 다른 탭이라 두 숫자를 동시에 보지 않지만(둘 다 보존, 문제 없음), 학부모 화면은 스크롤 한 화면 안에 둘 다 있었기 때문에 문제였다.
2. **학부모 화면은 Live Analytics만 보여준다.** `report.attendance` 같은 스냅샷 필드는 학부모 화면 렌더링에서 제외한다 — 단, **Firestore에서 그 필드 자체를 지우지는 않는다.** 교사용 편집 화면/인쇄 출력은 계속 그 값을 읽고 쓴다.
3. Live 계산이 불가능(원본 데이터 없음)하면 임의의 값을 만들지 않고 "데이터 부족"이라고 표시한다.
4. 새 지표를 추가할 때마다 "이거 스냅샷으로 이미 존재하는 개념 아닌가?"를 먼저 확인한다 — Source of Truth 표(homeworkService/vocabularyService/examService/readingService/reportService)에 없는 새 숫자를 만들기 전에 먼저 여기부터 확인.

---

## 7. Proposed Architecture

요청서의 6-시스템(Teacher OS / Student OS / Content OS / Exam Studio / Report Center / Business Management) 구조를, **기존 코드를 지우지 않고** 다음처럼 매핑한다.

```
Teacher OS      ← TeacherDash 전체 (이미 존재, mainpage/hwstatus를 "오늘 할 일" 랜딩으로 승격)
Student OS      ← StudentDash + roster 스케줄 필드 + roadmap
Content OS      ← reading-library.html(readingLibrary) + wordtest.html(wordbank)
                  + 신규: grammarQuestions, readingQuestions, originalQuestions
Exam Studio     ← examTests/mockExams/regularExams/examKeyLibrary (기존) + 신규 Builder UI
Report Center   ← monthlyReports/dailyReport 관련 기존 코드 + 신규 자동집계 로직
Business        ← tuitionRecords + RevenueOverviewSection (이미 존재, 화면만 이동)
```

**폴더 구조** — 요청서 §26 원칙(점진적, 새 기능만 새 구조 사용) 그대로 적용:
```
utils/       // 날짜 포맷, 동의어 매칭 등 이미 index.html에 흩어진 순수 함수의 신규 버전만 여기로
services/    // HomeworkService, DailyReportService 등 — Firestore 접근을 래핑, 기존 updateData 위에 얇게
models/      // 신규 컬렉션(dailyReports, grammarQuestions...)의 타입/스키마 정의 (JSDoc, 빌드 없으므로 TS 불가)
components/  // 신규 UI만 (htm 태그드 템플릿 유지)
features/    // Teacher Center 대시보드 등 신규 화면 단위
```
`index.html`은 여전히 빌드 없는 단일 HTML이므로, 위 폴더의 파일들은 **별도 `.js` 파일로 만들고 `<script src="...">`로 로드**하는 형태가 현실적이다(진짜 ES 모듈 import는 `window.__db` 브릿지 패턴과 charset 문제 때문에 전체 전환 없이는 어렵다). 이 부분은 실제 Phase 1 착수 시 더 구체적으로 검증이 필요하다.

**Adapter/Compatibility 원칙**(§25): 신규 서비스 레이어는 기존 배열 필드(`data.homework[]` 등)를 읽고 쓰는 **어댑터**로 시작하고, `students/{id}/homework/{hwId}` 서브컬렉션 같은 정규화된 구조로의 실제 이관은 별도 승인 후 진행한다. 기존 배열과 새 서브컬렉션을 당분간 병행 유지하는 옵션도 열어둔다.

---

## 8. Proposed Data Models

새로 필요한 컬렉션(전부 기존 컬렉션과 별개로 추가, 기존 필드 삭제 없음):

> **Phase 0 당시 스케치와 실제 구현이 달라진 부분 (2026-08-24 정정)**: 아래 `dailyReports/{studentId}_{date}` 스케치는 Phase 0 시점의 초안이었다. 실제로는 별도 컬렉션을 만들지 않고 **기존 `data.dailyReports["YYYY-MM-DD"]` 필드에 구조화된 필드를 추가하는 방식**(Phase 3)으로 구현됐다 — §2.7 참고. `grammar.topic/comprehension/weakPoint`처럼 이 스케치에만 있고 실제로 구현 안 된 세부 필드도 있다(실제로는 `lessonContent.grammar`가 자유 텍스트 한 칸). 이 섹션은 앞으로도 실제 구현 후 사실과 다르면 그때그때 정정한다.

```js
// grammarQuestions/{id}
{ id, grade, schoolLevel, curriculum, mainCategory, subCategory, questionType, difficulty,
  question, choices, answer, explanation, distractorAnalysis, source, tags,
  status, createdAt, updatedAt, usageCount, correctRate }

// readingPassages/{id}  +  readingQuestions/{id}
// (요청서 §14 스키마 그대로 — readingLibrary와는 별개 컬렉션. readingLibrary는 "읽기용 콘텐츠",
//  readingQuestions는 "출제용 문제은행"으로 성격이 다르므로 통합하지 않는다.)

// originalQuestions/{id}  — "Sarah's Original"
{ ...grammarQuestions 또는 readingQuestions와 동일 필드 + status: AI_DRAFT|AI_CHECKED|TEACHER_REVIEW|REVISION|APPROVED|PUBLISHED|ARCHIVED }
```

**Homework Service 확장 경로**(요청서 §5): 지금 당장 `students/{id}/homework/{hwId}` 서브컬렉션으로 옮기지 않는다. 대신 `HomeworkService`(신규 `services/homeworkService.js`)가 기존 `data.homework[]` 배열을 읽고 쓰는 어댑터로 시작하고, 서브컬렉션 이관은 실제 필요(예: 숙제 개수가 1MB 캡에 영향 줄 만큼 늘어남)가 확인된 뒤 별도 승인 하에 진행한다.

## 8.1 Reading Activity Schema (Phase 4 제안, 2026-08-24)

착수 전 실제 `reading-library.html`을 다시 읽어 확인한 사실:
- **오늘 시점 "읽음/완료" 개념이 전혀 없다.** 스토리를 여는 것(`view.screen = "reader"`)은 순수 클라이언트 상태 전환이고 Firestore에 아무것도 안 남는다. 실제 저장되는 유일한 학생 활동 신호는 (a) 본문 단어 클릭 → `readingVocab/<studentId>.words[]`, (b) 다 읽은 뒤 "독서 기록" 제출 → `readingJournal/<studentId>.entries[]` 둘뿐이다.
- **Reading Time/Quiz 기능이 전혀 없다.** 세션 시간 측정 코드도, 퀴즈 채점 코드도 없다.
- 스토리(`readingLibrary/<id>`) 스키마: `{title, level(1-10), category, genre, source, sourceUrl, license, text, vocabulary[], journalLevel, createdAt}`.
- `reading-library.html`은 이미 자체적으로 `sarahsEnglishMeta/main`을 읽어 로스터 드롭다운을 쓰고 있다(`va-student`/`ja-student` 셀렉트, `:830`) — 새 교사용 Reading Dashboard도 index.html이 아니라 이 파일 안(`#admin` 뷰의 4번째 `<details>` 패널)에 같은 방식으로 넣는 게 기존 구조와 가장 자연스럽게 맞는다.

**설계 원칙(§17 "복제 저장 금지"를 그대로 따름)**: activity 레코드에는 **다른 소스에서 다시 구할 수 없는 사실만** 저장한다. `storyTitle`/`level`은 `storyId`로 `readingLibrary`를 조인해서 구하고, "새 단어 수"는 `readingVocab.words[]`를 `source`(스토리 제목)로 필터링해 매번 계산한다 — activity 문서 자체에 중복 저장하지 않는다.

```js
// readingActivity/<studentId>  — readingVocab/readingJournal과 동일한 패턴(학생당 문서 1개, 배열)
{
  activities: [
    {
      id,
      storyId,                 // readingLibrary 문서 id — title/level/genre는 여기서 조인
      status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED",
      // ASSIGNED는 스키마에 문자열로만 예약 — 교사가 특정 학생에게 특정 스토리를 "배정"하는 기능
      // 자체가 현재 없어서(학생은 레벨별로 자유 열람) 이번 Phase에서 구현하지 않는다.
      startedAt,                // 처음 열었을 때 1회만 기록, 재방문해도 안 바뀜
      completedAt,              // 학생이 명시적으로 "다 읽었어요" 눌렀을 때만 기록 — 그냥 열람만으론 안 채워짐
      readingTimeSec,           // 탭 visibility 기준 best-effort 누적치, §6 참고 — 정밀 측정 시스템 아님
      quizScore, quizTotal,     // 예약 필드 — 현재 Reading Library에 퀴즈 기능이 없어 항상 null, UI도 없음.
                                 // 향후 퀴즈 기능이 생기면 이 필드만 채우면 되게 미리 자리만 잡아둠.
    },
  ],
}
```

**status 전이 규칙**: 문서가 아예 없으면 NOT_STARTED(저장 안 함, 상태 없음 = NOT_STARTED로 간주). 처음 열면 IN_PROGRESS+startedAt 기록. "다 읽었어요" 버튼을 눌러야만 COMPLETED+completedAt 기록 — 열람만으로는 자동 완료 처리하지 않는다(요청서 §5 원칙 그대로).

**Reading Time 측정 방식**(요청서 §6): start/pause/resume/complete 구조를 `document.visibilitychange` + 리더 화면 진입/이탈 이벤트로 best-effort 구현한다. 브라우저를 강제 종료하는 경우까지 완벽히 잡으려 하지 않는다(요청서 §6에 명시된 그대로) — `beforeunload`/`pagehide`에서 한 번 더 저장을 시도하지만 실패해도 앱을 막지 않는다.

---

## 9. Migration Strategy

```
Existing Data (배열 필드, 기존 컬렉션)
        ↓
Adapter / Compatibility Layer   ← 신규 services/*.js, 기존 스키마 그대로 읽고 씀
        ↓
New Service Layer               ← DailyReportService, GrammarBankService 등
        ↓
New UI                          ← Teacher Center, Exam Studio 등 신규 화면
```

원칙:
- 기존 필드/컬렉션을 삭제하거나 구조를 바꾸는 마이그레이션은 하지 않는다. 새 컬렉션을 추가하고, 기존 데이터에서 자동 집계/조인하는 방향으로만 간다.
- `StorageCleanupPanel`류의 백업/내보내기 기능이 아직 없다 — Migration 전에 요청서 §25가 요구하는 대로 백업/export 기능을 먼저 만들어야 한다(현재 repo에 JSON export 비슷한 게 `wordtest.html`에만 있음, 학생 데이터 전체 export는 없음). **Phase 1에서 이 export 기능부터 만드는 것을 제안.**
- 각 Phase 종료 시 요청서 §30의 체크리스트(로그인, 학생 목록, 숙제, 단어시험, 모의고사, 정답표, Reading Library, Daily/Monthly Report, Roadmap, Schedule, Revenue 등)로 회귀 테스트.

---

## 10. Implementation Roadmap

요청서 §29의 Phase 0~11을 그대로 채택하되, 이번 분석에서 드러난 사실을 반영해 각 Phase의 실제 시작점을 명시한다.

| Phase | 내용 | 이번 분석에서 확인된 실제 시작점 |
|---|---|---|
| 0 | 현재 코드 분석 + Architecture Report | **완료** |
| 1 | Service/Data Model/Compatibility Layer | **완료** — 백업/export(`services/backupService.js`) + `services/` 파일들 + `HomeworkService` 어댑터. (Phase 1 당시 8개로 기록됐으나 실제 파일 수는 그 시점에도 10개였다 — `aiService.js`/`revenueService.js` 누락. Phase 5에서 `questionBankService.js` 추가로 현재 11개) |
| 2 | Teacher Center + Homework | **완료** — 신규 "Teacher Center" 섹션(오늘 확인할 숙제 보드, 필터/검색/확인 처리) + 기존 `TeacherOverview`/`HomeworkStatusOverview`는 그대로 보존 |
| 3 | Daily Report + Monthly Report | **완료** — `DailyReportGenerator`에 구조화된 "오늘 학습 기록" 카드(Homework/Vocab/Exam/Reading 자동연결, 평가, status) 추가(기존 메시지 초안 카드 보존) + `ReportsSection`에 "월간 분석" 탭(`MonthlyReportDashboard`) 신설 + Parent 화면에 자동집계 요약 노출. §2.7 참고 |
| 4 | Reading Log + Reading Analytics | **완료** — 신규 `readingActivity` 컬렉션(§8.1)으로 실제 읽기 상태/시간 추적 추가, `reading-library.html`에 Teacher Reading Dashboard 신설, Daily/Monthly/Parent Report에 연결 |
| 5 | Grammar Question Bank | **완료** — Question Bank Core(`services/questionBankService.js`) + `grammarQuestions` 컬렉션 + Teacher UI(`QuestionBankSection`). §11 참고 |
| 6 | Reading Passage/Question Bank | **완료** — Question Bank Core 확장(§12.9) + `readingPassages`/`readingQuestions` 컬렉션 + Teacher UI(`ReadingQuestionBankView`). §12 참고. `readingLibrary`와는 완전히 별개(§12.1) |
| 7 | ~~Sarah's Original + 품질관리~~ → **Exam Builder로 대체 진행됨(완료)** | 사용자가 실제 세션에서 "PHASE 7"을 Sarah's Original이 아니라 Exam Builder로 지정해 진행했다(§13). `examPapers` 컬렉션 + Question Bank Core 최소 확장(`incrementUsageCount`, §13.9) + Teacher UI(`ExamBuilderView`). Grammar/Reading 두 은행에서 문제를 조합해 시험지를 만드는 기능 — `examTests`/`mockExams`/`examKeyLibrary`는 손대지 않음(§13.1). **Sarah's Original + 품질관리는 아직 미착수 상태로 남아있다** — 번호가 비게 됐으니 향후 별도 Phase로 다시 배정 필요(§10-정정 참고) |
| 8 | Exam Studio | 원래 계획: `examTests`/`mockExams`/`examKeyLibrary`/`ExamKeyLibrarySection`(AI vision 파싱 이미 구현) 재배치 위주. **Phase 7에서 먼저 만들어진 Exam Builder(`examPapers`)가 사실상 이 Phase의 핵심 산출물을 상당 부분 선점했다** — 남은 범위는 기존 `examTests`/`mockExams`/`examKeyLibrary`를 Exam Builder와 어떻게 연결할지(또는 그대로 병존시킬지) 결정하는 것으로 좁혀졌다. 착수 전 사용자와 범위 재확인 필요 |
| 9 | Vocabulary/Mock Exam 통합 | 이미 대부분 구현됨 — Daily/Monthly Report 자동조인에 연결하는 게 남은 일 |
| 10 | 학생 약점 분석 | 신규 — `regularExams`/`vocabResults`/`examResults`를 소스로 사용. Exam Builder의 `examPapers`가 향후 `examAttempts`(§13.9, 미구현)로 연결되면 이 Phase의 소스가 하나 더 늘어난다 |
| 11 | Business/Revenue UI 재구조화 | `RevenueOverviewSection`(`:2710`)/`tuitionRecords` 이미 존재 — 신규 네비게이션 구조로 이동 + UI 고급화 위주 |

**§10-정정 (2026-08-24, Exam Builder 완료 시점)**: 이 표의 Phase 번호는 요청서 §29 원안 그대로였으나, 실제 세션은 "PHASE 5/6/7"이라는 사용자 지시 라벨을 그대로 따라갔고 그 내용이 원안과 어긋난 지점(Phase 7)이 생겼다. **번호 자체보다 "무엇이 완료됐고 무엇이 남았는가"가 진짜 소스**다 — 완료: 0~6, 7(Exam Builder로 대체). 미착수: Sarah's Original + 품질관리(원래 7번 내용), Exam Studio(8, 축소된 범위), 9, 10, 11. 다음 Phase에 어떤 번호를 붙일지, Sarah's Original을 언제 다시 스케줄에 넣을지는 사용자가 다음 지시에서 정한다 — 이 문서가 임의로 번호를 재배정하지 않는다.

**다음 단계**: 사용자 승인 후 Phase 1(백업/export 기능 + Service layer 뼈대)부터 착수. 대규모 migration이나 기존 기능 삭제는 하지 않음.

---

## 11. Question Bank (Phase 5, 2026-08-24)

> 이 절은 **실제 구현된 코드를 읽고 작성**했다(`services/questionBankService.js`, `index.html`의 `QuestionBankSection` 외 4개 컴포넌트). Phase 5 스펙 초안과 다르게 구현된 부분은 아래 §11.10에 따로 정리했다 — 스펙이 아니라 코드가 기준이다.

### 11.1 Question Bank Core architecture

Phase 5의 목적은 "문법 문제 저장 화면" 하나가 아니라, 앞으로 만들 **모든 문제은행이 공유할 코어**를 먼저 세우는 것이었다. 그래서 `services/questionBankService.js`는 두 층으로 나뉜다.

```
① Core (collectionName을 인자로 받는 범용 함수)
   listQuestions(collectionName)
   createQuestion(collectionName, input)
   updateQuestion(collectionName, existingDoc, patch)   ← copy-on-write versioning 포함
   setStatus(collectionName, doc, nextStatus, reviewPatch)
   canHardDelete(doc) / hardDeleteQuestion(collectionName, doc)
   queryQuestions(list, filters)
   pickQuestionsForExam(list, filters, count)
   canTransition(from, to) / computeFingerprint(text) / findDuplicates(list, text, excludeId)

② Grammar 전용 바인딩 (이번 Phase에서 UI에 연결된 유일한 부분)
   GRAMMAR_COLLECTION = "grammarQuestions"
   listGrammarQuestions() / createGrammarQuestion() / updateGrammarQuestion()
   setGrammarQuestionStatus() / hardDeleteGrammarQuestion()
```

향후 `readingQuestions` / `mockExamQuestionBank` / `originalQuestions`는 ①을 그대로 재사용하고 ②와 같은 얇은 바인딩만 추가한다 — CRUD·버저닝·상태전이·중복탐지·쿼리를 은행마다 다시 구현하지 않는다.

**Firestore 접근은 전부 `services/firebaseClient.js`를 경유한다.** Phase 5에서 그 파일에 범용 쓰기 프리미티브 3개(`addDocTo`/`setDocAt`/`deleteDocAt`)를 추가했다 — Question Bank가 "자기 컬렉션을 소유하는" 첫 서비스라서 필요했고, collectionName을 인자로 받게 만들어 이후 컬렉션도 재사용 가능하게 했다. UI 컴포넌트가 `window.__*`를 직접 호출하는 기존 안티패턴(§1.3(b), 컬렉션의 1/3)을 이번엔 답습하지 않았다.

**AI API를 호출하지 않는다.** `questionBankService.js` 전체에 AI 호출이 0건이며(파일 내 `fetch` 문자열은 주석 1곳뿐), 조회·검색·필터·통계·저장 전부 Firestore + JS 계산이다. AI 문제 생성은 향후 별도 `services/questionGenerationService.js`로만 분리한다 — CLAUDE.md "API cost policy" 참고.

### 11.2 Question schema (`grammarQuestions/{autoId}`)

```js
{
  // 분류
  grade,            // "중1"|"중2"|"중3"|"고1"|"고2"|"고3"
  difficulty,       // "BASIC"|"INTERMEDIATE"|"ADVANCED"|"KILLER"
  mainCategory,     // GRAMMAR_TAXONOMY[].key   (대주제, 예: "tense")
  subCategory,      // GRAMMAR_TAXONOMY[].subCategories[].key (세부문법, 예: "presentPerfect")
  questionType,     // QUESTION_TYPES[].key     (문제유형, 예: "grammarCorrect")

  // 문제 본체
  questionText,
  choices: [],                    // 객관식일 때만 non-empty
  answerFormat,                   // "mc" | "subjective" — choices.length로 자동 결정, 수기 입력 아님
  answer,                         // mc면 number(보기 index), subjective면 string
  explanation,
  wrongChoiceExplanations: [],    // 보기별 오답 해설(선택), choices와 같은 index

  // 메타
  tags: [],                       // 자유 태그, 검색/필터/향후 시험지 자동생성에 사용
  source: { type, note },         // type ∈ SOURCE_TYPES, note는 자유 텍스트
  status,                         // §11.5
  review: {...},                  // §11.6
  fingerprint,                    // §11.7
  usageCount,                     // 실제 시험 출제 횟수. 0이 아니면 수정 시 fork (§11.8)
  version,                        // 1부터
  supersedesId,                   // 이 문서가 대체한 이전 버전 id (fork로 생성된 경우)
  replacedBy,                     // 이 문서를 대체한 새 버전 id (fork 당한 경우)
  createdAt, updatedAt, createdBy, // createdBy는 현재 항상 "teacher" (인증 없음, §1.3)
}
```

`answerFormat`을 별도 필드로 두고 `choices.length`에서 파생시킨 이유: 교사가 문제유형을 "빈칸"으로 고르고도 객관식 보기를 입력하는 경우가 자연스럽게 발생하기 때문. **문제유형(교육적 분류)과 채점방식(기술적 형식)을 분리**해야 "현재완료 + 빈칸 + 객관식"과 "현재완료 + 빈칸 + 서술형"이 둘 다 표현된다.

### 11.3 Firestore collection 구조

| | |
|---|---|
| 컬렉션 | `grammarQuestions` (신규, 12번째 컬렉션) |
| 문서 단위 | 문제 1개 = 문서 1개 (`addDoc` 자동 id) |
| 기존 컬렉션과의 관계 | **완전 분리.** 기존 `examTests`/`mockExams`/`regularExams`/`sarahsEnglishStudents` 어느 것도 읽거나 쓰지 않는다 |
| 왜 학생 문서에 안 넣나 | 문제은행은 학생별 데이터가 아니고, 문항이 늘면 1MB 캡(§2.2)에 직접 부딪힌다 |
| 백업 | `services/backupService.js`가 `grammarQuestions` 전체를 export에 포함(version "1.1"). 향후 은행 추가 시 여기도 같이 추가할 것 |

### 11.4 Taxonomy — 22개 대주제 + 세부 문법

사용자가 제시한 22개 대주제 골격을 유지하되(중고등 문법 커리큘럼·수능 어법 기출의 관습적 분류와 실제로 일치), 각 대주제 아래 **세부 문법(subCategory) 층을 새로 붙였다** — 스펙 §2가 요구한 "대주제 → 세부 문법 → 문제 유형" 다단 저장을 만족시키기 위함.

| # | 대주제 (key) | 세부 문법 |
|---|---|---|
| 1 | 문장의 기본 구조 `sentenceStructure` | 문형(SV~SVOC) / 어순 / 문장의 종류 |
| 2 | 품사 `partsOfSpeech` | 명사·대명사 / 형용사·부사 / 전치사 / 관사 |
| 3 | 문장 성분 `sentenceElements` | 주어·동사 / 목적어·보어 / 수식어 위치 |
| 4 | 시제 `tense` | 현재·과거 / 현재완료 / 과거완료 / 진행형 / 시제 일치 |
| 5 | 조동사 `modal` | 기본 조동사 / 조동사+have p.p. / 관용표현 |
| 6 | 수동태 `passive` | 기본 / 4·5형식 / by 이외 전치사 / 진행·완료 수동태 |
| 7 | 부정사 `infinitive` | 명사·형용사·부사적 용법 / 원형부정사 / 의미상 주어 |
| 8 | 동명사 `gerund` | 동명사 vs to부정사 / 관용표현 |
| 9 | 분사 `participle` | 현재분사·과거분사 / 분사구문 / 감정 분사 |
| 10 | 관계사 `relative` | 관계대명사 / 관계부사 / 계속적 용법 / 복합관계사 |
| 11 | 접속사 `conjunction` | 등위 / 종속 / 상관 |
| 12 | 명사절 `nounClause` | that절 / whether·if절 / 의문사절 |
| 13 | 부사절 `adverbClause` | 시간·이유 / 조건·양보 / 목적·결과 |
| 14 | 조건문 `conditional` | 직설법 조건문 / unless 등 |
| 15 | 가정법 `subjunctive` | 과거 / 과거완료 / 혼합 / I wish·as if |
| 16 | 비교 `comparison` | 원급·비교급 / 최상급 / 관용표현 |
| 17 | 일치 `agreement` | 수 일치 / 시제 일치 |
| 18 | 도치 `inversion` | 부정어 / so·neither / 장소부사구 |
| 19 | 강조 `emphasis` | it~that 강조구문 / do 강조 |
| 20 | 병렬 `parallelism` | 등위접속사 / 상관접속사 |
| 21 | 준동사 종합 `verbals` | 부정사·동명사·분사 통합 오류 (수능 어법 대표 유형) |
| 22 | 기타 `etc` | 생략 / 무생물 주어 / 삽입·동격 |

22번 "기타"는 의도적 overflow 버킷이며 **UI에서 기본 선택되지 않는다**(기본값은 1번). 커리큘럼은 JS 하드코딩이고 데이터 기반이 아니다 — `reading-library.html`의 `LEVELS`와 같은 트레이드오프(§2.6).

### 11.5 문제 유형 (questionType) + 출처 (source.type) + 상태 (status)

**문제 유형 11종** — 문법 주제와 완전히 별개 축으로 저장한다(스펙 §3: "현재완료 + 어법상 옳은 것" ≠ "현재완료 + 빈칸"):
`빈칸` `어법상 옳은 것` `어법상 틀린 것` `밑줄 오류` `문장 완성` `올바른 문장 선택` `문장 배열` `영작` `변형` `서술형` `객관식`

**출처 5종**: `ORIGINAL`(자체 제작) `TEXTBOOK_VARIATION`(교재 변형) `TEACHER_CREATED`(교사 출제, 기본값) `AI_GENERATED`(AI 생성) `PAST_EXAM_REFERENCE`(기출 유형 참고).
`PAST_EXAM_REFERENCE`는 **기출 원문을 복제하는 기능이 아니다** — "기출 유형을 참고해 자체 제작한 문제"와 순수 창작을 구분하기 위한 라벨일 뿐이다.

**status pipeline (6단계)**:
```
DRAFT → AI_REVIEW → TEACHER_REVIEW → APPROVED → PUBLISHED
  ↑                                                  │
  └──────────── (복원) ──── ARCHIVED ←────────────────┘
```
`canTransition(from, to)` 규칙 (실제 코드):
- **PUBLISHED 진입 조건: `from === "APPROVED"`인 경우에만 허용.** 다른 어떤 상태에서도 PUBLISHED로 갈 수 없다 — 스펙 §5/§19의 "AI가 자동으로 APPROVED 처리하면 안 된다, 최종 승인자는 교사다"를 코드로 강제한 지점.
- 그 외에는 pipeline 상에서 **한 칸 앞/한 칸 뒤로만** 이동 가능(뒤로 = 검토 반려).
- ARCHIVED로는 (ARCHIVED가 아닌) 어느 상태에서든 갈 수 있다.
- **ARCHIVED에서 나오는 경로는 `DRAFT` 하나뿐이다.** 보관된 문제를 곧장 PUBLISHED로 되살릴 수 없다.
- `setStatus`는 사람이 UI 버튼을 눌러야만 호출된다. 자동 승격 코드 경로는 존재하지 않는다.

### 11.6 문제 검수 (review)

```js
review: {
  grammarChecked, answerVerified, explanationVerified,   // 각각 true | false | null(미확인)
  difficultyAppropriate, distractorQuality,
  naeshinFit, suneungFit, duplicateChecked,
  reviewNote, reviewedBy, reviewedAt,
}
```
UI는 8개 항목을 3-state 토글 버튼(미확인 → ✅ → ❌ → 미확인)으로 노출한다. 스펙 §19의 8가지 품질 기준(문법적 정확성/정답 명확성/오답 타당성/난이도/학생수준 적합성/실제시험 적합성/변별력/해설의 교육적 가치)은 이 8필드에 대응하되, 완전히 1:1은 아니다 — 현재 스키마는 "체크 가능한 것"에 맞춰져 있고 변별력 같은 통계 기반 지표는 실제 응시 데이터가 쌓여야 계산 가능하므로 §11.9로 미뤘다.

**`review` 수정은 content 변경이 아니므로 fork하지 않는다** — 이미 출제된 문제를 검수해도 새 버전이 생기지 않고 제자리 수정된다(실제 브라우저에서 검증함).

### 11.7 Fingerprint duplicate detection

```js
normalizeForFingerprint(text)  // 소문자화 → 구두점 제거 → 공백 정규화 → trim
computeFingerprint(text)       // `${정규화길이}:${31진 해시}`
findDuplicates(list, text, excludeId)  // 같은 fingerprint를 가진 다른 문서들
```
- 잡아내는 것: 복붙 재등록, 대소문자/공백/구두점만 다른 재입력.
- **잡아내지 못하는 것: 의미는 같지만 문장이 다른 문제.** AI 유사도 판정은 이번 Phase 범위 밖이며(스펙 §14), AI 비용 정책상으로도 조회 경로에서 AI를 부를 수 없다.
- **동작: 경고만 하고 저장을 막지 않는다.** 기존 문제와 자동 연결도 하지 않는다. 폼에 "⚠ 문구가 매우 비슷한 문제가 이미 N건 있어요 (중복일 수 있어요, 저장은 막지 않아요)"를 띄우고 판단은 교사에게 맡긴다.

### 11.8 Versioning — copy-on-write + 삭제 정책

**핵심 요구: 이미 시험에 출제된 문제를 나중에 수정해도 과거 시험 결과의 의미가 바뀌면 안 된다.**

`CONTENT_FIELDS = [grade, difficulty, mainCategory, subCategory, questionType, questionText, choices, answer]`

`updateQuestion(collection, doc, patch)` 분기:
- `usageCount === 0` **또는** patch가 CONTENT_FIELDS를 건드리지 않음 → **제자리 수정**(merge). 버전 유지.
- `usageCount > 0` **그리고** content 변경 → **fork**:
  - 새 문서 생성: `version+1`, `supersedesId = 기존id`, `status = DRAFT`(수정됐으니 검수 재시작), `review` 초기화, `usageCount = 0`, fingerprint 재계산
  - 기존 문서: `status = ARCHIVED`, `replacedBy = 새id`로 표시만 하고 **내용/정답/usageCount는 절대 건드리지 않는다**
  - 과거 시험 결과는 기존 id를 참조하므로 그대로 유효

**삭제 정책** (`canHardDelete`):

| 대상 | 처리 |
|---|---|
| DRAFT + `usageCount === 0` | 완전 삭제 가능 |
| REVIEW / APPROVED / PUBLISHED | 삭제 불가 → ARCHIVED 처리 |
| `usageCount > 0` (출제 이력 있음) | **원본 삭제·수정 절대 불가** → ARCHIVED 또는 새 VERSION |

`hardDeleteQuestion`은 조건 미달 시 예외를 던지고, UI는 "완전히 삭제" 링크 자체를 `canHardDelete(doc)`일 때만 렌더한다(가드 2중).

### 11.9 향후 연결 구조

**Exam Builder (Phase 8)** — 이번 Phase는 완전한 Builder를 만들지 않되, Builder가 그대로 쓸 쿼리를 먼저 만들었다:
```js
pickQuestionsForExam(list, { grade:"중3", mainCategory:"tense", questionType:"grammarCorrect", difficulty:"INTERMEDIATE" }, 10)
// status: ["PUBLISHED"]가 기본 강제 — 미검수 DRAFT가 시험에 섞이는 사고를 구조적으로 차단
```
`QuestionBankExamBuilderPreview` 컴포넌트가 이 쿼리를 UI로 노출해 실제 동작을 검증할 수 있게 해뒀다. Builder는 여기에 "선택 → 시험지 생성 → `usageCount` 증가" 단계만 얹으면 된다.

**Student Weakness Analytics (Phase 10)** — 문제가 시험에 쓰이면 응시 결과에 **questionId를 안정적으로 저장**해야 아래 조인이 성립한다:
```
student → exam → questionId → answer(정/오)
                     ↓ (grammarQuestions 조인)
              mainCategory / subCategory / questionType / difficulty
                     ↓ (집계)
        "시제 82% · 관계사 61% · 분사 54% · 가정법 91%"
```
versioning이 이 구조의 전제다: 문제를 수정해도 과거 응시가 참조하는 id의 내용이 불변이어야 통계가 사후에 왜곡되지 않는다. `mainCategory`/`subCategory`/`questionType`을 문제 문서에 정규화해 저장한 것도 이 집계를 위해서다(응시 결과에 분류를 복제 저장하지 않고 조인한다 — §8.1의 "복제 저장 금지" 원칙과 동일).

**기존 시험 시스템과의 관계**: 기존 `examTests`/`mockExams`/`regularExams`/단어시험은 **이번 Phase에서 한 줄도 수정하지 않았다.** Question Bank는 완전히 독립적으로 동작하며, 연결은 향후 Exam Builder가 adapter로 수행한다.

### 11.10 스펙 초안과 실제 구현이 달라진 부분

| 스펙 초안 | 실제 구현 | 이유 |
|---|---|---|
| `subject` 필드 | 넣지 않음 | `grammarQuestions` 컬렉션 자체가 과목을 규정한다. `regularExams.subject`가 자유 텍스트라 신뢰할 수 없었던 전례(handoff Traps)도 감안 |
| `questionType`으로 채점 방식 결정 | `answerFormat`을 `choices.length`에서 파생 | 교사가 "빈칸"+객관식 보기를 입력하는 조합이 자연스럽게 발생 |
| status에 `REVISION` | 넣지 않음 | "한 칸 뒤로" 전이가 반려를 표현하므로 별도 상태 불필요 |
| §8의 `curriculum`/`schoolLevel`/`distractorAnalysis`/`correctRate` | 넣지 않음 | `grade`로 충분(schoolLevel 파생 가능), `wrongChoiceExplanations`가 distractorAnalysis 역할, `correctRate`는 응시 데이터가 없어 항상 null이 될 필드 — Phase 10에서 실제 데이터가 생길 때 추가 |

---

## 12. Reading Question Bank (Phase 6, 2026-08-24)

> **STEP 1 설계 문서.** 코드 구현 전에 작성했고, 구현 중 실제와 달라진 부분은 §12.11에 정정 기록한다(문서가 아니라 코드가 기준).
>
> **AI API 호출: 0건.** 지문/문제 등록·검색·필터·편집·분류·선택·Preview·통계 전부 Firestore + JS 계산이다. AI 생성 버튼도 만들지 않는다(CLAUDE.md "API cost policy").

### 12.1 기존 Reading 컬렉션과의 관계 — 절대 혼동 금지

| | 목적 | 사용자 | 컬렉션 | 소유 파일 |
|---|---|---|---|---|
| **기존** Reading Library | 학생이 **읽는** 자료실 | 학생 | `readingLibrary` / `readingActivity` / `readingJournal` / `readingVocab` | `reading-library.html` |
| **신규** Reading Question Bank | 교사가 **출제하는** 시험 문제은행 | 교사 | `readingPassages` / `readingQuestions` | `index.html` (`QuestionBankSection`) |

**데이터를 서로 복제하지 않는다.** 같은 영어 지문이 양쪽에 있을 수 있지만 이번 Phase에서 강제 통합하지 않는다 — 목적·수명주기·상태머신이 전부 다르다(읽기 자료는 status가 없고, 문제은행은 DRAFT→PUBLISHED 검수 파이프라인을 갖는다). 향후 "이 읽기자료로 문제 만들기" 연결이 필요해지면 `readingPassages.sourceLibraryId` 같은 **참조 필드 한 개**로 잇는다(TODO, 이번 Phase 미구현).

### 12.2 Passage / Question 분리 — 이번 Phase의 핵심 구조

문법은 문제 1개가 독립적이지만, 독해는 **지문 1개 : 문제 N개**다.

```
readingPassages/P001  ("The future of ...")
   ├── readingQuestions/Q001  passageId=P001  주제
   ├── readingQuestions/Q002  passageId=P001  빈칸
   ├── readingQuestions/Q003  passageId=P001  내용 일치
   ├── readingQuestions/Q004  passageId=P001  글의 순서
   └── readingQuestions/Q005  passageId=P001  어휘
```

**왜 서브컬렉션(`readingPassages/{id}/questions/{id}`)이 아니라 최상위 2개 컬렉션인가:**
1. Exam Builder는 "고1 + MOCK_EXAM + 빈칸 + Advanced 3문제"처럼 **지문을 가로질러** 문제를 뽑아야 한다. 서브컬렉션이면 `collectionGroup` 쿼리가 필요한데, 이 repo는 Firestore 인덱스 설정을 관리하지 않는다(§1.3 — `firebase.json`에 firestore 키 없음, 규칙도 Console 관리).
2. 이 repo의 모든 콘텐츠 컬렉션(`readingLibrary`/`materialsLibrary`/`passageArchive`/`grammarQuestions`)이 이미 **플랫 최상위 + 클라이언트 필터** 패턴이다. 한 컬렉션만 다른 접근 패턴을 쓰면 일관성이 깨진다.
3. 지문 없이 존재하는 문제(향후 독립 어휘문항 등)를 나중에 허용하기 쉽다.

**지문을 지문 문서에 문제 배열로 넣지 않는 이유**: 지문 본문 자체가 길고(수능 지문 ~150 words, 장문 ~350 words), 문제 5~10개를 배열로 안으면 1MB 캡(§2.2)과 별개로 "문제 1개 수정 = 지문 문서 전체 재작성"이 되어 버저닝이 지문 단위로 오염된다.

### 12.3 Firestore collections

| 컬렉션 | 문서 단위 | 비고 |
|---|---|---|
| `readingPassages` | 지문 1개 = 문서 1개 | 13번째 컬렉션 |
| `readingQuestions` | 문제 1개 = 문서 1개, `passageId`로 지문 참조 | 14번째 컬렉션 |

둘 다 `services/backupService.js` export에 추가한다(version "1.2").

### 12.4 Passage schema — `readingPassages/{autoId}`

```js
{
  title,
  passageText,
  grade,              // "중1".."고3" (Phase 5 GRADES 재사용)
  difficulty,         // BASIC | INTERMEDIATE | ADVANCED | KILLER (Phase 5 재사용)
  passageType,        // PASSAGE_TYPES — 논설문/설명문/서사/도표/교과서 본문 등 (§12.6)
  examType,           // READING_EXAM_TYPES — 중등내신/고등내신/모의고사/수능형/자체제작/연습 (§12.6)
  topic,              // 자유 텍스트 주제 (예: "기후변화와 도시계획")
  keywords: [],       // 핵심어
  wordCount,          // passageText에서 자동 계산 (수기 입력 아님)
  estimatedReadingTime, // wordCount 기반 자동 계산(분). 학년별 WPM 상수 사용, AI 아님
  source: { type, note },   // Phase 5 SOURCE_TYPES 재사용
  tags: [],
  status,             // Phase 5 STATUS_FLOW 그대로 재사용 (§12.8)
  review: {...},      // Reading 전용 10항목 (§12.9)
  fingerprint,        // passageText 정규화 해시
  usageCount, version, supersedesId, replacedBy,
  createdAt, updatedAt, createdBy,
}
```

`wordCount`/`estimatedReadingTime`은 **파생 필드**다. 저장 시점에 `passageText`에서 계산하며 교사가 입력하지 않는다 — Phase 5에서 `answerFormat`을 `choices.length`에서 파생시킨 것과 같은 원칙(수기 입력한 메타데이터는 본문과 어긋난다).

### 12.5 Question schema — `readingQuestions/{autoId}`

Phase 5 Question schema를 기반으로 하되 독해 전용 필드를 더한다.

```js
{
  passageId,          // ★ readingPassages 문서 id — 이 값이 Reading Bank의 핵심 연결고리
  grade, difficulty,  // 보통 지문에서 상속되지만 문항별 override 가능
  questionType,       // READING_QUESTION_TYPES (§12.7) — 32종
  examType,           // ★ 문제 유형과 분리된 별도 축 (§12.7)
  questionText, choices, answerFormat, answer,
  explanation,        // = spec의 answerExplanation (Phase 5 필드명 유지)
  wrongChoiceExplanations: [],
  targetSkill,        // ★ MAIN_IDEA | DETAIL_RETRIEVAL | INFERENCE | VOCABULARY_IN_CONTEXT | LOGIC | STRUCTURE
  evidenceLocation,   // ★ 지문에서 정답 근거 위치 (자유 텍스트, 예: "3rd paragraph, 2nd sentence")
  source, tags, status, review, fingerprint,
  usageCount, version, supersedesId, replacedBy,
  createdAt, updatedAt, createdBy,
}
```

`targetSkill`/`evidenceLocation`은 **스키마에 자리를 잡되 이번 UI에서 필수 입력이 아니다**(선택 입력). 향후 §12.10 취약점 분석의 집계 축이 된다.

**스펙의 `skill`과 `targetSkill` 두 목록은 하나로 합쳤다** — 각각 `[MAIN_IDEA, DETAIL, INFERENCE, VOCABULARY, LOGIC, STRUCTURE]`와 `[MAIN_IDEA, DETAIL_RETRIEVAL, INFERENCE, VOCABULARY_IN_CONTEXT, PARAGRAPH_STRUCTURE]`로 사실상 같은 개념의 다른 명명이라, 필드 2개를 두면 어느 쪽에 넣을지 모호해지고 집계가 갈라진다. `targetSkill` 하나에 6값으로 통일한다.

### 12.6 Passage 분류 — 지문 유형 / 시험 목적

**`READING_EXAM_TYPES` (시험·사용 목적, 6종)** — 확장 가능 구조. 향후 `INTERNATIONAL_SCHOOL`/`TOEFL`/`TEPS` 등을 이 배열에 추가하기만 하면 UI·필터·쿼리가 자동으로 따라온다.

| key | 라벨 |
|---|---|
| `MIDDLE_SCHOOL_INTERNAL` | 중학교 내신 |
| `HIGH_SCHOOL_INTERNAL` | 고등학교 내신 |
| `MOCK_EXAM` | 모의고사 |
| `CSAT_STYLE` | 수능형 |
| `TEACHER_CREATED` | 자체 제작 |
| `PRACTICE` | 연습용 |

**`PASSAGE_TYPES` (지문 유형, 11종)**: 논설문 / 설명문 / 서사문 / 묘사문 / 편지·이메일 / 대화문 / 광고·안내문 / 도표·그래프 / 문학 / 교과서 본문 / 기사

### 12.7 독해 문제 유형 taxonomy (32종) — 문제 유형과 시험 목적의 분리

**핵심 원칙: `questionType`(무엇을 묻는가)과 `examType`(어느 시험용인가)은 완전히 독립된 두 축이다.** 강제 매핑하지 않는다 — 아래 group은 "주로 쓰이는 곳" 힌트일 뿐, 교사가 자유롭게 조합할 수 있다.

```
빈칸 + MOCK_EXAM                    ← 수능형 빈칸추론
빈칸 + HIGH_SCHOOL_INTERNAL         ← 고등 내신 변형 빈칸
본문 빈칸 + MIDDLE_SCHOOL_INTERNAL   ← 교과서 본문 빈칸
```
셋 다 서로 다른 조합이며 각각 저장·조회된다.

**Group A — 수능/모의고사형 (19종)**
주제 · 제목 · 요지 · 주장 · 목적 · 내용 일치 · 내용 불일치 · 빈칸 · 문장 삽입 · 글의 순서 · 무관한 문장 · 요약문 완성 · 어휘 · 문맥상 의미 · 지칭 추론 · 추론 · 필자의 태도 · 장문 독해 · 복합 문항

**Group B — 중학교 내신 (교과서 본문 기반, 9종)**
본문 내용 이해 · 세부 내용 · 영영풀이 · 어휘 변형 · 문장 변형 · 서술형 · 본문 빈칸 · 본문 어법 · 본문 순서

**Group C — 고등학교 내신 추가 (4종)**
본문 변형 · 어법 · 고난도 추론 · 요약

> 스펙 §12의 고등 내신 목록(본문 변형/빈칸/어법/순서/문장 삽입/어휘/요약/서술형/고난도 추론) 중 빈칸·순서·문장 삽입·어휘는 Group A와, 서술형은 Group B와 **완전히 같은 유형**이라 중복 정의하지 않는다. 같은 유형을 group마다 복제하면 "빈칸"이 3개의 다른 key로 갈라져 통계가 쪼개진다. Group C에는 A·B에 없는 4개만 넣고, 조합은 `examType`이 표현한다.

### 12.8 status / review / versioning — Phase 5 재사용

**status**: Phase 5 `STATUS_FLOW` / `canTransition`을 **그대로** 쓴다.
`DRAFT → AI_REVIEW → TEACHER_REVIEW → APPROVED → PUBLISHED (+ARCHIVED)`, PUBLISHED는 APPROVED에서만, ARCHIVED 탈출은 DRAFT만. Passage와 Question 둘 다 같은 파이프라인을 탄다.

**versioning**: Phase 5 copy-on-write를 Passage/Question 양쪽에 적용한다.
- Question content fields: `passageId`, `grade`, `difficulty`, `questionType`, `examType`, `questionText`, `choices`, `answer`
- Passage content fields: `title`, `passageText`, `grade`, `difficulty`, `passageType`, `examType`

**지문 fork는 문제로 cascade하지 않는다 (중요한 결정).** 출제된 지문 P1을 수정하면 P1은 ARCHIVED(내용 그대로 보존), P2가 새 DRAFT로 생긴다. 기존 문제 Q1~Q5는 **계속 P1을 가리킨다** — 과거 시험이 참조하는 지문 내용이 불변이어야 하기 때문. 결과적으로 P2는 문제가 0개인 상태로 시작한다.
→ UI에서 이 사실을 명시적으로 안내한다. "P2로 문제도 복사" 액션은 **이번 Phase 미구현(TODO)** — 자동 복사는 fingerprint 중복 경고를 대량 유발하고 usageCount 의미가 모호해져서, 교사가 의도적으로 선택하는 별도 기능이어야 한다.

**삭제 정책**: Phase 5와 동일(DRAFT+미사용만 완전 삭제, 그 외 ARCHIVED). 추가로 **문제가 1개 이상 연결된 지문은 삭제 불가** — 고아 문제(orphan)가 생기지 않도록 가드한다(§6-N-9의 orphan 학생문서와 같은 실수를 반복하지 않는다).

**review**: Reading 전용 10항목 (스펙 §11).

| 필드 | 기준 |
|---|---|
| `passageQuestionLink` | ① 지문과 문제의 논리적 연결 |
| `answerClarity` | ② 정답의 명확성 |
| `distractorQuality` | ③ 오답의 매력도 |
| `evidenceClarity` | ④ 지문 근거의 명확성 |
| `difficultyAppropriate` | ⑤ 난이도 |
| `gradeAppropriate` | ⑥ 학년 적합성 |
| `examTypeFit` | ⑦ 시험 유형 적합성 |
| `notRoteMemory` | ⑧ 단순 암기 문제 여부 |
| `discrimination` | ⑨ 문제 변별력 |
| `explanationValue` | ⑩ 해설의 교육적 가치 |

Phase 5와 같은 3-state(`null` 미확인 / `true` PASS / `false` FAIL) + `reviewNote`/`reviewedBy`/`reviewedAt`. 스펙의 `UNCHECKED/PASS/FAIL`이 이 3-state와 정확히 대응하므로 별도 문자열 enum을 만들지 않는다.

### 12.9 Question Bank Core 확장 (기존 Grammar를 깨뜨리지 않는 범위)

Phase 5 Core는 `collectionName` 파라미터화가 이미 돼 있지만, 실제로 Reading을 얹어보니 **3곳이 Grammar 전용으로 굳어 있었다.** 최소 확장한다.

| Core 요소 | 현재 (Phase 5) | Phase 6 확장 |
|---|---|---|
| `createQuestion()` | 고정 doc 리터럴 — `passageId`/`examType`/`targetSkill` 같은 미지 필드를 **버린다** | 세 번째 인자 `extraFields`를 받아 merge (Grammar 호출부는 인자 미전달 → 동작 불변) |
| `updateQuestion()` | `CONTENT_FIELDS` 상수 하나에 고정 | 네 번째 인자로 추가 content field 목록을 받아 fork 판정에 합류 |
| `queryQuestions()` | grade/difficulty/mainCategory/subCategory/questionType/source/status/tags/search 고정 | `examType`/`passageId`/`targetSkill` 등 **범용 equality 필터**로 일반화 |
| `blankReview()` | Grammar 8항목 고정 | schema key를 받아 Grammar 8 / Reading 10을 반환 (Grammar 기본값 유지) |
| Passage CRUD | 없음 | `createPassage`/`updatePassage` 추가. status·fork·fingerprint·delete-guard 로직은 **공용 내부 함수로 추출해 재사용**(중복 구현 금지) |

**Grammar 회귀 방지**: 위 확장은 전부 optional 파라미터/기본값 방식이라 기존 `createGrammarQuestion`/`updateGrammarQuestion`/`queryQuestions` 호출부는 한 글자도 바뀌지 않는다. Phase 6 regression에서 Grammar Bank를 반드시 재확인한다.

### 12.10 Exam Builder query + 향후 취약점 분석

이번 Phase도 **완전한 Exam Builder는 만들지 않는다.** Phase 5의 `pickQuestionsForExam`(status PUBLISHED 강제)에 Reading 필터가 통하도록만 만들고, Preview UI로 실제 동작을 확인한다.

```js
pickQuestionsForExam(list, { grade:"고1", examType:"MOCK_EXAM", questionType:"blank", difficulty:"ADVANCED" }, 3)
pickQuestionsForExam(list, { grade:"중3", examType:"HIGH_SCHOOL_INTERNAL", questionType:"contentMatch", difficulty:"INTERMEDIATE" }, 5)
pickQuestionsForExam(list, { grade:"중2", examType:"MIDDLE_SCHOOL_INTERNAL", questionType:"textBlank", difficulty:"BASIC" }, 10)
```

**향후 학생 독해 취약점 분석 (Phase 10)** — 응시 결과에 `questionId`를 저장해두면:
```
student → exam → questionId → 정/오
                    ↓ (readingQuestions 조인)
          questionType / targetSkill / examType / difficulty
                    ↓ (집계)
   "빈칸추론 54% · 내용일치 88% · 순서 61% · 어휘 79%"
   "MAIN_IDEA 82% · INFERENCE 51% · VOCABULARY_IN_CONTEXT 73%"
```
`targetSkill`을 별도 축으로 둔 이유가 여기 있다 — 문제 유형별 정답률은 "무슨 문제를 틀리나"를, skill별 정답률은 "어떤 능력이 부족한가"를 말해준다. 둘은 다른 처방으로 이어진다.

### 12.11 구현 후 정정 기록

- **`services/questionBankService.js` 내부 리팩터링**: `updateQuestion`의 fork-or-merge 로직을 `forkOrUpdate(collectionName, existingDoc, patch, contentFields, opts, fingerprintField, deriveFields)` 공용 함수로 추출했다(§12.9에서 예고한 "공용 내부 함수로 추출해 재사용"의 실제 형태). `updateQuestion`/`updatePassage` 둘 다 이 함수를 얇게 감싼다 — `deriveFields`가 은행별 파생 필드(문법은 `choices`/`answerFormat`/`answer`, 리딩 지문은 `wordCount`/`estimatedReadingTime`)만 계산하고, fork/archive/fingerprint 로직 자체는 완전히 공유된다.
- **삭제 정책 문구 보강**: 사용자가 승인 메시지에서 "REVIEW/APPROVED/PUBLISHED는 삭제 불가 → ARCHIVED"를 재확인 요청함에 따라, `canHardDelete`(Phase 5부터 이미 `status === "DRAFT" && usageCount === 0`로 이 규칙을 만족)가 Passage/Question 양쪽에 동일 적용됨을 실제 브라우저에서 재검증했다(§13 regression 결과 참고). 코드 변경 없음, 기존 Phase 5 가드가 이미 스펙을 만족.
- **`estimatedReadingTime`의 학년별 WPM**은 실측 데이터가 아니라 휴리스틱 추정치임을 코드 주석에 명시했다(`중1:80 ~ 고3:130`, L2 독해 속도의 대략적 근사) — 향후 실제 학생 읽기시간 데이터(Phase 4 `readingActivity.readingTimeSec`)가 쌓이면 보정할 수 있는 자리로만 존재한다.

---

## 13. Exam Builder (Phase 7 설계, 2026-08-24)

> **이 절은 설계 문서다 — 코드 미구현.** 사용자 승인 후 별도 Phase로 착수한다. Phase 5(`grammarQuestions`)와 Phase 6(`readingPassages`/`readingQuestions`)이 이미 구현·커밋된 상태(`7f31d7c`, `520db22`)를 전제로 설계했다. **AI API 호출 0건**, **기존 데이터 migration 없음**, **기존 시험 기능 삭제/대체 없음** — 전부 additive.

### 13.1 기존 시험 시스템과의 관계 — 대체가 아니라 새 계층 하나 추가

이 repo에는 이미 4개의 서로 다른 "시험" 개념이 공존한다(§2.4). Exam Builder는 이들을 **지우거나 통합하지 않는다** — 그 위에 "문제은행에서 시험지를 조립한다"는 다섯 번째 계층을 additive하게 얹는다.

| 기존 시스템 | 정체 | Exam Builder와의 관계 |
|---|---|---|
| `examTests[]`/`examResults[]` | 교사가 손으로 만든 즉석 시험 (학생 문서 내 배열) | 그대로 유지. Exam Builder로 만든 시험지는 여기 쓰지 않고 새 컬렉션에 별도로 쌓인다 |
| `mockExams[]`/`mockExamResults[]` | 공식 모의고사 정답지 + 온라인 응시 결과 | 그대로 유지. 구조(온라인 응시·자동채점)는 향후 §13.10의 참고 모델이지만 지금 통합하지 않는다 |
| `regularExams[]` | 내신/모의고사/교재성취평가 **성적 기록부** (진짜 성적표) | 그대로 유지. Exam Builder로 만든 시험을 실제로 치른 뒤 "몇 점 받았다"를 여기 남기는 연결은 향후 어댑터로 미룬다(§13.10) |
| `examKeyLibrary` | **스캔된 외부 시험지**의 정답표를 AI-vision으로 읽어 등록 | 완전히 다른 기능이다 — Exam Builder는 **이 repo 문제은행에서 직접 조립**한 시험지를 다루고, `examKeyLibrary`는 **외부에서 이미 존재하는 시험지**의 정답만 디지털화한다. 서로 겹치지 않는다 |

즉 Exam Builder의 결과물(가칭 `examPapers`)은 **6번째 컬렉션으로 새로 추가**되며, 위 4개 중 어느 것도 읽기 전용 조회 이상으로 건드리지 않는다.

### 13.2 왜 지금 이게 가능해졌는가 — Versioning이 선행 투자였던 이유

Phase 5/6에서 만든 copy-on-write versioning(§11.8/§12.8)은 당시엔 "미래를 위한 안전장치"였지만, Exam Builder가 그 미래다. **시험지는 문제의 내용을 복제 저장하지 않고 `questionId`만 참조한다** — 나중에 교사가 그 문제를 수정해도:
- `usageCount > 0`이 되는 순간부터는 내용 수정이 자동으로 fork(새 버전)를 만들고 원본은 ARCHIVED로 내용이 고정된다(§11.8/§12.8).
- 즉 시험지가 참조하는 `questionId`의 문제 내용·정답은 **그 시험지가 만들어진 순간부터 영원히 그대로**다 — Exam Builder가 스냅샷을 따로 저장할 필요가 없다.

이 원칙이 §13.4 스키마 설계(내용 복제 없이 참조만 저장)의 근거다.

### 13.3 Firestore 컬렉션 — `examPapers` (신규, 6번째... 아니 15번째 전체 컬렉션)

```
examPapers/{autoId}
```

기존 컬렉션과 마찬가지로 최상위 플랫 컬렉션(서브컬렉션 아님) — Grammar/Reading Bank와 같은 이유(§12.2): 인덱스 미관리 repo에서 collectionGroup 쿼리를 피하고, 기존 콘텐츠 컬렉션과 접근 패턴을 통일한다.

`services/backupService.js` export에도 추가한다(구현 시 version bump).

### 13.4 ExamPaper schema

```js
{
  id,
  title,                    // "2026 2학기 중간고사 대비 문법 모의고사 A형"
  grade,                     // optional, 참고용 라벨(브라우징/검색 편의) — 섹션별 grade를 강제 통일하지 않음
  examType,                  // optional, 참고용 대표 시험 목적(READING_EXAM_TYPES 재사용) — 사용자 결정 §13.12-3: 강제 아님, section/question의 examType을 덮어쓰지 않음
  status,                    // DRAFT | FINALIZED | ARCHIVED — §13.8
  sections: [
    {
      id,                          // section 내부 id (uid)
      label,                       // "SECTION 1. GRAMMAR", "SECTION 2. READING" 등 자유 텍스트 — 사용자 결정 §13.12-2: 한 시험지에 grammar/reading 섹션 혼합 허용
      bank,                        // "grammar" | "reading"
      // reading 섹션은 지문 단위로 묶인다 — 하나의 section이 passage 1개 + 그 지문에 딸린 문제 N개.
      // grammar 섹션은 지문이 없으므로 questionId 배열만 가진다.
      passageId,                   // bank==="reading"일 때만. readingPassages 문서 참조
      shuffleQuestions: false,     // 이 섹션 내 문제 순서를 무작위화할지 (§13.6) — DRAFT 동안의 의도, FINALIZE 시점에 실행되고 그 결과가 questionRefs[].order에 고정됨
      shuffleChoices: false,       // 객관식 보기 순서를 무작위화할지 (§13.6) — 위와 동일하게 FINALIZE 시점에 실행·고정
      questionRefs: [
        {
          questionId,              // 내용 복제 없음 — grammarQuestions 또는 readingQuestions 문서 id만 참조
          order,                   // 이 섹션 안에서의 최종 표시 순서(0-based). DRAFT 동안은 교사가 배치한 순서, FINALIZE 시점에 shuffleQuestions=true면 무작위 재배치 후 이 값으로 고정 — 사용자 결정 §추가요구사항5
          choiceDisplayOrder,      // number[] | null. 원본 choices 배열의 index를 "표시 순서"로 나열한 순열. mc가 아니거나 셔플 안 함이면 null(=원본 순서 그대로). FINALIZE 시점 1회만 계산·고정 — §13.6
        },
      ],
    },
  ],
  totalQuestionCount,       // 파생값, sections를 순회해 계산 (저장은 하되 매번 재계산해 덮어씀 — 진짜 소스는 sections)
  createdAt, updatedAt, createdBy,
  finalizedAt,              // FINALIZED로 전환된 시점 — 이 시점에 참조된 모든 questionId의 usageCount를 +1 (§13.8), 동시에 order/choiceDisplayOrder가 이 시점 값으로 고정됨
}
```

**지문(Passage)이 시험지 안에서 어떻게 표현되는가**: `passageId`만 저장하고 본문은 복제하지 않는다(readingLibrary/readingQuestions의 "복제 저장 금지" 원칙, §8.1/§12.2와 동일). Preview/인쇄 시점에 `readingPassages`에서 조인해 렌더링한다.

**재현성(사용자 결정 §추가요구사항6)**: `choiceDisplayOrder`/`order`가 examPaper 자체에 값으로 저장되므로(seed 아님, 결과값 자체), 셔플 알고리즘이 나중에 바뀌어도 과거 FINALIZED 시험지의 렌더링은 영향받지 않는다. 원본 문제가 이후 `usageCount>0` 상태에서 수정되면 copy-on-write(§11.8/§12.8)에 의해 **새 id로 fork**되고 원본 id의 내용은 그대로 보존되므로, examPaper가 참조하는 `questionId`는 fork 여부와 무관하게 항상 FINALIZE 당시의 정확한 버전을 가리킨다 — 시험지 쪽에서 별도 버전 필드를 저장할 필요가 없다.

### 13.5 선택 모드 — 자동 / 수동 / 혼합

Phase 5/6에서 이미 만든 `pickQuestionsForExam(list, filters, count)`(PUBLISHED 강제)를 그대로 확장 지점으로 쓴다. 세 모드는 배타적이지 않고 **교사가 섞어 쓸 수 있는 하나의 작업 흐름**이다.

**자동 선택**: "요구사항 행(requirement row)"의 배열을 입력받아 각 행마다 `pickQuestionsForExam`을 호출하고 결과를 섹션에 채운다.
```js
requirements: [
  { bank: "grammar", filters: { grade:"중3", mainCategory:"tense", questionType:"blank", difficulty:"INTERMEDIATE" }, count: 5 },
  { bank: "reading",  filters: { grade:"고1", examType:"MOCK_EXAM", questionType:"blank", difficulty:"ADVANCED" }, count: 3 },
]
```
Reading은 `pickQuestionsForExam`이 **문제**를 반환하므로, 자동 선택 시 같은 지문(`passageId`)에 속한 문제들을 자동으로 하나의 section으로 묶는 로직이 필요하다(문제만 뽑고 지문을 안 뽑으면 렌더링이 불가능하므로) — 이번 설계에서 명시해두는 구현 시 유의점.

**수동 선택**: 기존 `QuestionBankSection`의 목록/필터 UI를 재사용해 교사가 직접 문제(또는 지문+문제 세트)를 골라 "시험지에 추가" — 새 컴포넌트를 만들기보다 기존 목록 뷰에 "선택 모드" 토글을 얹는 방식이 재사용에 가깝다.

**혼합**: 자동으로 초안을 채운 뒤 개별 문제를 수동으로 빼고 넣는 것 — 실무적으로 가장 많이 쓰일 흐름이라고 예상되며, 자동/수동이 같은 `sections` 상태를 다루는 한 자연스럽게 지원된다(별도 모드 전환 상태가 필요 없다).

**PUBLISHED 강제는 그대로 유지**: 자동이든 수동이든 DRAFT/REVIEW 상태의 문제는 시험지에 들어갈 수 없다 — 이미 `pickQuestionsForExam`이 강제하고 있고, 수동 선택 UI도 목록에서 PUBLISHED가 아닌 문제는 "추가" 액션을 비활성화해야 한다(신규 가드, 구현 시 필요).

### 13.6 셔플 — 순서 무작위화와 정답 무결성

가장 실수하기 쉬운 지점이라 명시적으로 설계한다.

**사용자 결정(§추가요구사항1/5): 셔플 인스턴스는 저장한다.** 매 렌더링마다 새로 무작위화하지 않고, **FINALIZE 시점에 한 번** 순서를 확정해 `examPaper.sections[].questionRefs[].order`/`choiceDisplayOrder`에 값으로 저장한다. 이후 그 시험지는 항상 동일한 순서로 렌더링된다("A형/B형 여러 종" 같은 변형 인쇄는 이번 Phase 범위 밖 — §13.11).

- **문제 순서 셔플**: `shuffleQuestions=true`면 FINALIZE 시점에 섹션 내 `questionRefs`를 무작위로 재배열하고 그 결과 순서를 `order`로 고정한다. 각 문제 자체의 `answer`는 무관하므로 위험 요소 없음.
- **보기(choices) 순서 셔플**: 원본 문서의 `choices`/`answer`는 **절대** 건드리지 않는다(공유 문제은행이라 여러 시험지가 같은 문제를 참조할 수 있고, 원본을 섞으면 전부 깨진다). 대신 FINALIZE 시점에 순수 함수로 순열을 1회 계산해 그 결과(`choiceDisplayOrder`, 원본 index들의 배열)만 `examPaper`에 저장한다.
  - 렌더링 시 `resolveQuestionForDisplay(questionDoc, choiceDisplayOrder)`가 `{ displayChoices, displayAnswerIndex }`를 반환 — `displayChoices = choiceDisplayOrder.map(i => questionDoc.choices[i])`, `displayAnswerIndex = choiceDisplayOrder.indexOf(Number(questionDoc.answer))`. 원본 문서는 읽기만 하고 쓰지 않는다.
  - `choiceDisplayOrder`가 `null`이면(셔플 안 함, 또는 mc 아님) 원본 순서를 그대로 쓴다.
  - seed 기반이 아니라 **결과값 자체를 저장**하므로, 셔플 알고리즘이 나중에 바뀌어도 과거 시험지 재현에 영향이 없다(§추가요구사항6, 위 §13.4 참고).

### 13.7 시험지 Preview

지문·문제·보기를 실시간 조인해서 화면에 렌더링하되 **아무것도 저장하지 않는다**. 기존 4곳의 "새 창 인쇄" 패턴(§6-M-1, `wordtest.html`의 가장 견고한 구현을 표준으로 삼는다고 이미 §6에 기록돼 있음)을 그대로 재사용 — 다섯 번째 구현을 새로 만들지 않고 기존 패턴을 호출하는 방향으로 구현 Phase에서 검토한다.

### 13.8 저장 / 상태 — DRAFT → FINALIZED → ARCHIVED

Question Bank의 6단계 파이프라인(DRAFT→AI_REVIEW→...→PUBLISHED)을 그대로 재사용하지 않는다 — **시험지 자체는 "검수 대상 콘텐츠"가 아니라 "문제들의 조합"**이라 성격이 다르다. 대신 3단계로 단순화한다.

| 상태 | 의미 |
|---|---|
| `DRAFT` | 조립 중, 언제든 문제 추가/삭제/교체 가능 |
| `FINALIZED` | 교사가 "이 조합으로 확정" — 이 시점에 참조된 모든 `questionId`의 `usageCount`를 +1 한다. **usageCount가 올라간 순간부터 그 문제들은 Question Bank의 copy-on-write 규칙(§11.8/§12.8)에 의해 내용이 사실상 고정**된다(수정하면 원본은 그대로 두고 fork됨) — 이게 이 설계 전체의 핵심 안전장치다 |
| `ARCHIVED` | 더 이상 쓰지 않지만 이력(어떤 학생이 이 시험을 봤는지, 향후 §13.10)을 위해 보존 |

**FINALIZED를 되돌리는 경로는 만들지 않는다(DRAFT로 되돌리기 없음)** — Question Bank의 PUBLISHED처럼 "여기서부터는 실제로 쓰였다"는 경계선이며, 되돌리면 이미 증가시킨 `usageCount`를 다시 낮춰야 하는데 그 사이에 그 문제가 다른 시험지에도 쓰였다면 이중 계산 문제가 생긴다. 시험지를 고치고 싶으면 ARCHIVED 처리 후 새 시험지를 만든다(Question Bank의 fork 원칙과 대칭적인 설계).

### 13.9 향후 학생 배정 / 응시 / 채점 연결 (이번 Phase 미구현 — 스키마 훅만)

`mockExams`/`mockExamResults`가 이미 이 repo에 존재하는 참고 모델이다(온라인 응시, `startedAt`/`submittedAt`, 클라이언트 채점 — 단 `FIRESTORE_SECURITY_PLAN.md` §7이 이미 "시험 정답이 클라이언트에서 채점되는 구조"를 문제로 지적하고 Exam Studio Phase로 미뤄둔 상태임을 유의). Exam Builder가 만든 `examPapers`를 향후 이 패턴으로 확장할 때 필요할 스키마 훅만 미리 명시해둔다(구현 안 함):

```
examPapers/{id}.assignedTo: [studentId]        // 향후, 지금은 없음
examAttempts/{id}                               // 향후 신규 컬렉션(가칭). examPaperId + studentId + answers[] + score
                                                 // mockExamResults와 같은 패턴, 단 questionId 기반이라
                                                 // 문항별 채점/정오답 기록이 세밀해짐 — §13.10-a
```

**§13.10-a — Student Weakness Analytics로의 연결(§11.9/§12.10에서 이미 설계한 것과 동일한 조인)**: `examAttempts`가 `questionId`별 정오답을 기록하면
```
student → examAttempt → questionId → 정/오
             ↓ (grammarQuestions 또는 readingQuestions 조인)
   mainCategory/subCategory/questionType(문법) 또는 examType/questionType/targetSkill(독해)
             ↓ (집계)
   학생별 취약 유형/영역 통계
```
`regularExams`(현재 성적 기록부)와의 관계는 **병존**이다 — `regularExams`는 교사가 수기로 남기는 성적 요약, `examAttempts`는 향후 문항 단위 자동 기록. 하나가 다른 하나를 대체하지 않는다(§6.1의 "Historical Snapshot vs Live Analytics" 원칙과 같은 구도가 될 가능성이 높다 — 실제 구현 Phase에서 다시 확인).

### 13.10 API 비용 정책 재확인

시험지 생성/검색/조합의 모든 단계(자동 선택 쿼리, 수동 검색/필터, 셔플 계산, Preview 렌더링, 저장) — **AI API 호출 0건**. `pickQuestionsForExam`/`queryQuestions`는 이미 순수 Firestore-read + JS 계산이고(§11.9/§12.10), 이번 설계에서 추가하는 셔플 함수·섹션 조립 로직도 전부 클라이언트 JS 계산이다. AI 관련 기능(예: "AI로 유사 난이도 문제 자동 보충")은 이번 설계에 포함하지 않았고, 향후 필요해지면 CLAUDE.md의 API 비용 정책에 따라 `questionGenerationService.js`류의 완전히 분리된 모듈로만 추가한다.

### 13.11 이번 Phase 설계에서 명시적으로 제외한 것 (§13.9와 별개로, 아예 다루지 않은 것)

- 실제 학생 응시 UI(온라인 시험 화면)
- 자동 채점 로직
- 문항별 통계/취약점 분석 대시보드
- A형/B형처럼 같은 시험지의 셔플 변형을 몇 종 인쇄할지에 대한 정책 UI
- `regularExams`와 `examAttempts`를 하나로 합치는 마이그레이션(영구히 안 할 수도 있음 — §6.1과 같은 병존 원칙 후보)

### 13.12 결정 사항 (사용자 승인, 2026-08-24)

이전 버전의 이 절은 3개의 미해결 질문이었다. 사용자가 다음과 같이 확정했다 — 구현은 이 결정을 그대로 따른다.

1. **셔플 인스턴스 저장: YES.** FINALIZE 시점에 순서를 1회 확정해 값으로 저장한다(매 렌더링 재계산 아님). `examPaperVariants` 같은 별도 컬렉션은 만들지 않고, 확정된 순서를 `examPapers` 문서 자체(`questionRefs[].order`/`choiceDisplayOrder`)에 저장한다 — §13.4/§13.6에 반영 완료.
2. **Grammar + Reading 혼합: YES.** 한 시험지 안에 grammar 섹션과 reading 섹션을 자유롭게 섞을 수 있다. section 단위로 명확히 구분되며(`bank` 필드), reading section은 passage + 그 문제들을 항상 함께 유지한다 — §13.4에 반영 완료.
3. **`examType` 전체 통일: NO.** 시험지 전체에 examType을 강제하지 않는다. `examPapers.examType`은 optional 대표 라벨(브라우징 편의용)일 뿐, section/question 각각의 examType을 덮어쓰거나 검증하지 않는다 — §13.4에 반영 완료.

**추가 요구사항 (사용자 승인, 2026-08-24)**:
4. examPaper는 문제 내용을 복제 저장하지 않고 `questionId` 참조 중심으로만 저장한다 (§13.2/§13.4 기존 설계 그대로 유지).
5. FINALIZE 시점의 최종 question order/choice display order는 examPaper에 값으로 저장한다 (§13.4/§13.6에 반영 완료).
6. **과거 시험 재현성이 최우선.** 원본 Question이 이후 versioning되더라도 과거 FINALIZED examPaper는 당시 문제 버전을 그대로 재현해야 한다 — copy-on-write가 이미 이를 보장함을 §13.4에 명시(별도 버전 필드 불필요).
7. 학생 배정/응시/채점은 이번 Phase에서 구현하지 않는다. §13.9의 스키마 훅 설명만 유지하고, 실제 필드(`assignedTo` 등)는 이번 구현에 추가하지 않는다.
8. AI API 호출 0회 — §13.10 그대로 유지.
9. 기존 단어시험/모의고사/Exam 시스템(`examTests`/`mockExams`/`regularExams`/`examKeyLibrary`)은 수정·대체하지 않는다 — §13.1 그대로 유지.
10. `examPapers` 컬렉션은 additive로만 추가한다.

**다음 단계**: 구현 착수. 구현 후 불필요한 screenshot/전체 regression 대신 DOM/JS 기반 최소 테스트로 검증한다.

---

## 14. Sarah's Original + 품질관리 (원래 로드맵 7번, 설계 2026-08-24)

> **이 절은 설계 문서다 — 코드 미구현.** 사용자 승인 후 구현 Phase 착수. 이 Phase는 지금까지의 Phase 5~7과 성격이 다르다 — **이 프로젝트에서 처음으로 AI API 호출이 실제로 관련되는 지점**이라, CLAUDE.md의 API 비용 정책을 코드로 강제하는 설계가 핵심이다.

### 14.1 "Sarah's Original"이 무엇인가 — 새 컬렉션이 아니라 새 출처(source)

Phase 0 시점 스케치(§8)는 `originalQuestions`라는 **별도 컬렉션**을 제안했었다. 하지만 Phase 5/6을 실제로 구현해보니 이미 다음이 전부 갖춰져 있다:
- `source.type` enum에 `AI_GENERATED`가 이미 존재(§11.2 `SOURCE_TYPES`)
- status pipeline에 `AI_REVIEW` 단계가 이미 존재하고, **PUBLISHED는 APPROVED에서만 진입 가능**하다는 가드가 이미 구현·검증됨(§11.5, "AI가 자동으로 승인하지 않는다"를 코드로 이미 강제하고 있음)
- Grammar/Reading 두 은행 모두 fingerprint 중복탐지·versioning·delete 정책을 이미 공유

**따라서 별도 컬렉션을 만들지 않는다.** "Sarah's Original"은 새로운 콘텐츠 종류가 아니라 **기존 `grammarQuestions`/`readingQuestions`에 AI가 채워 넣는 DRAFT**다 — `source.type: "AI_GENERATED"`로 표시되고, 그 외에는 교사가 손으로 입력한 문제와 완전히 동일한 파이프라인(검수→승인→출제)을 탄다. Phase 0 스케치의 `AI_DRAFT|AI_CHECKED|...` 전용 status enum도 불필요 — 이미 구현된 `STATUS_FLOW`(DRAFT→AI_REVIEW→TEACHER_REVIEW→APPROVED→PUBLISHED)가 그 역할을 한다.

이 정정은 §11.10/§12.11이 이미 해온 것과 같은 종류다 — Phase 0 스케치보다 실제 구현된 Core가 우선한다.

### 14.2 이미 존재하는 AI 백엔드와의 관계

`functions/index.js`(`aiWorker`)에 이미 배포된 관련 모드가 있다:
- 기본 모드(no `mode`, `SYSTEM_PROMPT`) — 지문을 넣으면 수능 유형 문제를 생성. 현재 출력은 `passage-transform.html`이 받아 `passageArchive`에 저장한다.
- `examVariant` 모드(`VARIANT_SYSTEM_PROMPT`) — 오답 1개를 주면 같은 세부 문법/어휘 하위유형의 새 문제 N개를 생성. 현재 오답노트 재시험 화면에서 직접 소비.

**이번 Phase가 하는 일은 AI를 새로 만드는 게 아니라, 이미 있는 AI 출력의 "도착지"를 Question Bank로 하나 더 연결하는 것이다.** 기존 `passage-transform.html`/오답노트 재시험 기능은 전혀 건드리지 않는다(그 경로들은 그대로 `passageArchive`/재시험 화면으로 계속 간다) — Question Bank 연결은 **완전히 별도의, 추가적인 진입점**이다.

### 14.3 `services/questionGenerationService.js` — AI를 호출하는 유일한 파일

CLAUDE.md API 비용 정책(§4 서비스 레이어 분리)을 그대로 구현한다.

```
questionBankService.js       ← AI 호출 0건 (검증됨, §11.1/§12.1). 이번 Phase에서도 이 파일은 건드리지 않는다.
questionGenerationService.js ← AI 호출이 허용되는 유일한 파일 (신규)
```

**호출은 오직 교사의 명시적 버튼 클릭에서만 발생한다** — 페이지 로드/은행 열람/검색/필터 그 무엇도 이 서비스를 부르지 않는다. 구조:

```js
// 의사코드 — 실제 시그니처는 구현 시 확정
async function generateGrammarQuestionDrafts({ grade, mainCategory, subCategory, questionType, difficulty, count }) {
  // 1. aiWorker 호출 (fetch, provider-agnostic 어댑터 뒤에 숨김 — §14.7)
  // 2. 응답을 grammarQuestions 스키마로 매핑
  // 3. QB.createGrammarQuestion(..., { extraFields: { source: { type: "AI_GENERATED", note: "..." } } })로
  //    저장 — 이 함수 자체는 questionGenerationService가 아니라 questionBankService의 기존 함수를 그대로 호출
  // 4. 저장된 DRAFT 배열 반환 (버려지지 않음, §14.5)
}
```

**호출 방향이 중요하다**: `questionGenerationService`는 `questionBankService`의 `createGrammarQuestion`/`createReadingQuestion`을 **호출**하지만, 그 반대는 성립하지 않는다(`questionBankService`는 `questionGenerationService`를 알지도 못한다). 이 단방향 의존성이 "Question Bank는 AI 없이도 완전히 작동해야 한다"(CLAUDE.md)를 파일 구조로 강제한다.

### 14.4 Provider-agnostic 어댑터

```js
// questionGenerationService.js 내부, 노출하지 않는 내부 함수
async function callProvider(prompt, opts) {
  // 지금은 aiWorker(Claude) 하나만 실제 연결.
  // 향후 Gemini/OpenAI/로컬 모델 추가 시 이 함수 내부만 분기하면 되고,
  // generateGrammarQuestionDrafts 등 상위 함수는 provider를 몰라도 된다.
}
```
이번 Phase에서 실제로 다른 provider를 붙이지는 않는다 — **분기 가능한 형태로만** 만들어둔다(CLAUDE.md §8 요구사항).

### 14.5 UI — 비용 표시 + 결과는 항상 저장

**"AI로 문제 생성" 버튼에는 예외 없이 비용 경고를 표시한다**: "AI 사용 — API 비용 발생" + 예상 생성 개수. 클릭 전에 조건(학년/대주제/난이도/개수)을 먼저 설정하게 하고, 실행은 별도의 명확한 확인 클릭을 한 번 더 요구한다(실수로 여러 번 눌러 중복 과금되는 사고 방지).

**생성 결과는 항상 DRAFT로 저장된다** — Preview만 하고 버리는 흐름은 만들지 않는다(CLAUDE.md: "같은 문제를 다시 생성하지 않도록 한다", 재생성 = 중복 과금). 생성 직후 화면은 자동으로 Question Bank 목록의 "AI_GENERATED 출처, 방금 생성됨" 필터로 이동해 교사가 바로 검수를 시작할 수 있게 한다.

**품질관리 대시보드**(이번 Phase의 "품질관리" 부분): Grammar/Reading 두 은행을 가로질러 "AI_REVIEW 또는 TEACHER_REVIEW 상태인 문제"만 모아 보여주는 큐 뷰를 추가한다 — 지금은 은행별로 따로 필터링해야 검수 대상을 찾을 수 있는데, AI 생성 물량이 늘면 이 교차 큐가 필요해진다. `QB.queryQuestions`를 grammar 목록과 reading 목록에 각각 돌려 합치면 되므로 Core 변경은 필요 없다.

### 14.6 중복 방지와의 상호작용

AI가 대량으로 문제를 생성하면 fingerprint 중복 경고(§11.7/§12.11)가 자주 뜰 수 있다 — 이는 **버그가 아니라 의도된 동작**이다. AI에게 "이런 유형으로 5개 만들어줘"를 반복 요청하면 비슷한 문장이 나올 가능성이 높고, 기존의 비차단 경고 방식이 그대로 작동해 교사가 판단하게 한다. 이번 Phase에서 이 동작을 바꾸지 않는다.

### 14.7 API 비용 정책 재확인

- Question Bank 조회/검색/필터/저장/버저닝: AI 호출 0건 (변경 없음)
- AI 호출은 오직 "AI로 문제 생성" 버튼 클릭 시에만, `questionGenerationService.js` 안에서만 발생
- 개발/테스트 중에는 실제 AI API를 호출하지 않는다 — mock 응답 또는 고정 fixture로 `questionGenerationService`의 저장 경로(응답 매핑 → DRAFT 저장 → source.type 표시)를 검증한다. 실제 호출은 사용자가 명시적으로 요청할 때만.

### 14.8 이번 Phase에서 제외한 것

- 실제 두 번째 AI provider 연결(Gemini/OpenAI 등) — 어댑터 형태만 준비
- AI 유사도 기반 중복 탐지(비용 정책상 이번에도 금지, §11.7/§12.11과 동일한 이유)
- Reading 지문 자체의 AI 생성(현재 논의는 문제 생성에 한정 — 지문까지 AI로 만드는 것은 별도 확인 필요, open question)
- 오답노트 `examVariant` 경로를 Question Bank로 흡수하는 것(기존 기능 그대로 유지, 통합은 향후 별도 검토)

### 14.9 결정 사항 (사용자 승인, 2026-08-24)

1. **AI 생성 대상: Grammar + Reading 둘 다.** Reading은 지문 자체는 AI로 만들지 않는다 — **기존 PUBLISHED 지문에 문제만 AI로 추가 생성**한다(§14.8과 일관).
2. **API 호출 횟수 = 1클릭 1호출.** 기존 `examVariant` 핸들러(`functions/index.js:543` 부근)를 직접 확인한 결과, `count`(1~20으로 서버에서 clamp)는 프롬프트 안의 "몇 개 만들어라" 지시일 뿐이고 **Anthropic API 호출은 요청당 정확히 1번**이다(`fetch` 1회 → JSON 배열 응답에 N개 문항이 들어있음). 이번에 추가하는 두 새 모드도 동일 패턴을 따른다 — 비용 표시(§14.5)는 "1회 호출 · 최대 N개 생성"으로 정확하다.
3. **품질관리 큐: 이번 Phase에 포함.** `QuestionBankSection`에 은행 교차 "검수 대기" 탭을 추가한다.

**백엔드 조사 결과 — 왜 새 Cloud Functions 모드가 2개 필요한가**: 기존 `aiWorker`의 기본 모드는 **지문이 있어야만** 호출 가능한 "지문→문제 생성"이고, 그 문제 유형(`TYPE_INSTRUCTIONS`)도 수능형 17종에 한정돼 있어 우리 Reading taxonomy(32종, 중학교 내신 포함)와 맞지 않는다. `examVariant`는 "원본 문제 1개"가 반드시 있어야 한다. **Grammar는 지문도 원본 문제도 없이 조건(학년/대주제/세부문법/유형/난이도)만으로 생성**해야 하므로 기존 모드 어디에도 맞지 않는다. 그래서:
- **`grammarGenerate`(신규 모드)**: 조건 → 문제 배열. 기존 `examVariant`와 동일한 JSON 응답 스키마 관례를 따르되 `explanation`/`wrongChoiceExplanations`를 추가해 우리 스키마(§11.2)와 더 가깝게 맞춘다.
- **`readingGenerate`(신규 모드)**: PUBLISHED 지문 텍스트 + 우리 `READING_QUESTION_TYPES` 라벨 → 그 지문에 대한 문제 배열. 기존 기본 모드의 `TYPE_INSTRUCTIONS`/`SYSTEM_PROMPT`를 확장하지 않고 **완전히 새 프롬프트로 분리**한다 — `passage-transform.html`이 실제로 쓰는 기존 프롬프트를 공유 상수 형태로 건드리면 그 기능에 회귀 위험이 생기기 때문(기존 기능 절대 수정 금지 원칙).

두 모드 모두 기존 6개 모드(default/transform/monthlyReport/examkey/examVariant/nelt)의 코드·프롬프트·동작을 **한 글자도 바꾸지 않고** 새 분기로만 추가한다.

**다음 단계**: 구현 착수. 실제 Firebase 배포(`firebase deploy --only functions`)는 코드 작성·로컬 테스트가 끝난 뒤 **배포 직전에 별도로 다시 확인받는다.**
