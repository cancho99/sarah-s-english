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
    };
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

  window.SarahServices.roadmapService = {
    STATUSES, STATUS_LABEL_KO, STATUS_ICON, STATUS_DEFAULT_PROGRESS,
    statusLabel, statusIcon, defaultProgressForStatus, statusFromProgress,
    createTask, createMilestone, createCategory,
    taskProgress, milestoneProgress, categoryProgress, phaseProgress, overallProgress,
    addCategory, updateCategory, removeCategory, reorderCategories,
    addMilestone, updateMilestone, removeMilestone, reorderMilestones,
    addTask, updateTask, removeTask, reorderTasks,
  };
})();
