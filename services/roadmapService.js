// Roadmap Milestone/Task system — extends the EXISTING data.roadmap shape (see ARCHITECTURE.md
// §"data.roadmap", RoadmapEditor/ParentRoadmapSection in index.html). Nothing here changes what a
// phase already stores (title/periodLabel/targetDate/focus/materials/detail/diagnosticDone/
// diagnosticDate/objectives/completionCriteria/whyThisStep/materialsList) or how currentPhaseIndex/
// diagnosticDone drive the existing "로드맵 지연" alerts and the simple phase-count progress used by
// TeacherOverview/MonthlyReportView/ParentDailyReportCard/ParentRoadmapSection today — those all
// keep reading exactly the fields they already read. This file only adds a new, OPTIONAL, additive
// field per phase: `categories` (Category[]), each holding Milestones, each holding Tasks — see
// buildup below. A phase with no `categories` (i.e. every phase that existed before this change)
// behaves exactly as before; `phaseProgress()` falls back to the old diagnosticDone-based signal.
//
// Hierarchy: Student(roadmap) → Phase → Category → Milestone → Task.
// No actual student milestone/task content is created by this file — every add* function requires
// an explicit title from the caller (the teacher, via the UI). No AI calls, no Firestore calls —
// pure data functions only, exactly like the other services/*Service.js files. The caller persists
// results via its own updateData(studentId, updater) (App()'s transactional read-modify-write).
window.SarahServices = window.SarahServices || {};

(function () {
  const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "PRACTICING", "MASTERED", "REVIEW_NEEDED"];

  const STATUS_LABEL_KO = {
    NOT_STARTED: "시작 전",
    IN_PROGRESS: "학습 중",
    PRACTICING: "연습 중",
    MASTERED: "숙달",
    REVIEW_NEEDED: "복습 필요",
  };

  const STATUS_ICON = {
    NOT_STARTED: "○",
    IN_PROGRESS: "◐",
    PRACTICING: "◑",
    MASTERED: "✓",
    REVIEW_NEEDED: "⚠",
  };

  // Suggested progress% when a teacher picks a status via the quick-select UI — a starting point,
  // not a hard rule (item 8: "실제 점수 기준이나 mastery 기준은 내가 이후 지정할 수 있도록"). The UI
  // applies this only as a default fill; the teacher can still type a different number afterward.
  const STATUS_DEFAULT_PROGRESS = {
    NOT_STARTED: 0,
    IN_PROGRESS: 40,
    PRACTICING: 70,
    MASTERED: 100,
    REVIEW_NEEDED: 60,
  };

  function statusLabel(status) {
    return STATUS_LABEL_KO[status] || STATUS_LABEL_KO.NOT_STARTED;
  }
  function statusIcon(status) {
    return STATUS_ICON[status] || STATUS_ICON.NOT_STARTED;
  }
  function defaultProgressForStatus(status) {
    return STATUS_DEFAULT_PROGRESS[status] ?? 0;
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function clampPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }

  function weightedAvg(items) {
    // items: [{ v, w }] — w defaults to 1 when omitted/invalid.
    const valid = (items || []).filter((it) => Number.isFinite(it.v));
    if (!valid.length) return 0;
    const totalW = valid.reduce((s, it) => s + (Number.isFinite(it.w) && it.w > 0 ? it.w : 1), 0);
    if (!totalW) return 0;
    const sum = valid.reduce((s, it) => s + it.v * (Number.isFinite(it.w) && it.w > 0 ? it.w : 1), 0);
    return clampPct(sum / totalW);
  }

  // ---------- Factories (blank entities — no guessed student content) ----------
  function createTask(title) {
    return {
      id: uid(), title: title || "", status: "NOT_STARTED", progress: 0,
      completedDate: null, score: null, mastery: "", notes: "", order: 0,
    };
  }
  function createMilestone(title) {
    return {
      id: uid(), title: title || "", description: "", order: 0,
      status: "NOT_STARTED", progress: 0, target: "", current: "",
      startDate: null, targetDate: null, completedDate: null,
      notes: "", relatedMaterials: "", evaluationCriteria: "",
      weight: 1, tasks: [],
      // Optional, additive (2026-08-27 로드맵 개편) — area: 영역별 진행률 바 그룹핑 키. 없으면
      // groupMilestonesByArea()가 title로 폴백하므로 기존 데이터도 마이그레이션 없이 즉시 동작한다.
      // materials: 4버킷 구조화 교재 목록. 없으면 UI가 기존 relatedMaterials 문자열로 폴백 표시한다.
      area: "",
      materials: { main: [], supplementary: [], school: [], intensive: [] },
    };
  }
  const MATERIAL_BUCKETS = ["main", "supplementary", "school", "intensive"];
  const MATERIAL_BUCKET_LABEL_KO = { main: "주교재", supplementary: "부교재", school: "내신/학교별", intensive: "기출·실전" };
  const MATERIAL_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"];
  // role: 같은 교재가 여러 Phase/Milestone에 걸쳐 반복 배치될 때(예: 유지 학습, 반복 응시) 그
  // 자리에서의 역할을 표시하는 optional 배지(2026-08-27 로드맵 교재 검토 후속 — additive, 기존
  // material에는 없어도 UI가 "역할 없음"으로 정상 렌더링한다). 버킷(주교재/부교재/내신/기출)과는
  // 별개 축이다 — 버킷은 "어디 담겼는가", role은 "이 자리에서 무슨 역할인가".
  const MATERIAL_ROLES = ["MAIN", "REVIEW", "SCHOOL", "INTENSIVE"];
  function createMaterialItem(fields) {
    return { id: uid(), title: "", publisher: "", level: "", status: "NOT_STARTED", role: "", ...(fields || {}) };
  }
  function materialsOf(milestone) {
    const m = (milestone && milestone.materials) || {};
    const out = {};
    MATERIAL_BUCKETS.forEach((b) => { out[b] = m[b] || []; });
    return out;
  }
  // 4항목 표준 Phase 통과 조건 틀(2026-08-27, 사용자 지시로 표준 문구 채택) — done은 항상 false로
  // 시작한다(완료 여부를 추측해서 채우지 않음, item 10 "날짜 경과나 추측으로 진행률을 매기지
  // 않는다" 원칙과 동일하게 체크리스트에도 적용). 기존 phase.completionCriteria(자유 텍스트,
  // 이미 실제 내용이 들어있음)는 이 체크리스트와 별개로 계속 유지되며 참고 메모로 함께 보여준다.
  // 고정 id를 쓴다(uid()가 아니라) — ensureChecklist()는 phase.completionChecklist가 아직
  // 저장되기 전까지는 호출될 때마다 이 기본값을 새로 만들어내는데, id가 매번 랜덤이면 방금 화면에
  // 그려진 항목의 id와 toggle 시점에 다시 생성되는 항목의 id가 서로 달라져서 체크가 반영되지 않는
  // 버그가 생긴다(실제로 harness 테스트에서 재현·발견). 라벨 기반 고정 id라 항상 같은 값을 낸다.
  function defaultCompletionChecklist() {
    return [
      { id: "target-level", label: "목표 수준 도달", done: false },
      { id: "diagnostic-pass", label: "진단평가 통과", done: false },
      { id: "weakness-done", label: "약점 보강 완료", done: false },
      { id: "next-phase-ready", label: "다음 단계 진입 가능", done: false },
    ];
  }
  function createCategory(title) {
    return { id: uid(), title: title || "", description: "", order: 0, weight: 1, milestones: [] };
  }

  // ---------- Progress rollup (Task → Milestone → Category → Phase → Overall) ----------
  // Every function is defensive against missing arrays (item 10: a Milestone with no Task, a
  // Category with no Milestone, or a Phase with no Category must never throw or render broken).
  function taskProgress(task) {
    if (!task) return 0;
    return Number.isFinite(task.progress) ? clampPct(task.progress) : defaultProgressForStatus(task.status);
  }
  function milestoneProgress(milestone) {
    if (!milestone) return 0;
    const tasks = milestone.tasks || [];
    if (tasks.length) return weightedAvg(tasks.map((t) => ({ v: taskProgress(t) })));
    return Number.isFinite(milestone.progress) ? clampPct(milestone.progress) : defaultProgressForStatus(milestone.status);
  }
  function categoryProgress(category) {
    if (!category) return 0;
    const milestones = category.milestones || [];
    if (!milestones.length) return 0;
    return weightedAvg(milestones.map((m) => ({ v: milestoneProgress(m), w: m.weight })));
  }
  // Phase progress: if the phase has categories with at least one milestone somewhere, average
  // those categories (weighted). Otherwise fall back to a manually-set phase.progress if present,
  // and finally to the existing diagnosticDone flag (100 if the phase's diagnostic is already
  // marked done, matching what the old summary widgets already treat as "this phase is complete").
  function phaseProgress(phase) {
    if (!phase) return 0;
    const cats = (phase.categories || []).filter((c) => (c.milestones || []).length > 0);
    if (cats.length) return weightedAvg(cats.map((c) => ({ v: categoryProgress(c), w: c.weight })));
    if (Number.isFinite(phase.progress)) return clampPct(phase.progress);
    return phase.diagnosticDone ? 100 : 0;
  }
  function overallProgress(roadmap) {
    const phases = (roadmap && roadmap.phases) || [];
    if (!phases.length) return 0;
    return weightedAvg(phases.map((p) => ({ v: phaseProgress(p), w: p.weight })));
  }

  // A phase/milestone/category doesn't store its own top-level "status" the way a Task/Milestone
  // does (item 3/5 list `status` as storable, but deriving it from progress keeps a single source
  // of truth instead of letting the two disagree) — this derives a STATUSES-compatible label purely
  // from the rollup progress number, for places that want a status chip without re-deriving it.
  function statusFromProgress(pct) {
    if (pct >= 100) return "MASTERED";
    if (pct >= 70) return "PRACTICING";
    if (pct > 0) return "IN_PROGRESS";
    return "NOT_STARTED";
  }

  // ---------- Immutable tree edits — every function returns a NEW phase object; callers persist
  // the result themselves via updateData(id, (d) => ({ ...d, roadmap: { ...d.roadmap, phases:
  // d.roadmap.phases.map((p, i) => i === viewIdx ? newPhase : p) } })), matching the existing
  // RoadmapEditor pattern exactly (phases are still addressed by array index, unchanged). ----------
  function mapCategories(phase, fn) {
    return { ...phase, categories: (phase.categories || []).map(fn) };
  }
  function mapMilestones(category, fn) {
    return { ...category, milestones: (category.milestones || []).map(fn) };
  }
  function mapTasks(milestone, fn) {
    return { ...milestone, tasks: (milestone.tasks || []).map(fn) };
  }

  function addCategory(phase, title) {
    const cats = phase.categories || [];
    const cat = { ...createCategory(title), order: cats.length };
    return { ...phase, categories: [...cats, cat] };
  }
  function updateCategory(phase, categoryId, patch) {
    return mapCategories(phase, (c) => (c.id === categoryId ? { ...c, ...patch } : c));
  }
  function removeCategory(phase, categoryId) {
    return { ...phase, categories: (phase.categories || []).filter((c) => c.id !== categoryId) };
  }
  function reorderCategories(phase, fromIdx, toIdx) {
    const cats = [...(phase.categories || [])];
    if (fromIdx < 0 || fromIdx >= cats.length || toIdx < 0 || toIdx >= cats.length) return phase;
    const [moved] = cats.splice(fromIdx, 1);
    cats.splice(toIdx, 0, moved);
    return { ...phase, categories: cats.map((c, i) => ({ ...c, order: i })) };
  }

  function addMilestone(phase, categoryId, title) {
    return mapCategories(phase, (c) => {
      if (c.id !== categoryId) return c;
      const ms = c.milestones || [];
      const m = { ...createMilestone(title), order: ms.length };
      return { ...c, milestones: [...ms, m] };
    });
  }
  function updateMilestone(phase, categoryId, milestoneId, patch) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => (m.id === milestoneId ? { ...m, ...patch } : m))));
  }
  function removeMilestone(phase, categoryId, milestoneId) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : { ...c, milestones: (c.milestones || []).filter((m) => m.id !== milestoneId) }));
  }
  function reorderMilestones(phase, categoryId, fromIdx, toIdx) {
    return mapCategories(phase, (c) => {
      if (c.id !== categoryId) return c;
      const ms = [...(c.milestones || [])];
      if (fromIdx < 0 || fromIdx >= ms.length || toIdx < 0 || toIdx >= ms.length) return c;
      const [moved] = ms.splice(fromIdx, 1);
      ms.splice(toIdx, 0, moved);
      return { ...c, milestones: ms.map((m, i) => ({ ...m, order: i })) };
    });
  }

  function addTask(phase, categoryId, milestoneId, title) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => {
      if (m.id !== milestoneId) return m;
      const ts = m.tasks || [];
      const t = { ...createTask(title), order: ts.length };
      return { ...m, tasks: [...ts, t] };
    })));
  }
  // 교재 목차 붙여넣기 → Task 일괄 생성(2026-08-31) — addTask 하나를 titles.length번 부른 것과
  // 같은 결과가 되도록 같은 mapCategories/mapMilestones 패턴을 그대로 쓴다. order는 기존
  // tasks.length부터 이어서 매겨서(0부터 다시 매기지 않음) 이미 있던 Task들과 뒤섞이지 않는다.
  function addTasksBulk(phase, categoryId, milestoneId, titles) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => {
      if (m.id !== milestoneId) return m;
      const ts = m.tasks || [];
      const newTasks = titles.map((title, i) => ({ ...createTask(title), order: ts.length + i }));
      return { ...m, tasks: [...ts, ...newTasks] };
    })));
  }
  function updateTask(phase, categoryId, milestoneId, taskId, patch) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => (m.id !== milestoneId ? m : mapTasks(m, (t) => (t.id === taskId ? { ...t, ...patch } : t))))));
  }
  function removeTask(phase, categoryId, milestoneId, taskId) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => (m.id !== milestoneId ? m : { ...m, tasks: (m.tasks || []).filter((t) => t.id !== taskId) }))));
  }
  function reorderTasks(phase, categoryId, milestoneId, fromIdx, toIdx) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => {
      if (m.id !== milestoneId) return m;
      const ts = [...(m.tasks || [])];
      if (fromIdx < 0 || fromIdx >= ts.length || toIdx < 0 || toIdx >= ts.length) return m;
      const [moved] = ts.splice(fromIdx, 1);
      ts.splice(toIdx, 0, moved);
      return { ...m, tasks: ts.map((t, i) => ({ ...t, order: i })) };
    })));
  }

  // ---------- Material CRUD (2026-08-27 로드맵 개편, additive) — milestone.materials[bucket][] ----------
  function mapMilestoneById(phase, categoryId, milestoneId, fn) {
    return mapCategories(phase, (c) => (c.id !== categoryId ? c : mapMilestones(c, (m) => (m.id === milestoneId ? fn(m) : m))));
  }
  function addMaterial(phase, categoryId, milestoneId, bucket, fields) {
    return mapMilestoneById(phase, categoryId, milestoneId, (m) => {
      const materials = materialsOf(m);
      return { ...m, materials: { ...materials, [bucket]: [...materials[bucket], createMaterialItem(fields)] } };
    });
  }
  function updateMaterial(phase, categoryId, milestoneId, bucket, materialId, patch) {
    return mapMilestoneById(phase, categoryId, milestoneId, (m) => {
      const materials = materialsOf(m);
      return { ...m, materials: { ...materials, [bucket]: materials[bucket].map((it) => (it.id === materialId ? { ...it, ...patch } : it)) } };
    });
  }
  function removeMaterial(phase, categoryId, milestoneId, bucket, materialId) {
    return mapMilestoneById(phase, categoryId, milestoneId, (m) => {
      const materials = materialsOf(m);
      return { ...m, materials: { ...materials, [bucket]: materials[bucket].filter((it) => it.id !== materialId) } };
    });
  }

  // ---------- Phase completion checklist (2026-08-27, additive — phase.completionChecklist[]) ----------
  function toggleChecklistItem(phase, itemId) {
    const items = phase.completionChecklist || [];
    return { ...phase, completionChecklist: items.map((it) => (it.id === itemId ? { ...it, done: !it.done } : it)) };
  }
  function ensureChecklist(phase) {
    return (phase.completionChecklist && phase.completionChecklist.length) ? phase.completionChecklist : defaultCompletionChecklist();
  }

  // ---------- Area grouping (2026-08-27 로드맵 개편) — "영역별 Progress" 바를 위해 한 Phase 안의
  // 모든 Milestone을 Category 구분 없이 area(없으면 title로 폴백) 기준으로 묶는다. 같은 area 이름을
  // 가진 Milestone이 여러 개면 진행률은 그 Milestone들의 단순 평균(가중치 없음 — 영역 자체는
  // Category/Milestone weight 체계 밖의 읽기 전용 요약 뷰라서 별도 가중치를 받지 않는다). ----------
  function groupMilestonesByArea(phase) {
    const rows = allMilestones(phase);
    const order = [];
    const byArea = {};
    rows.forEach((r) => {
      const key = (r.milestone.area || r.milestone.title || "").trim() || "(이름 없음)";
      if (!byArea[key]) { byArea[key] = []; order.push(key); }
      byArea[key].push(r);
    });
    return order.map((area) => {
      const entries = byArea[area];
      const progress = clampPct(entries.reduce((s, e) => s + e.progress, 0) / entries.length);
      const anyReviewNeeded = entries.some((e) => e.milestone.status === "REVIEW_NEEDED");
      return { area, progress, entries, status: areaStatusInfo(progress, anyReviewNeeded) };
    });
  }
  // ON TRACK / IN PROGRESS / NEEDS ATTENTION / COMPLETED — item 3 요구사항의 영역 상태 라벨.
  // REVIEW_NEEDED로 표시된 Milestone이 하나라도 섞여 있으면 진행률과 무관하게 NEEDS ATTENTION을
  // 우선한다(교사가 명시적으로 "복습 필요"라고 표시한 신호를 진행률 숫자보다 우선 반영).
  function areaStatusInfo(progress, hasReviewNeeded) {
    if (hasReviewNeeded) return { key: "needsAttention", label: "NEEDS ATTENTION" };
    if (progress >= 100) return { key: "completed", label: "COMPLETED" };
    if (progress > 0) return { key: "onTrack", label: "IN PROGRESS" };
    return { key: "notStarted", label: "NOT STARTED" };
  }

  // ---------- Read-only overview helpers (for a Phase-cards-with-bars summary view) ----------
  // Flattens every milestone across all of a phase's categories into one list, category
  // boundaries dropped — the "PHASE 카드를 펼치면 세부 목표 진행률이 쭉 보인다" overview only
  // needs title/progress/status per milestone, not the editing-time category grouping.
  function allMilestones(phase) {
    const rows = [];
    (phase.categories || []).forEach((category) => {
      (category.milestones || []).forEach((milestone) => {
        rows.push({ category, milestone, progress: milestoneProgress(milestone) });
      });
    });
    return rows;
  }
  // Phase-level 완료/진행중/예정 status — deliberately reuses the SAME signal the existing circle
  // stepper already derives from (diagnosticDone + currentPhaseIndex), not phaseProgress()'s
  // percentage, so "완료" here can never disagree with the existing "진단시험 완료" button/badge
  // elsewhere in RoadmapEditor. Never elapsed-time-based (no targetDate math).
  function phaseStatusInfo(phase, idx, currentIdx) {
    const done = idx < currentIdx || (idx === currentIdx && !!phase.diagnosticDone);
    if (done) return { key: "done", icon: "✓", label: "완료" };
    if (idx === currentIdx) return { key: "current", icon: "●", label: "진행 중" };
    return { key: "upcoming", icon: "○", label: "예정" };
  }
  // First not-yet-100%-complete milestone in a phase, in category/milestone order — used for a
  // "다음 milestone" readout. Returns null when the phase has no milestones or all are complete.
  function nextIncompleteMilestone(phase) {
    const rows = allMilestones(phase).filter((r) => r.progress < 100);
    return rows.length ? rows[0] : null;
  }

  window.SarahServices.roadmapService = {
    STATUSES, STATUS_LABEL_KO, STATUS_ICON, STATUS_DEFAULT_PROGRESS,
    statusLabel, statusIcon, defaultProgressForStatus, statusFromProgress,
    createTask, createMilestone, createCategory,
    taskProgress, milestoneProgress, categoryProgress, phaseProgress, overallProgress,
    addCategory, updateCategory, removeCategory, reorderCategories,
    addMilestone, updateMilestone, removeMilestone, reorderMilestones,
    addTask, addTasksBulk, updateTask, removeTask, reorderTasks,
    allMilestones, phaseStatusInfo, nextIncompleteMilestone,
    MATERIAL_BUCKETS, MATERIAL_BUCKET_LABEL_KO, MATERIAL_STATUSES, MATERIAL_ROLES,
    createMaterialItem, materialsOf, addMaterial, updateMaterial, removeMaterial,
    defaultCompletionChecklist, toggleChecklistItem, ensureChecklist,
    groupMilestonesByArea, areaStatusInfo,
  };
})();
