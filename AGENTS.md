# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A small English-tutoring academy's ("Sarah's English") management site: four standalone, static HTML files with no build step, no package.json, and no test suite. Each file is a complete self-contained app (inline `<style>`, inline `<script>`) that pulls its runtime libraries from CDNs and talks directly to Firebase Firestore from the browser. Server-side code lives in `functions/index.js` (Firebase Cloud Functions, Node 20) — see "AI backend" below; this is a **correction** to an earlier version of this doc that said all AI generation happened in an external, out-of-repo Cloudflare Worker. That is no longer accurate (if it ever fully was) — `WORKER_URL`/`NELT_WORKER_URL` in the frontend point at `https://us-central1-sarah-s-english.cloudfunctions.net/aiWorker`, i.e. the `aiWorker` function in this repo's `functions/index.js`, not a Cloudflare Worker. See `ARCHITECTURE.md` for the full audit this correction is based on.

- `index.html` — the main app: teacher/student/parent portal (roster, homework, feedback, vocab/exam tests, NELT report parsing, level-test bookings, PDF report generation). Built with React 18 (UMD build) + `htm` (no JSX, no bundler — components are written with tagged-template `html\`...\`` calls bound via `htm.bind(React.createElement)`).
- `wordtest.html` — vocabulary test-sheet generator/manager (per-textbook, per-Day word lists → printable test + answer key). Plain JS + DOM, no React.
- `passage-transform.html` — passage analysis / exam-question generator and a saved-item archive. Plain JS + DOM, no React. Calls the `aiWorker` Cloud Function (see below) for the actual AI generation.
- `reading-library.html` — English story/novel reading library (초3~고3, Level 1-10, hardcoded curriculum in `LEVELS`/`GRADE_BY_LEVEL`) with per-student personal vocab lookup and a level-tiered post-reading "독서 기록" journal. Plain JS + DOM, no React. **This file was missing from earlier versions of this doc** despite being a core, heavily-used page — don't assume the file list above is exhaustive without checking the repo root.

`wordtest.html`, `passage-transform.html`, and `reading-library.html` are embedded inside `index.html` via `<iframe src="wordtest.html">` / `<iframe src="passage-transform.html">` / `<iframe src="reading-library.html#admin">` (see `WordbankSection`, `PassageToolSection`, `ArchiveSection`, `ReadingLibraryAdminSection` in `index.html`) — they also work standalone (`reading-library.html` is additionally linked to directly, not iframed, from the student home screen via `reading-library.html?student=<id>`). All four share the same Firebase project, so data written from one place appears in the others. There is **no `postMessage`/`contentWindow` communication** between parent and iframe anywhere in the codebase — coordination is entirely via shared Firestore state plus a URL hash (`#admin`, `#archive`) read by the embedded page on load to pick its initial mode.

### AI backend (`functions/index.js`)
Firebase Cloud Functions v2, Node 20, region `us-central1`. The single `aiWorker` HTTPS function (`onRequest`, secret `ANTHROPIC_API_KEY`) multiplexes 6 modes via `req.body.mode`, calling `https://api.anthropic.com/v1/messages` directly with raw `fetch` (no SDK): default/no-mode (지문 → 문제 생성), `transform` (지문 변형), `monthlyReport` (월간 리포트 초안), `examkey` (정답표 PDF의 AI-비전 파싱— the local geometric text-column parser mentioned in older versions of this doc, `extractPdfTextForKeys`/`parseExamKeyPdfText`, **no longer exists**; masonry-style 유형별/단원별 answer-sheet layouts broke column clustering, so this was replaced with AI vision reading entirely), `examVariant` (오답노트 AI 변형 문제 생성), `nelt` (NELT 성적표 PDF 파싱). `aiWorker` never touches Firestore — it's a stateless proxy; callers persist results themselves. The same file also exports `notifyTeacher`/`notifyStudent`/`sendTestNotification` (FCM push, data-only messages) and two scheduled functions (`homeworkReminderCheck` hourly 15–23 KST, `vocabRetestReminderCheck` every minute) that read (never write) `sarahsEnglishMeta/main` and `sarahsEnglishStudents/*`. No `@anthropic-ai/sdk` dependency — see `functions/package.json`.

### No Firebase Authentication
None of the four HTML files, and none of `functions/index.js`, use Firebase Auth (`getAuth`/`signInAnonymously`/`onAuthStateChanged` — all absent, confirmed by full-repo grep). Teacher/student/parent "login" is a client-side string comparison against `teacherAuth.passcode` / `roster[].studentCode` / `roster[].parentCode` fields read out of `sarahsEnglishMeta/main` — which means that document's roster (names, codes, birthdates, addresses) must be openly readable by an unauthenticated client for login to work at all. Keep this in mind before assuming `request.auth` can gate anything in Firestore rules — see `FIRESTORE_SECURITY_PLAN.md` for the fuller analysis. No `firestore.rules` file exists in this repo; whatever rules are live are Console-managed and not visible here.

## Running / developing

There is no build step. To work on this locally, serve the directory over HTTP (not `file://`, since ES module `<script type="module">` imports and `fetch` need a real origin) e.g.:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/index.html
```

There is no lint or test command configured — verify changes by loading the page in a browser and exercising the relevant flow (see the "UI or frontend changes" testing expectation in your general instructions).

## Architecture notes

### Data storage (Firestore, no backend)
All four pages initialize their own Firebase app inline (same `firebaseConfig`, hardcoded — the API key is public-by-design for Firebase web apps restricted by security rules, not a secret to strip). **There are 10 collections, not 4** — an earlier version of this doc listed only the ones `index.html` and `wordtest.html`/`passage-transform.html` own; `reading-library.html` and index.html's materials-library feature own the rest. Full field-level schemas for all of these are in `ARCHITECTURE.md` §2 — treat that as the authoritative schema reference, not `emptyData()` alone (see below).

- `sarahsEnglishMeta/main` — one small "meta" doc: `roster`, `teacherAuth` (passcode), `levelTestBookings`, `announcement`, `examKeyLibrary`, plus `teacherTodos`/`sharedDriveFolderLink`/`teacherFcmTokens` (not covered by `saveMeta()`'s merge write — see below). Loaded/saved via `loadStore()` / `saveMeta()` in `index.html`.
- `sarahsEnglishStudents/<studentId>` — one doc **per student**, containing that student's `logs/homework/vocabTests/examTests/...` (see `emptyData()` in `index.html`, but **that literal is stale**: `hourlyRate`, `sessionHours`, `activeTestSession`, `studyLog`, `neltResults`, `attendance`, `monthlyReports`, `monthlyStats` are all real, actively-used fields absent from `emptyData()`, relying on `data.field || default` fallback patterns wherever they're read. Conversely `scores`/`feedback` are declared in `emptyData()` but dead — nothing writes them.). Deliberately split out per-student (rather than nested under the meta doc) to stay well under Firestore's 1MB-per-document cap and so one student's data can never corrupt another's.
- `sarahsEnglishWordbank/main` — one doc for all vocab textbooks/day-word-lists, owned by `wordtest.html`, with a one-time migration path from an older localStorage format. Also **read directly by `index.html`'s `VocabEditor`** (vocab-test import) and **written directly by `reading-library.html`'s `sendToWordbank()`** (pushing selected reading-vocab into a per-student book) — both bypass their own file's normal Firestore-access pattern and hardcode this collection's `books/days/day1/{en,ko}` shape with no shared code, so a shape change in `wordtest.html` can silently break either.
- `passageArchive` — one doc per saved passage-tool result (`passage-transform.html`), not touched by any other file.
- `readingLibrary` — one doc per reading-library story (`reading-library.html`, owner). Level 1-10 / 초3~고3 curriculum mapping is JS-hardcoded (`LEVELS`/`GRADE_BY_LEVEL`), not data-driven or validated against a story's `level` field.
- `readingVocab/<studentId>` / `readingJournal/<studentId>` — per-student personal vocab lookups / post-reading journal entries, both owned by `reading-library.html`. **`index.html` never reads either** — reading activity is invisible to the Teacher/Student/Parent dashboards today.
- `materialsLibrary` / `sharedMaterialsLibrary` / `materialDownloadLog` — `index.html`'s 자료실 feature (per-student personal files / all-student shared files / download-event log), kept as separate collections specifically to keep large base64 file blobs out of the 1MB-capped meta/student docs. Accessed via module-level helper functions in `index.html`, **not** through `App()`'s `loadStore`/`saveMeta`/`ensureData`/`updateData` — i.e. roughly a third of this app's Firestore collections bypass the "central data layer," despite that being the dominant pattern for the other two.

Student-doc writes in `index.html` go through `updateData()`, which wraps the read-modify-write in a Firestore `runTransaction` — this is what actually prevents data loss from near-simultaneous writes (e.g. two photos taken back to back, or teacher + student editing at once); a client-side cache alone can't protect against another tab/device writing in between.

### The 1MB-per-student-document limit
Because photos/audio are stored inline as data URLs inside the student doc, staying under Firestore's 1MB cap is an active concern, not just a comment:
- `compressImage()` downscales/re-encodes images before storage; uploads target a byte budget (see `BUDGET` in the homework-photo upload path).
- `isDocSizeError()` detects the Firestore size-limit error; `shrinkStudentData()` / `attemptAutoShrinkAndRetry()` drop older large fields (e.g. legacy inline photos) and retry the write automatically.
- `StorageCleanupPanel` (teacher-facing) shows current per-student doc size (`LIMIT_KB`) so the teacher can manually clean up before hitting the cap.
Keep this in mind before adding any new field that stores binary/base64 data per student.

### `index.html` structure (React, no JSX)
- UI is built with `htm` tagged templates, not JSX — component bodies look like `` html`<div>...</div>` ``. There's no transpile step, so this is genuinely what ships to the browser.
- Reusable primitives are defined once near the top: `Card`, `Button`, `Field`, `Tabs`, `SideNav`, `Shell`, `Empty`, `Modal`, `TopBar`, `SectionLabel`. Reuse these instead of hand-rolling new styled elements.
- `App()` (`index.html:1294-1517`) owns all top-level state (`roster`, `teacherAuth`, `levelTestBookings`, `announcement`, `examKeyLibrary`, `teacherTodos`, `sharedDriveFolderLink`, `session`, `dataCache`, `selectedStudentId`, `screen`) and is the only place that talks to `loadStore`/`saveMeta`/`ensureData`/`updateData` for the `sarahsEnglishMeta`/`sarahsEnglishStudents` collections (other collections are accessed directly by leaf components — see "Data storage" above). Screens are switched via a `screen` string state (`"home"`, `"teacherDash"`, `"studentDash"`, etc.), not a router — and `TeacherDash`/`StudentDash`/`ParentDash` each additionally own their own second-level `section`/`tab` state, so navigation is really 4 independent, uncoordinated state machines, none of them URL-addressable (no deep links, no back-button support).
- Three parallel dashboards branch off `session.role`: `TeacherDash` (roster + per-student editing panels), `StudentDash`, `ParentDash` — parent view is intentionally read-mostly/narrower than the student view over the same data.
- The responsive admin shell (dark icon sidebar on desktop → "more" dropdown on mobile) is pure CSS driven by the `.ap-*` classes at the top of the file plus the `@media (max-width: 760px)` block; `SideNav`/`Shell` render both variants unconditionally and CSS hides the wrong one — don't try to conditionally render based on viewport in JS.
- `NELT_WORKER_URL` and the passage-tool's `WORKER_URL` (in `passage-transform.html`) both point at the same URL — `https://us-central1-sarah-s-english.cloudfunctions.net/aiWorker`, i.e. the `aiWorker` Cloud Function in this repo's `functions/index.js`, **not** a Cloudflare Worker (see "AI backend" above; corrected 2026-08-24).
- Offline synonym matching (`SYNONYM_GROUPS` / `SYNONYM_LOOKUP` / `isKnownSynonym`) and vocab-answer matching (`checkVocabAnswer`, `checkWordAnswer`) exist so student free-text answers are graded leniently without calling any external API — coverage is intentionally limited to common middle/high-school/TOEFL vocabulary, not a full thesaurus.
- Exam-key PDF parsing (`ExamKeyLibrarySection.parseExamKeyPdfWithAI()`) renders the PDF to page-tile images client-side and sends them to the `aiWorker`'s `examkey` mode — this **replaced** an earlier local geometric text-column parser (`extractPdfTextForKeys`/`parseExamKeyPdfText`, referenced in older versions of this doc but **no longer present in the code**), which broke on masonry-style 유형별/단원별 answer-sheet layouts.

### `reading-library.html` (undocumented until 2026-08-24 — read this before touching the file)
- Plain DOM/vanilla-JS like `wordtest.html`/`passage-transform.html` — no React. Owns three of its own collections (`readingLibrary`, `readingVocab/<id>`, `readingJournal/<id>`, see above) and also writes into `sarahsEnglishWordbank/main` and (via a transaction matching `index.html`'s own pattern) `sarahsEnglishStudents/<id>.vocabTests[]` — the only file besides `index.html` that writes to the student-doc collection.
- Uses `location.hash === "#admin"` to gate teacher-only panels (story CRUD, per-student vocab/journal viewers) — same hash-routing idiom `passage-transform.html` independently reimplements for `#archive`; no shared code between the two.
- Word-click-to-translate uses the free/undocumented public Google Translate endpoint (`translate.googleapis.com/translate_a/single`) with no fallback provider — if Google changes or blocks it, the "click a word for a Korean gloss" feature silently stops working.
- Level 1-10 / 초3~고3 curriculum (`LEVELS`, `GRADE_BY_LEVEL`) is hardcoded JS, not enforced against story data.

### `wordtest.html` and `passage-transform.html`
- Both are plain DOM/vanilla-JS, event-listener-wired (no framework). Keep new UI in that style rather than introducing React here — these files intentionally stay framework-free and are also loaded standalone.
- `wordtest.html` supports importing word lists from PDF and DOCX (`extractPdfText`/`splitTextByDay`/`extractEnKoPairs`, `extractDocxByDay`) by locating "Day N" markers and Korean-character boundaries respectively; both are heuristic text-layout parsers, not a real PDF/DOCX schema reader.
- `passage-transform.html`'s print flow, `wordtest.html`'s `printSheet()`, and `index.html`'s own two report-printing call sites (`MonthlyReportView.printReport()`, `TuitionEditor`'s invoice print) all independently open a **new top-level window** and print from there instead of calling `window.print()` in place — needed because these pages are frequently loaded inside an `<iframe>` (embedded in `index.html`), and iframe-context printing doesn't trigger the native print dialog on mobile Safari. These are four separate copy-pasted implementations of varying robustness (`wordtest.html`'s has the best popup-blocked/timing fallback handling) — a real extraction candidate, not yet extracted.

## Project reconstruction (in progress, started 2026-08-24)

This repo is mid-way through a large, explicitly phased reconstruction into a fuller teaching-platform (Teacher OS / Student OS / Content OS / Exam Studio / Report Center / Business Management). See `ARCHITECTURE.md` (Phase 0 audit — current schema/features/problems + proposed target architecture) and `FIRESTORE_SECURITY_PLAN.md` (security analysis + design, rules not yet applied) for the living design docs. `handoff.md` (gitignored/private) tracks session-to-session progress within this effort.

**Non-negotiable principles for this work — apply to every phase, not just the first:**
- Never delete an existing feature. Preserve at minimum: 학생 관리, 숙제(등록/관리), 단어시험(생성/응시/채점), 모의고사(및 답안 입력/채점), 시험 정답표, Daily/Monthly Report, Reading Library, 로드맵, 학생 일정, 상담/메모, 공지/알림, AI 지문 변형/문제 생성, NELT 성적 분석, 매출/수업료 관리, existing login/passcode auth, Firebase/Firestore, FCM.
- Never delete or destructively alter existing Firebase data — no collection drops, no student-document deletes, no field removal on existing docs as part of a "cleanup."
- Preserve all existing student data, vocab-test data, mock-exam/answer-input data, Reading Library data, Daily/Monthly Report data, revenue/tuition data, and AI-feature behavior exactly as-is unless the user explicitly approves a change to that specific area.
- Take a backup/export before any migration that touches existing data shape. No backup, no migration.
- Build new functionality through a service layer (`services/`), not by writing more ad hoc Firestore calls directly into UI components — the current codebase already has this problem (see "roughly a third of collections bypass the central data layer" above); don't add to it.
- Migrate existing functionality to the new structure gradually through a compatibility/adapter layer that reads the current data shape as-is — don't do a big-bang schema migration in one step.
- Never rewrite the whole of `index.html` in one pass. It is a 9,600+ line file with no build step and no test suite — changes go in incrementally, verified in a real browser each time.
- Regression-test the existing feature list (see above) after every phase before moving to the next one. If something in that list breaks, that's a stop-the-line problem, not a note for later.
- When a new data field/shape is discovered that isn't in `ARCHITECTURE.md` (this happens — Phase 0's own audit missed `data.dailyReports` and `data.feedback`'s "written by nothing currently, but real historical data proves something once did" nuance, both found during later phases), the order is always **actual code → confirm the real schema → update `ARCHITECTURE.md`**, never the reverse. `ARCHITECTURE.md`/`FIRESTORE_SECURITY_PLAN.md`/this file describe the code; they are not a source of truth the code should be made to match. When a doc and the code disagree, the code is right and the doc gets fixed.

## API cost policy (non-negotiable, added 2026-08-24)

The goal is to keep AI API cost at effectively ₩0 for normal day-to-day operation of the site. Firebase is the expected cost center; Anthropic API calls are not.

**AI must never be called as part of ordinary feature behavior.** None of these may trigger an AI request: 학생 목록/상세, Homework(+Center), Daily/Monthly Report, Vocabulary Test, Mock Exam, Reading Library/Log/Analytics, Question Bank 조회, 검색, 필터, 정렬, 통계, 학생별 분석, 매출관리, Roadmap, Schedule, Teacher Dashboard. All of these are Firestore reads + plain JavaScript computation.

**AI runs only on an explicit user action** — a button the teacher deliberately clicks, e.g. `[AI로 문제 생성]`. Opening a page, selecting a student, opening the question bank, opening a report, searching, filtering, and saving must all cost ₩0. There is no "AI on load", no background pre-generation, no AI-assisted search ranking.

**Service-layer separation is how this is enforced structurally:**
- `services/questionBankService.js` — never calls an AI API. CRUD, taxonomy, status pipeline, versioning, dedup, and query all work with Anthropic entirely unreachable. (Verified: the only `fetch` token in that file is inside a comment.)
- `services/questionGenerationService.js` — the *only* place allowed to call an AI API for question generation. Keep it provider-agnostic (adapter shape) so Codex/Gemini/OpenAI/local model can be swapped without touching the bank.

The Question Bank must be fully usable with no AI at all: a teacher hand-enters 문제/보기/정답/해설/분류/난이도 and everything downstream (저장·검색·필터·수정·Archive·출제·통계) works. AI generation is additive, never a dependency.

**AI-generated questions are always saved as `DRAFT`** and go through Teacher Review → APPROVED → PUBLISHED. Never auto-publish AI output, and never throw a generated result away without persisting it (re-generating the same question costs money twice).

**Any button that spends money must say so in the UI** — e.g. "AI 사용 — API 비용 발생", ideally alongside the number of questions to be generated so the cost is predictable before the click.

**During development, do not call the real AI API to test.** Use mock responses or fixture data. Real API calls happen only when the user explicitly asks for one.

## Local files to be aware of

- `API KEY.rtf` exists in the working directory but is untracked (not committed, not gitignored) — don't add it to git.
