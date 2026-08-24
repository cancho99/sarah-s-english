# Firestore Security Plan — Analysis &amp; Design (rules not applied)

> 작성일: 2026-08-24, Phase 2 시작 시점 갱신. 이 문서는 **분석 → 설계 → 문서화**까지만 진행한 결과다. 어떤 Firestore 보안 규칙도 아직 배포/변경하지 않았다. 실제 rules 적용은 사용자 승인 후 별도로 진행한다.

## 결정 로그

- **2026-08-24 (Phase 1 완료 후)**: 사용자가 §3~5의 "목표 모델"(Anonymous Auth + Custom Claims 도입) 착수를 명시적으로 보류시켰다. 사유: 현재 로그인/권한 구조가 실서비스에서 쓰이고 있어, 인증 구조 변경이 기존 학생/학부모/교사 로그인에 영향을 줄 수 있음. **Anonymous Auth 도입 / Custom Claims 도입 / 로그인 플로우 변경 / 기존 auth 구조 변경 / 실제 Firestore Rules 배포**는 전부 별도의 "Security/Auth Phase"로 분리하고, 그 전까지는 현재 구조를 그대로 유지한다. 아래 §3~5, §11은 그 미래 Phase를 위한 설계로만 남겨둔다.
- **2026-08-24**: §7에서 제기한 "시험 정답이 클라이언트에서 채점되어 개발자도구로 열람 가능하다"는 점도 지금 당장 손대지 않는다. Exam Studio/Question Bank를 본격적으로 만드는 Phase에서 서버 측 채점/검증 구조를 다시 설계하기로 함.

## 0. 이 문서를 쓰기 전에 확인한 것 — 그리고 확인하지 못한 것

- `firestore.rules` 파일이 repo에 없다(`ARCHITECTURE.md` §1.3). 즉 지금 실제로 걸려 있는 규칙이 무엇인지는 **이 세션에서 직접 조회하지 못했다.** Firebase CLI(`firebase-tools 15.24.0`, 이 프로젝트에 로그인된 상태 확인됨)에는 Firestore 규칙을 읽어오는 전용 명령이 없다(Realtime Database의 `firebase database:get`과 달리, Firestore는 `firestore:rules:get` 같은 명령이 존재하지 않음). Rules API를 직접 호출하려면 별도 OAuth 토큰 추출이 필요해 이번 세션에서는 시도하지 않았다.
- 대신 **4개 HTML 파일 + Cloud Functions가 실제로 어떤 읽기/쓰기를 수행하는지**(코드 기준 사실)를 근거로 "지금 최소한 허용되어 있어야 하는 접근"을 역산했다. 아래 §1의 표는 전부 이 역산 결과다 — 실제 배포된 규칙과 다를 수 있다.
- **권장 조치**: Firebase Console → Firestore Database → 규칙 탭에서 현재 규칙 전문을 복사해 공유해 주시면, 이 문서를 실제 규칙과 대조해 갱신하고 §2의 위험 평가를 확정하겠다.

## 1. 현재 필요한 권한 (코드가 실제로 요구하는 최소 접근)

핵심 전제: **이 앱은 Firebase Authentication을 전혀 쓰지 않는다** (`getAuth`/`signInAnonymously`/`onAuthStateChanged` 전체 repo grep 결과 0건 — `functions/index.js` 포함). 교사/학생/학부모 로그인은 전부 브라우저 JS에서 `sarahsEnglishMeta/main` 문서를 읽어와 `teacherAuth.passcode`/`roster[].studentCode`/`roster[].parentCode`를 문자열 비교하는 것뿐이다. 즉 **Firestore 규칙에서 `request.auth`로 "이 요청이 교사인지 학생인지"를 구분할 방법이 현재 구조상 없다.**

| 컬렉션 | 읽기 필요 | 쓰기 필요 | 비고 |
|---|---|---|---|
| `sarahsEnglishMeta/main` | **로그인 전 모든 방문자** (코드 대조를 위해 홈 화면에서부터 전체 읽기 필요) | 교사(학생 CRUD/공지/정답표 라이브러리/할일/비밀번호 변경/드라이브 링크), **로그인 전 방문자**(레벨테스트·상담 예약 폼 제출 — `levelTestBookings`에 append), 모든 로그인 세션(FCM 토큰 등록) | 로그인 화면 자체가 이 문서를 열람할 수 있어야 동작하므로, 오늘 기준 **전체 읽기가 열려 있지 않으면 로그인 기능 자체가 깨진다.** |
| `sarahsEnglishStudents/{id}` | 교사(전원), 해당 학생 본인, 해당 학부모, `functions/index.js`(읽기 전용) | 교사(전 필드), 학생 본인(숙제 제출/시험 응시/스터디타이머/일부 스케줄), 학부모(상담 요청 append), `reading-library.html`(vocabTests append) | `id`가 "본인" 것인지 서버가 검증할 방법이 없다 — 클라이언트가 주장하는 `studentId`를 그대로 신뢰. |
| `sarahsEnglishWordbank/main` | `wordtest.html`(교사), `index.html` VocabEditor(교사), `reading-library.html`(교사 admin) | `wordtest.html`(교사), `reading-library.html`(교사 admin, `sendToWordbank`) | 학생용 페이지 없음 — 교사 전용 개념이지만 서버가 "교사임"을 검증하지 못함. |
| `passageArchive` | `passage-transform.html` 아카이브 뷰(교사) | `passage-transform.html` 저장(교사) | 교사 전용 개념. |
| `readingLibrary` | 모든 학생·방문자(리딩 콘텐츠는 열람이 목적) | 교사(`#admin` 모드 CRUD) | `#admin`은 URL 해시일 뿐, 접근 제어가 아니다. |
| `readingVocab/{studentId}` / `readingJournal/{studentId}` | 해당 학생 본인, 교사(admin 뷰) | 해당 학생 본인(단어 저장/독서기록 작성), 교사(선택 단어 wordbank 전송 시 읽기) | studentId 소유권 검증 없음. |
| `materialsLibrary` | 해당 학생 본인, 교사 | 교사(업로드/삭제) | `studentId` 필드로 필터링하지만 서버 검증 없음. |
| `sharedMaterialsLibrary` | 전원(공유 자료) | 교사 | 의도적으로 전원 공개. |
| `materialDownloadLog` | 교사(집계) | 모든 로그인 세션(다운로드 시 이벤트 기록) | 순수 로그, 학생 개인정보(이름) 포함. |

## 2. 현재 위험한 접근 (관찰된 사실 + 그로부터 필연적으로 따라오는 위험)

이 GitHub repo와 라이브 사이트(`https://cancho99.github.io/sarah-s-english/`)는 요청서 자체에 적힌 대로 공개돼 있다. `firebaseConfig`(프로젝트 id, API 키)는 4개 HTML 파일 소스에 그대로 인라인돼 있고, Firebase 웹 API 키는 애초에 "비밀"이 아니라 **Firestore 규칙만이 실질적인 접근 제어 수단**이다(CLAUDE.md에도 명시된 전제).

**§1의 표가 사실이라면(코드가 실제로 그렇게 동작하려면), 최소한 다음 접근이 지금 열려 있어야 한다:**
- `sarahsEnglishMeta/main` 전체 문서에 대한 **인증 없는 전체 읽기** — 학생 이름·생년월일·주소·학생/학부모 로그인 코드·교사 비밀번호(`teacherAuth.passcode`)·FCM 토큰이 전부 이 한 문서에 있다.
- `sarahsEnglishMeta/main`에 대한 **인증 없는 쓰기**(최소 레벨테스트·상담 예약 폼 제출 경로) — 로그인 자체가 없는 공개 폼이므로 구조적으로 피할 수 없다.
- `sarahsEnglishStudents/{id}` 각 문서에 대한, **`id`를 아는 누구나 읽기/쓰기 가능한** 접근 — 학생 ID는 `uid()`로 생성되지만 추측 난이도에 의존한 보안(security by obscurity)일 뿐, 규칙상 검증되는 소유권이 아니다.

**실제로 검증한 사실 (이번 세션 테스트 중 발견)**: `index.html`의 세션 복구 로직은 새로고침 시 `localStorage`의 `sarahsEnglishSession` 값만 보고 교사 화면으로 바로 들어간다(코드 주석에도 "Teacher role has no separate token to check... that's an accepted tradeoff" 라고 명시돼 있음, `index.html:192-194` 근방). Phase 1 백업 기능을 테스트하면서 실제로 `localStorage.setItem("sarahsEnglishSession", JSON.stringify({role:"teacher"}))` 한 줄만으로 **교사 비밀번호를 전혀 입력하지 않고** 실제 운영 데이터(로스터 8명, 학생 문서 9건)가 뜨는 교사 대시보드에 들어갈 수 있음을 확인했다. 이건 "브라우저에 저장된 내 세션을 복원하는 정상 동작"이지, Firestore 자체의 결함은 아니다 — 다만 **애플리케이션 레벨 권한 분리가 전적으로 클라이언트를 신뢰**하고 있다는 걸 구체적으로 보여주는 사례라서 기록해 둔다. Firestore 규칙이 열려 있다면(§1에 따르면 그래야 앱이 동작한다), 이 로그인 우회는 브라우저 UI 없이 Firestore API를 직접 호출해도 똑같이 가능하다는 뜻이다.

**요약**: 오늘 시점 이 앱의 실질적 보안 경계는 "Firestore 규칙"이 아니라 "아무도 API를 직접 두드릴 생각을 안 함"에 가깝다. 이건 배포 실수가 아니라 **애초에 Firebase Auth 없이 설계된 구조의 필연적 결과**다 — Phase 1에서 규칙을 함부로 조이면 로그인·예약폼·FCM 등록 등 기존 기능이 그대로 깨질 수 있어 손대지 말라고 한 사용자 지시가 정확히 맞는 판단이었다.

## 3~5. 역할별 권한 설계 (교사 / 학생 / 학부모) — 목표 모델, 미적용

진짜 역할 기반 규칙(교사만 전체 로스터 쓰기, 학생은 본인 문서만, 학부모는 본인 자녀 문서 읽기 전용 등)을 Firestore 규칙에서 강제하려면 **`request.auth`가 존재해야 한다** — 즉 지금 없는 인증 계층을 먼저 도입해야 한다는 뜻이다. 이건 로그인 플로우 자체를 바꾸는 구조 변경이라 "기존 기능 삭제 금지/기존 로그인 보존" 원칙과 정면으로 걸린다 — **그래서 이 문서는 목표 모델만 설계하고, 실제 도입은 별도의, 사용자가 명시적으로 승인하는 Phase로 분리할 것을 제안한다.**

### 목표 모델 (제안, 미구현)
1. **Firebase Anonymous Authentication**을 도입해 모든 방문자가 자동으로 `request.auth.uid`를 갖게 한다(로그인 UI/코드 입력 방식은 그대로 유지 — 화면상 아무것도 안 바뀜).
2. 클라이언트가 기존 방식대로 passcode/studentCode/parentCode를 입력하면, **새 Cloud Function 하나**가 그 코드를 서버에서 검증하고, 성공 시 해당 anonymous `uid`에 커스텀 클레임(`role: "teacher"|"student"|"parent"`, `studentId`)을 부여한다(Firebase Admin SDK `setCustomUserClaims`).
3. Firestore 규칙은 그 커스텀 클레임을 기준으로 판단한다:
   ```
   allow read: if request.auth.token.role == "teacher"
            || (request.auth.token.role in ["student","parent"] && request.auth.token.studentId == studentId);
   ```
4. `sarahsEnglishMeta/main`은 "로그인 코드 대조"에 필요한 최소 필드(코드 자체, 이름)만 별도의 작은 공개 문서로 분리하는 것까지 고려할 수 있으나, 이건 스키마 변경이라 **더 나중 단계**로 미룬다.

이 목표 모델은 **적용 시점에 로그인 플로우를 실제로 바꾸는** 작업이므로, 별도 Phase로 사용자 승인을 받은 뒤 진행해야 한다. 이번 Phase 1에서는 설계만 남겨둔다.

### 역할별 필요 권한 요약 (위 목표 모델 기준)

| | 교사 | 학생 | 학부모 |
|---|---|---|---|
| `sarahsEnglishMeta/main` 읽기 | 전체 | 코드 검증용 최소 필드만(향후 분리 시) | 코드 검증용 최소 필드만 |
| `sarahsEnglishMeta/main` 쓰기 | 전체 | FCM 토큰 필드만 | FCM 토큰 필드만 |
| `sarahsEnglishStudents/{id}` 읽기 | 전체 학생 | 본인 문서만 | 본인 자녀 문서만 |
| `sarahsEnglishStudents/{id}` 쓰기 | 전체 필드 | 제한된 필드(`homework[].photos`/`done`, `vocabResults`/`examResults`/`mockExamResults` append, `studyLog`, 본인 `consultRequests`는 학부모 몫) | `consultRequests` append만 |
| `readingVocab`/`readingJournal` | 전체(admin) | 본인 문서만 | 읽기만(선택) |
| `materialsLibrary` | 전체 | 본인 자료만 읽기 | 본인 자녀 자료만 읽기 |
| `sharedMaterialsLibrary` | 쓰기 | 읽기 | 읽기 |

## 6. 신규 추가될 Question Bank 권한 (`grammarQuestions`/`readingQuestions`/`originalQuestions`, ARCHITECTURE.md §8)

이 컬렉션들은 **학생 개인정보가 없는 콘텐츠 데이터**라 학생/학부모 노출 위험은 낮지만, 대신 "교사가 공들여 만든 문제 자산을 아무나 통째로 긁어갈 수 있는가"가 핵심 위험이다.

- 읽기: 시험 출제(Exam Studio)에 실제로 사용될 때만 필요 — 즉 **문제 원문(`question`/`answer`/`explanation`)을 학생 클라이언트가 직접 읽을 필요는 원래 없어야 한다.** 학생은 "출제된 시험" 문서(정답 제외 버전)만 봐야지, 문제은행 컬렉션 자체를 읽을 이유가 없다. 목표 규칙: `grammarQuestions`/`readingQuestions`/`originalQuestions`는 **교사만 읽기/쓰기**, 학생/학부모는 접근 불가.
- `originalQuestions`의 `status`(AI_DRAFT~PUBLISHED, 요청서 §17)에 따라 교사 내부에서도 "누가 승인 전 문항을 볼 수 있는가"는 현재 요청서상 단일 교사 계정 체제라 구분 실익이 없다 — 향후 교사 계정이 여러 명이 되면 재검토.
- 시험 문항이 실제로 학생에게 노출되는 경로는 "출제된 시험" 자체(기존 `examTests`/`mockExams` 패턴과 동일하게 정답 분리 여부를 그 시점에 설계)이지 문제은행 컬렉션이 아니어야 한다 — Exam Studio(Phase 8) 설계 시 이 경계를 지키는 것을 권고.

## 7. Exam 권한 (`examTests`/`mockExams`/`regularExams`, 기존 + Exam Studio 확장분)

이미 학생 문서 하위 필드라 §3~5의 학생 문서 규칙을 그대로 따른다. 추가로 짚어둘 것:
- **정답(`answer`/`answerKey`)은 학생이 응시 중일 때 클라이언트에 이미 그대로 내려가 있다** (오늘 코드 구조상 `TestTaker`/`MockExamTaker`가 정답 포함 객체를 통째로 받아 클라이언트에서 채점하기 때문 — `gradeMockAnswers` 등이 브라우저에서 실행됨). 이건 Firestore 규칙으로 해결될 문제가 아니라 **채점 로직이 서버에 없다는 아키텍처 특성**이다. 마음만 먹으면 학생이 개발자 도구로 응시 중인 시험의 정답을 미리 볼 수 있다 — 지금 규모(개인 과외)에서는 실질적 위험이 낮다고 판단되지만, Exam Studio를 정식 "은행" 체제로 키운다면 채점을 Cloud Function으로 옮기는 걸 §6과 함께 재검토할 가치가 있다(이번 Phase 범위 밖, 제안만).
- `examKeyLibrary`(정답표 라이브러리)는 `sarahsEnglishMeta/main`에 있어 교사 전용으로 분리하기 쉽다 — §3의 메타 문서 분리 시 함께 고려.

## 8. Report 권한 (`dailyReports`/`monthlyReports`, Daily/Monthly Report)

- 이미 `published: bool` 플래그로 "학부모에게 보이는 것"과 "교사가 작성 중인 초안"을 구분하고 있다(`ParentDash`가 `r.published` 필터링, `index.html:9391,9452`) — **이건 현재 순수 클라이언트 필터링**이다. 학부모 세션이 Firestore를 직접 두드리면 `published:false`인 초안도 그대로 읽힌다.
- 목표 모델(§3~5) 적용 시: 규칙에서도 `published == true`를 학부모 read 조건에 넣어 클라이언트 필터링과 이중으로 강제하는 것을 권고 — UI만 믿지 않는다.
- `tuitionRecords`도 동일한 `published` 패턴을 쓴다(ARCHITECTURE.md §2.8) — 같은 원칙 적용.

## 9. 이번 문서에서 하지 않은 것

- 실제 `firestore.rules` 파일 작성/배포 — 하지 않음.
- 현재 Console에 있는 실제 규칙 조회/변경 — 하지 않음(위 §0 참고, CLI로 조회 불가했고 더 침투적인 방법은 시도하지 않음).
- Firebase Anonymous Auth 도입, 로그인 플로우 변경 — 설계만 하고 미구현.

## 10. 다음 결정이 필요한 지점

1. 현재 Console의 실제 규칙 전문을 공유해 주시면 이 문서를 그것과 대조해 갱신한다.
2. ~~§3의 "목표 모델"(Anonymous Auth + 커스텀 클레임)을 별도 Phase로 승인할지~~ — **결정됨(2026-08-24): 별도 Security/Auth Phase로 분리, 지금은 보류.** 아래 §11 참고.
3. §6/§7에서 제안한 "문제은행은 학생이 직접 못 읽는다", "채점을 서버로 옮긴다"는 설계 방향에 동의하는지 — Exam Studio(Phase 8)/Question Bank(Phase 5-6) 착수 전에 정해두면 나중에 다시 설계를 뒤집을 필요가 없다. (착수는 보류, 방향성 검토만 계속 열어둠.)

## 11. Security/Auth Phase — 향후 별도 Phase에서 처리할 항목 (지금은 착수하지 않음)

Phase 2(Teacher Center + Homework) 착수 전, 사용자가 아래 항목 전부를 이번 재구조화 트랙과 분리된 **별도 Security/Auth Phase**로 명시적으로 미뤘다. 현재 로그인/권한 구조가 실서비스 중이라 잘못 건드리면 교사/학생/학부모 로그인이 그대로 깨질 수 있다는 게 이유다. 이 Phase가 시작되기 전까지 아래 항목은 어떤 형태로도 구현하지 않는다:

- Firebase Anonymous Authentication 도입
- Custom Claims(`role`/`studentId`) 도입 및 이를 검증하는 신규 Cloud Function
- 로그인 플로우 변경(현재의 passcode/studentCode/parentCode 문자열 비교 방식 자체는 유지)
- 기존 auth 구조(현재는 auth가 아예 없는 구조) 변경
- 실제 `firestore.rules` 작성/배포
- 시험 정답의 서버 측 채점/검증 구조로의 전환 (§7)

이 항목들의 설계 초안은 §3~8에 이미 있다 — Security/Auth Phase가 열리면 그 시점의 실제 코드 상태와 다시 대조해 갱신한 뒤 진행한다.
