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
| 6 | Reading Passage/Question Bank | 완전 신규 (`readingLibrary`와는 별개 — §8 참고) |
| 7 | Sarah's Original + 품질관리 | 완전 신규 |
| 8 | Exam Studio | `examTests`/`mockExams`/`examKeyLibrary`/`ExamKeyLibrarySection`(AI vision 파싱 이미 구현) 재배치 위주 |
| 9 | Vocabulary/Mock Exam 통합 | 이미 대부분 구현됨 — Daily/Monthly Report 자동조인에 연결하는 게 남은 일 |
| 10 | 학생 약점 분석 | 신규 — `regularExams`/`vocabResults`/`examResults`를 소스로 사용 |
| 11 | Business/Revenue UI 재구조화 | `RevenueOverviewSection`(`:2710`)/`tuitionRecords` 이미 존재 — 신규 네비게이션 구조로 이동 + UI 고급화 위주 |

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
