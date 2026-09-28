// "나의 단어장" 허브(2026-09-15) — 학생이 직접 만드는 커스텀 단어장(사진 OCR/직접 입력) +
// 선생님 등록 교재의 진행률(Day 완료 개수) 계산을 담당하는 순수 함수 모음. Firestore 접근
// 없음 — customVocabLists/<studentId> 문서(lists: [{id,name,words,source,createdAt,updatedAt}])
// 읽기/쓰기는 index.html이 firebaseClient.getDoc/setDocAt으로 직접 한다. OCR 자체(Tesseract.js
// 호출)도 이 파일이 아니라 index.html에서 한다 — 여기 있는 건 OCR 결과(텍스트 또는 TSV 좌표)를
// 단어/뜻 후보로 쪼개는 순수 파싱 로직뿐이다.
//
// 2026-09-22: 학생들이 실제로 쓰는 "단어 기록표"(단어/뜻/출처/복습체크 4칸 표, 손글씨)를 찍어
// 올리면 결과가 "이상하게" 나온다는 제보로 재작업됨 — 원인 둘: (1) 기존엔 Tesseract를
// "eng"(영어 전용)로만 돌려서 손글씨 한글 뜻이 거의 항상 빈칸/깨진 글자였다 → index.html이
// "eng+kor"로 호출하도록 변경(이 파일 무관). (2) 표의 칸 간격이 넓어서 Tesseract가 줄 단위가
// 아니라 칸(열) 단위로 텍스트를 읽어버리면, 기존 parseOcrText(한 줄 = "단어 뜻")가 완전히 다른
// 행끼리 단어/뜻을 잘못 묶었다 — wordtest.html의 PDF 표 파서(extractPdfText, 2026-09-20)와
// 같은 아이디어로, OCR 결과에서 단어별 좌표(TSV)를 받아 y좌표로 행을 다시 묶고 x좌표 간격으로
// 칸을 나눠 첫 번째 칸(단어)/두 번째 칸(뜻)만 취하고 그 뒤(출처/복습체크)는 버린다.
window.SarahServices = window.SarahServices || {};

(function () {
  function uidLocal() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // 표 헤더/라벨(단어(Word)/뜻(Meaning)/출처/복습체크/TIP 안내문 등)이 후보로 잘못 섞여 들어오는
  // 것을 거르는 필터 — 정확히 일치가 아니라 "포함"으로 판정한다(예: "단어(Word)"처럼 괄호가
  // 붙어 나올 수 있어서).
  const HEADER_NOISE_RE = /word|meaning|source|review|log|tip|단어|뜻\s*\(|출처|복습|체크|기록표|교재명|문제번호/i;
  // "1차○ 2차○ 3차○" 복습체크 칸 — 칸 구분이 완벽하지 않을 때 뜻 칸 끝에 붙어 들어오는 경우가
  // 있어 별도로 한 번 더 제거한다.
  const REVIEW_CHECK_RE = /[0-9]\s*차\s*[○◯OoＯ]?/g;

  function stripEdgePunct(s) {
    return (s || "").replace(/^[-–—:.\s]+|[-–—:.\s]+$/g, "").trim();
  }
  // 후보 하나를 최종 정리 — 알파벳이 하나도 없는 "단어"(출처/페이지번호 등이 잘못 걸린 경우)나
  // 표 헤더/복습체크 잔여물은 버린다. 두 파싱 경로(TSV 기반/텍스트 기반) 모두 이 필터를 거친다.
  function cleanCandidate(cand) {
    if (!cand) return null;
    let en = stripEdgePunct(cand.en);
    let ko = stripEdgePunct((cand.ko || "").replace(REVIEW_CHECK_RE, ""));
    if (!en || !/[A-Za-z]/.test(en)) return null;
    if (HEADER_NOISE_RE.test(en) || HEADER_NOISE_RE.test(ko)) return null;
    return { en, ko };
  }

  // ---- OCR 결과 텍스트 파싱(표가 아닌 단순 "단어  뜻" 목록용 — TSV 파싱이 실패했을 때 폴백) ----
  // 보통 "단어  뜻"(공백 여러 칸) 또는 "단어 - 뜻" 형태인 점을 이용하되, OCR은 공백을 안정적으로
  // 보존하지 못하는 경우가 많아 "영어 구간 뒤에 한글이 시작되는 지점"을 실제 경계로 삼는다 —
  // 인쇄 상태/기울기에 따라 깨질 수 있으므로 완벽함을 목표하지 않고, 학생이 화면에서 직접 고칠
  // 수 있는 "그럴듯한 초안"만 만든다.
  const HANGUL_RE = /[가-힣]/;

  // 2026-09-23 — 줄 맨 앞의 번호("01", "1.", "1)", "(1)")/체크박스·불릿 기호(□☐■○●✓ 등)를
  // 제거한다. 둘 중 어느 게 먼저 올지 몰라(예: "□ 1. apple" vs "1. □ apple") 안정될 때까지
  // 번갈아 반복 제거한다.
  const LEADING_MARK_RE = /^\s*[□☐■◻◼▢✓✔✅○●◯•▪▶➤※]+\s*/;
  const LEADING_NUMBER_RE = /^\s*(?:\(\d{1,3}\)|\d{1,3}[.)]?)\s+/;
  function stripLeadingNoise(line) {
    let s = String(line || "");
    let changed = true;
    while (changed) {
      changed = false;
      let next = s.replace(LEADING_MARK_RE, "");
      if (next !== s) { s = next; changed = true; continue; }
      next = s.replace(LEADING_NUMBER_RE, "");
      if (next !== s) { s = next; changed = true; }
    }
    return s;
  }

  // 한 줄 안에서 영어→한글 구간을 반복적으로 찾아 나눈다("영어 한글 영어 한글"처럼 2단 교재가
  // 한 줄에 두 단어를 나란히 인쇄한 경우도 이 규칙 하나로 자연스럽게 처리된다) — 첫 한글이
  // 시작되는 지점까지를 앞쪽 영어로, 그 뒤 다시 알파벳이 나타나는 지점까지를 한글로 삼고,
  // 다음 알파벳부터는 같은 규칙을 다시 적용한다. 한글을 더 못 찾으면 남은 텍스트 전체를
  // 마지막 조각의 en(한글 없음, 학생이 뜻을 채워야 함)으로 남긴다.
  function splitEnKoSegments(line) {
    const out = [];
    let rest = String(line || "").trim();
    let guard = 0;
    while (rest && guard < 20) {
      guard++;
      const hIdx = rest.search(HANGUL_RE);
      if (hIdx === -1) {
        out.push({ en: rest, ko: "" });
        break;
      }
      const enPart = rest.slice(0, hIdx);
      const afterHangul = rest.slice(hIdx);
      const nextLatinRel = afterHangul.search(/[A-Za-z]/);
      if (nextLatinRel === -1) {
        out.push({ en: enPart, ko: afterHangul });
        break;
      }
      out.push({ en: enPart, ko: afterHangul.slice(0, nextLatinRel) });
      rest = afterHangul.slice(nextLatinRel);
    }
    return out;
  }

  // 영어 끝/한글 앞에 붙은 품사 표시 제거 — 영어 약어(n. v. adj. adv. prep. conj. pron., 괄호나
  // 대괄호로 감싸인 경우 포함)와 한글 한 글자 품사 괄호((명)/(동)/(형)/(부))를 en/ko 양쪽에서
  // 다 검사한다(OCR이 어느 쪽에 붙여 인식했을지 모르므로).
  // 괄호/대괄호로 감쌌으면 마침표 없이("(v)")도 인정하고, 안 감쌌으면 마침표가 있을 때만("v.")
  // 잘라낸다 — 안 감싼 채 마침표도 없는 "v"/"n" 같은 한 글자만 보고 지우면 오탐 위험이 크다.
  const POS_EN_RE = /(?:[([]\s*(?:n|v|adj|adv|prep|conj|pron)\.?\s*[)\]]|\b(?:n|v|adj|adv|prep|conj|pron)\.)/gi;
  const POS_KO_RE = /[（(]\s*[명동형부]\s*[)）]/g;
  // 한 쌍(en/ko raw segment)을 정리 — 품사 표시 제거, 영어는 알파벳/공백/하이픈/아포스트로피
  // 외 잡문자 제거, 영어가 5단어를 넘으면(예문일 가능성) 통째로 버린다.
  function cleanEnKoPair(seg) {
    if (!seg) return null;
    let en = seg.en || "";
    let ko = seg.ko || "";
    en = en.replace(POS_EN_RE, " ").replace(POS_KO_RE, " ");
    ko = ko.replace(POS_EN_RE, " ").replace(POS_KO_RE, " ");
    en = en.replace(/[^A-Za-z\s\-']/g, " ").replace(/\s+/g, " ").trim();
    en = en.replace(/[-–—:.\s]+$/, "").replace(/^[-–—:.\s]+/, "").trim();
    ko = ko.replace(/[-–—:.\s]+$/, "").replace(/^[-–—:.\s]+/, "").trim();
    if (!en) return null;
    if (en.split(/\s+/).filter(Boolean).length > 5) return null; // 예문으로 추정 — 버림
    return { en, ko };
  }

  // rowToCandidate(TSV 파싱, 1칸짜리 행 폴백)가 계속 쓰는 단일 쌍 진입점 — 한 줄에서 첫 번째
  // en/ko 쌍만 돌려준다(기존 시그니처 유지).
  function splitWordMeaningLine(line) {
    const trimmed = stripLeadingNoise(String(line || "").trim());
    if (!trimmed) return null;
    const segments = splitEnKoSegments(trimmed);
    if (segments.length === 0) return null;
    return cleanEnKoPair(segments[0]);
  }
  function parseOcrText(rawText) {
    return (rawText || "")
      .split("\n")
      .flatMap((line) => {
        const stripped = stripLeadingNoise(line);
        if (!stripped.trim()) return [];
        return splitEnKoSegments(stripped).map(cleanEnKoPair);
      })
      .map(cleanCandidate)
      .filter(Boolean)
      .map((p) => ({ id: uidLocal(), en: p.en, ko: p.ko, checked: true }));
  }

  // ---- OCR 결과 TSV 파싱(표 형식 — 단어/뜻/출처/복습체크가 칸으로 나뉜 사진용) ----
  // Tesseract.js의 output:{tsv:true}가 돌려주는 tsv는 (`tesseract` CLI와 달리) 헤더 줄이 없고
  // 고정 12개 컬럼(level,page_num,block_num,par_num,line_num,word_num,left,top,width,height,
  // conf,text)이 항상 이 순서로 나온다 — 실제 Tesseract.js(브라우저, eng+kor)로 직접 돌려서
  // 확인한 값(2026-09-22, 헤더 줄 없이 데이터가 1행부터 바로 시작함). level===5(단어 단위)인
  // 행만 좌표(left/top/width/height)와 함께 뽑는다.
  const TSV_COL = {
    level: 0, left: 6, top: 7, width: 8, height: 9, text: 11,
  };
  function parseTsvWords(tsvText) {
    const lines = (tsvText || "").split("\n").filter((l) => l.trim());
    const words = [];
    for (const line of lines) {
      const cols = line.split("\t");
      if (cols.length < 12) continue;
      if (Number(cols[TSV_COL.level]) !== 5) continue;
      const text = (cols[TSV_COL.text] || "").trim();
      if (!text) continue;
      const left = Number(cols[TSV_COL.left]);
      const top = Number(cols[TSV_COL.top]);
      const width = Number(cols[TSV_COL.width]);
      const height = Number(cols[TSV_COL.height]);
      if (![left, top, width, height].every(Number.isFinite)) continue;
      words.push({ text, x0: left, y0: top, x1: left + width, y1: top + height });
    }
    return words;
  }
  // 단어 좌표들을 y좌표(세로 중심) 기준으로 "같은 행"으로 묶는다 — 표의 각 칸이 완벽히 같은
  // y좌표에서 시작하지 않을 수 있어(손글씨는 특히 더) 글자 높이에 비례한 허용오차를 둔다.
  function clusterWordsIntoRows(words) {
    const sorted = [...words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const heights = sorted.map((w) => w.y1 - w.y0).filter((h) => h > 0).sort((a, b) => a - b);
    const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
    const tolerance = Math.max(8, medianHeight * 0.6);
    const rows = [];
    sorted.forEach((w) => {
      const cy = (w.y0 + w.y1) / 2;
      let row = rows.find((r) => Math.abs(r.cy - cy) <= tolerance);
      if (!row) {
        row = { cy, words: [] };
        rows.push(row);
      }
      row.words.push(w);
      row.cy = row.words.reduce((s, x) => s + (x.y0 + x.y1) / 2, 0) / row.words.length;
    });
    rows.forEach((r) => r.words.sort((a, b) => a.x0 - b.x0));
    rows.sort((a, b) => a.cy - b.cy);
    return rows;
  }
  // 한 행 안에서 "칸 사이의 넓은 공백"을 기준으로 칸을 나눈다 — 표 칸 간격은 보통 글자 높이의
  // 1.8배 이상 벌어져 있고, 같은 칸 안 단어 사이 띄어쓰기는 그보다 훨씬 좁다(wordtest.html의
  // PDF 표 파서가 pt 단위 공백 너비로 칸을 가르는 것과 같은 아이디어, 여기서는 사진 픽셀 좌표
  // 기준). 칸이 하나만 나오면(표가 아니라 손으로 쓴 단순 "단어 뜻" 한 줄) null을 돌려줘서
  // 호출부가 splitWordMeaningLine으로 재시도하게 한다.
  // 한글은 음절(글자)마다 별도 "단어" 토큰으로 인식되는 경우가 많아(실측 확인, 2026-09-22 —
  // "바치다, 헌신하다"가 "바"/"치"/"다,"/"헌"/"신"/"하다"처럼 쪼개져 나옴), 칸 안에서 토큰을 이을
  // 때도 실제 간격이 있을 때만 띄어쓰기를 넣는다 — 무조건 " "로 합치면 "바 치 다"처럼 원문에
  // 없던 공백이 생긴다.
  function joinColumnWords(colWords) {
    if (colWords.length === 0) return "";
    let out = colWords[0].text;
    for (let i = 1; i < colWords.length; i++) {
      const gap = colWords[i].x0 - colWords[i - 1].x1;
      const avgHeight = ((colWords[i].y1 - colWords[i].y0) + (colWords[i - 1].y1 - colWords[i - 1].y0)) / 2;
      out += (gap > avgHeight * 0.25 ? " " : "") + colWords[i].text;
    }
    return out.trim();
  }
  function splitRowIntoColumns(rowWords) {
    if (rowWords.length === 0) return [];
    const avgHeight = rowWords.reduce((s, w) => s + (w.y1 - w.y0), 0) / rowWords.length;
    const gapThreshold = Math.max(20, avgHeight * 1.8);
    const columns = [[rowWords[0]]];
    for (let i = 1; i < rowWords.length; i++) {
      const gap = rowWords[i].x0 - rowWords[i - 1].x1;
      if (gap > gapThreshold) columns.push([]);
      columns[columns.length - 1].push(rowWords[i]);
    }
    return columns.map(joinColumnWords);
  }
  function rowToCandidate(colTexts) {
    if (colTexts.length === 0) return null;
    if (colTexts.length === 1) return splitWordMeaningLine(colTexts[0]);
    return { en: colTexts[0], ko: colTexts[1] };
  }
  function parseOcrTsv(tsvText) {
    const words = parseTsvWords(tsvText);
    if (words.length === 0) return [];
    return clusterWordsIntoRows(words)
      .map((r) => rowToCandidate(splitRowIntoColumns(r.words)))
      .map(cleanCandidate)
      .filter(Boolean)
      .map((p) => ({ id: uidLocal(), en: p.en, ko: p.ko, checked: true }));
  }
  // index.html이 실제로 부르는 진입점 — Tesseract worker.recognize()가 돌려주는 data 객체
  // (data.tsv/data.text) 전체를 받는다. 표 형식(좌표 기반) 파싱을 우선 시도하고, 결과가 하나도
  // 없으면(표가 아닌 사진이거나 tsv 출력이 비어있는 경우) 기존 텍스트 기반 파싱으로 폴백한다.
  function parseOcrResult(data) {
    const fromTsv = parseOcrTsv(data && data.tsv);
    if (fromTsv.length > 0) return fromTsv;
    return parseOcrText(data && data.text);
  }

  // ---- 커스텀 단어장 CRUD (순수 배열 변환, 실제 저장은 index.html의 setDocAt) ----
  function buildCustomVocabList({ name, words, source }) {
    const now = Date.now();
    return {
      id: uidLocal(),
      name: (name || "").trim() || "새 단어장",
      words: words || [],
      source: source === "photo" ? "photo" : "manual",
      createdAt: now,
      updatedAt: now,
    };
  }
  function appendWordsToList(lists, listId, newWords, source) {
    const now = Date.now();
    return (lists || []).map((l) =>
      l.id === listId
        ? { ...l, words: [...l.words, ...newWords], source: source === "photo" ? "photo" : l.source, updatedAt: now }
        : l
    );
  }

  // ---- 선생님 등록 교재 진행률(허브 섹션 1의 "N/M" 또는 "시작 전" 칩) ----
  // dayList: [{day, count}] (flashcardService.getDayList 결과 그대로) — count>0인 Day만 "진짜
  // 분량이 있는 Day"로 친다. flashcardSessions: 학생 문서의 data.flashcardSessions[] 그대로 —
  // 같은 책(bookId)·day 조합으로 완료된 세션(mode 무관, cards든 spelling이든 "그 Day를 끝냈다"는
  // 사실은 같음)이 하나라도 있으면 그 Day는 "완료"로 센다.
  function completedDaySet(flashcardSessions, bookId) {
    const set = new Set();
    (flashcardSessions || []).forEach((s) => {
      if (s.bookId === bookId && s.day != null) set.add(s.day);
    });
    return set;
  }
  function computeBookProgress(dayList, flashcardSessions, bookId) {
    const days = (dayList || []).filter((d) => d.count > 0);
    const done = completedDaySet(flashcardSessions, bookId);
    const completedCount = days.filter((d) => done.has(d.day)).length;
    if (completedCount === 0) return { label: "시작 전", started: false, completedCount, totalCount: days.length };
    return { label: `${completedCount}/${days.length}`, started: true, completedCount, totalCount: days.length };
  }
  // 다음에 이어할 Day — 아직 완료 안 한 첫 Day, 전부 끝났으면(또는 분량 자체가 없으면) 1로.
  function nextIncompleteDay(dayList, flashcardSessions, bookId) {
    const days = (dayList || []).filter((d) => d.count > 0).map((d) => d.day).sort((a, b) => a - b);
    if (days.length === 0) return 1;
    const done = completedDaySet(flashcardSessions, bookId);
    const next = days.find((d) => !done.has(d));
    return next != null ? next : days[0];
  }

  // ---- "단어 리스트" 화면의 품사 표시 ----
  // 원본 데이터(워드뱅크/커스텀 단어장 모두 {en,ko}뿐)에 품사 필드가 없어, 한국어 뜻의 어미만
  // 보는 아주 단순한 휴리스틱으로 추정한다(vocabTestService.inferKoreanPos와 같은 아이디어를
  // 표시용 한글 라벨로 재구성한 것 — 정식 형태소 분석이 아니라 완벽하지 않다, 예: "높다"가
  // 동사인지 형용사인지 구분 못 함). "~이"로 끝나는 어미는 일부러 부사 판정에서 뺐다 — 실제
  // 브라우저 테스트에서 "고양이"(명사)가 "~이" 규칙에 걸려 "부사"로 잘못 표시되는 게 바로
  // 재현됐다: "~이"로 끝나는 흔한 명사가 너무 많아(고양이/아이/구두 등) 오탐 위험이 크다.
  // "~히"/"~게"는 그런 흔한 명사 어미 충돌이 훨씬 적어 남겨뒀다.
  function posLabelForMeaning(ko) {
    const m = String(ko || "").trim();
    if (!m) return "";
    if (/다$/.test(m)) return "동사·형용사";
    if (/(히|게)$/.test(m) && m.length <= 6) return "부사";
    return "명사";
  }

  window.SarahServices.customVocabService = {
    splitWordMeaningLine,
    parseOcrText,
    parseOcrTsv,
    parseOcrResult,
    buildCustomVocabList,
    appendWordsToList,
    computeBookProgress,
    nextIncompleteDay,
    posLabelForMeaning,
  };
})();
