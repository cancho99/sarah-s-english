// 2026-10 — 리딩 라이브러리 제거. 이 파일은 원래 그 라이브러리가 쓰던 Firestore 컬렉션들(단어장/독서기록/
// 활동 기록/스토리)을 index.html의 리포트·대시보드로 읽어오는 읽기 전용 계층이었고, 함수 전부(월간/일간
// 집계, Growth Report, 무결성 신호 등)가 그 컬렉션 전용이라 지울 것만 남았다. 문제은행/지문 분석용
// 컬렉션(readingQuestions/readingPassages/readingAnalyses/readingAnalysisQuestions)과는 무관하다 —
// 그쪽은 questionBankService.js / readingAnalysisService.js가 그대로 담당한다.
//
// 파일 자체는 지시에 따라 지우지 않고 빈 서비스 객체만 남겨둔다(index.html이 <script>로 로드한다).
// 더 쓰는 곳이 없으면 이 파일과 index.html의 <script src="services/readingService.js"> 줄을 함께 삭제해도 된다.
window.SarahServices = window.SarahServices || {};
window.SarahServices.readingService = {};
