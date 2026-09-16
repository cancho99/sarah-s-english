// Sarah's English — PWA 오프라인 캐싱 서비스워커. (최초 도입 2026-09-16)
//
// FCM(2026-09-16 병합) — 이 사이트는 원래 별도 파일 firebase-messaging-sw.js를 스코프 "/"에
// 등록해 백그라운드 푸시 알림을 처리했다. 서비스워커 스펙상 같은 스코프엔 한 번에 하나의
// 스크립트만 컨트롤할 수 있어서(나중에 register()한 scriptURL이 그 스코프를 그대로 가져감),
// 이 PWA 캐싱용 service-worker.js를 똑같이 스코프 "/"에 등록하면 firebase-messaging-sw.js가
// 밀려나 백그라운드 알림이 조용히 멈춘다 — 그래서 Firebase가 권장하는 방식대로 FCM 로직을 이
// 파일 안으로 합쳤다(index.html의 enableNotifications()도 이제 이 파일 하나만 등록한다).
// firebase-messaging-sw.js 파일 자체는 혹시 모를 이전 방문자의 과도기적 상태를 위해 저장소에
// 그대로 남겨두지만, 이 커밋 이후로는 어디서도 register()하지 않는다.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyAj45YlZPyJmsDha4p9rqFSjQUdnHeg-PU",
  authDomain: "sarah-s-english.firebaseapp.com",
  projectId: "sarah-s-english",
  storageBucket: "sarah-s-english.firebasestorage.app",
  messagingSenderId: "444699532890",
  appId: "1:444699532890:web:44084cd90d0aa0b5ca0263",
});
// data-only 메시지라(notifyTeacher/homeworkReminderCheck 등, functions/index.js) 브라우저가
// 알아서 알림을 띄우지 않는다 — 이 핸들러가 실제로 띄우는 부분. foreground 알림(index.html의
// onMessage)과 로직을 맞춰서 포그라운드/백그라운드 어느 쪽이든 같은 방식으로 보이게 한다.
firebase.messaging().onBackgroundMessage((payload) => {
  const { title, body } = payload.data || {};
  self.registration.showNotification(title || "Sarah's English", { body: body || "" });
});
//
// 전략: "네트워크 우선, 실패(오프라인) 시에만 캐시" — 온라인일 때는 항상 실제 네트워크
// 응답을 그대로 쓰고(항상 최신 버전), 그 응답을 runtime 캐시에 옆에서 저장만 해 둔다.
// 네트워크 요청 자체가 실패할 때(오프라인)만 캐시에서 꺼내 보여준다. 그래서 이 사이트처럼
// 자주 업데이트되는 학생 포털이 오래된 캐시를 계속 보여주는 일이 없다.
//
// 캐시 버전 관리: 배포마다 이 파일의 버전 문자열을 손으로 올리는 대신, PRECACHE_URLS 각
// 파일의 HEAD 응답 헤더(ETag/Last-Modified/Content-Length)를 모아 SHA-256으로 해시한 값을
// 캐시 이름에 쓴다(sarahs-english-precache-<해시>). 파일 내용이 하나도 안 바뀌면 이 값들도
// 그대로라 해시가 같고 캐시를 새로 만들지 않으며, 뭐라도 바뀌면(내용이 바뀌면 서버가 돌려주는
// ETag/Last-Modified/크기 중 최소 하나는 반드시 바뀐다) 해시가 달라져 새 캐시가 만들어지고
// activate 시점에 예전 해시의 캐시는 자동 정리된다 — service-worker.js를 열어 버전 숫자를
// 손으로 고칠 필요가 없다. 파일 본문 전체를 두 번(해시용 + 캐싱용) 받는 대신 가벼운 HEAD
// 요청만으로 버전을 정하므로, index.html처럼 큰 파일이 있어도 install/activate가 느려지지
// 않는다.
//
// 이 파일이 새로 배포돼도(바이트가 달라져야) 브라우저가 그걸 알아채고 install을 다시
// 돌린다는 점에 유의: index.html만 바뀌고 이 파일은 그대로면 install은 재실행되지 않지만,
// 그래도 온라인 상태의 학생/교사가 접속할 때마다 network-first가 매번 최신 index.html을
// 그대로 보여주고 runtime 캐시도 그 자리에서 최신 내용으로 덮어써지므로, 다음번 오프라인
// 접속 때도 결국 최신 버전이 캐시에서 나온다 — "온라인일 때 늘 최신"이라는 요구사항은
// install 재실행 여부와 무관하게 항상 성립한다.

const CACHE_PREFIX = "sarahs-english-";
const PRECACHE_PREFIX = CACHE_PREFIX + "precache-";
const RUNTIME_CACHE_NAME = CACHE_PREFIX + "runtime";

// 오프라인에서도 사이트가 최소한 뜨는 데 필요한 이 저장소 소유의 정적 자산들. 새
// services/*.js 파일을 추가했다면(= index.html 등에 <script src="services/...">를 새로
// 추가했다면) 여기에도 한 줄 추가해야 오프라인 프리캐시 대상에 포함된다 — 자동으로 잡히지
// 않는다(2026-09-16 기준 4개 HTML 진입점이 실제로 참조하는 services/*.js 전체를 반영함).
const PRECACHE_URLS = [
  "index.html",
  "wordtest.html",
  "passage-transform.html",
  "reading-library.html",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "services/aiService.js",
  "services/backupService.js",
  "services/customVocabService.js",
  "services/examAssignmentService.js",
  "services/examAttemptService.js",
  "services/examPaperService.js",
  "services/examService.js",
  "services/examStudioService.js",
  "services/firebaseClient.js",
  "services/flashcardService.js",
  "services/homeworkService.js",
  "services/questionBankService.js",
  "services/questionGenerationService.js",
  "services/readingAnalysisService.js",
  "services/readingService.js",
  "services/reportService.js",
  "services/revenueService.js",
  "services/roadmapService.js",
  "services/studentAnalysisService.js",
  "services/studentService.js",
  "services/vocabReviewService.js",
  "services/vocabTestService.js",
  "services/vocabularyService.js",
];

// Firestore 실시간 리스너/Auth/Cloud Functions/번역 API 등은 이 서비스워커가 절대 가로채지
// 않는다 — gRPC-Web 스트림이나 실시간 리스너를 fetch 캐싱 로직에 태우면 예측 못 할 방식으로
// 깨질 수 있고, 애초에 이 값들은 캐싱 대상도 아니다(Firestore 자체 오프라인 캐시는
// persistentLocalCache가 별도로 담당한다).
const EXCLUDE_HOSTS = [
  "firestore.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "www.googleapis.com",
  "translate.googleapis.com",
  "cloudfunctions.net",
  "firebasestorage.googleapis.com",
  "firebaseio.com",
];

async function computePrecacheVersion() {
  const parts = await Promise.all(
    PRECACHE_URLS.map((url) =>
      fetch(url, { method: "HEAD", cache: "reload" })
        .then((res) => [
          url,
          res.headers.get("etag") || "",
          res.headers.get("last-modified") || "",
          res.headers.get("content-length") || "",
        ].join("|"))
        // 파일 하나가 일시적으로 안 받아져도 버전 계산 전체를 막지 않는다 — 그 상태(url이
        // "unavailable"과 짝지어짐) 자체가 해시에 반영되므로, 다음번엔 그 파일이 정상
        // 응답하기만 해도 자동으로 새 버전이 된다.
        .catch(() => `${url}|unavailable`)
    )
  );
  const digestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return Array.from(new Uint8Array(digestBuf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

self.addEventListener("install", (event) => {
  // 업데이트된 서비스워커가 기존 탭들이 다 닫히길 기다리지 않고 바로 활성화되게 한다 —
  // 자주 바뀌는 학생 포털이라 새 버전이 최대한 빨리 적용돼야 한다.
  self.skipWaiting();
  event.waitUntil((async () => {
    const version = await computePrecacheVersion();
    const cacheName = PRECACHE_PREFIX + version;
    const cache = await caches.open(cacheName);
    await Promise.all(
      PRECACHE_URLS.map((url) =>
        fetch(url, { cache: "reload" })
          .then((res) => {
            if (res && (res.ok || res.type === "opaque")) return cache.put(url, res);
          })
          .catch(() => {})
      )
    );
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const version = await computePrecacheVersion();
    const currentPrecacheName = PRECACHE_PREFIX + version;
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith(PRECACHE_PREFIX) && n !== currentPrecacheName)
        .map((n) => caches.delete(n))
    );
    // RUNTIME_CACHE_NAME은 이름이 고정이라 여기서 지우지 않는다 — network-first가 매번 최신
    // 응답으로 덮어쓰므로 스스로 계속 신선해진다.
  })());
});

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && (fresh.status === 200 || fresh.type === "opaque")) {
      const cache = await caches.open(RUNTIME_CACHE_NAME);
      cache.put(request, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (networkErr) {
    const runtimeMatch = await caches.match(request, { cacheName: RUNTIME_CACHE_NAME });
    if (runtimeMatch) return runtimeMatch;
    const anyMatch = await caches.match(request);
    if (anyMatch) return anyMatch;
    // 페이지 이동(주소 직접 입력, 새로고침 등)인데 캐시에도 없으면 최소한 앱 셸(index.html)로
    // 대신 응답해서 완전히 새하얀 브라우저 기본 오프라인 에러 화면 대신 앱이 뜨게 한다.
    if (request.mode === "navigate") {
      const shell = await caches.match("index.html");
      if (shell) return shell;
    }
    throw networkErr;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (EXCLUDE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h))) return;

  event.respondWith(networkFirst(req));
});
