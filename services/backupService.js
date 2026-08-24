// Phase 1-A: full student-data backup/export. Read-only — never writes to Firestore, never
// mutates the data it reads. Mirrors the actual current Firestore structure (sarahsEnglishMeta/
// main + every doc in sarahsEnglishStudents) rather than a redesigned/normalized shape, so the
// exported JSON is a faithful snapshot restorable by hand if it's ever needed, independent of any
// later schema migration.
window.SarahServices = window.SarahServices || {};

(function () {
  const { getMeta, getAllStudentDocs } = window.SarahServices.studentService;
  const { getAllDocs } = window.SarahServices.firebaseClient;

  async function buildFullBackup() {
    const [meta, students, grammarQuestions, readingPassages, readingQuestions] = await Promise.all([
      getMeta(),
      getAllStudentDocs(),
      getAllDocs("grammarQuestions"), // Phase 5 — first Question Bank collection, see questionBankService.js
      getAllDocs("readingPassages"), // Phase 6 — ARCHITECTURE.md §12.3
      getAllDocs("readingQuestions"), // Phase 6 — ARCHITECTURE.md §12.3
    ]);
    return {
      exportedAt: new Date().toISOString(),
      version: "1.2",
      source: "Sarah's English — services/backupService.js",
      // sarahsEnglishMeta/main as-is: roster (incl. student/parent login codes, schedule,
      // FCM tokens), teacherAuth, levelTestBookings, announcement, examKeyLibrary, teacherTodos,
      // sharedDriveFolderLink. Contains personal info (name/birthdate/address) and login codes —
      // store the downloaded file the same way you'd store any other student-records export.
      meta: meta || {},
      // sarahsEnglishStudents/<id> as-is, keyed by studentId: logs, homework, vocabTests,
      // examTests, vocabResults, examResults, mockExams, mockExamResults, vocabLog,
      // regularExams, consultRequests, tuitionRecords, notes, roadmap, dailyReports,
      // monthlyReports, monthlyStats, attendance, studyLog, neltResults, and any other field
      // present on the live document (nothing is filtered out or renamed).
      students: students || {},
      // grammarQuestions/<id> as-is, keyed by question id (Phase 5). Future banks
      // (mockExamQuestionBank/originalQuestions) should be added here the same way when they're
      // built, so a full backup always covers every question-bank collection that exists.
      grammarQuestions: grammarQuestions || {},
      // readingPassages/<id> + readingQuestions/<id> as-is (Phase 6, ARCHITECTURE.md §12.3) — the
      // Reading Question Bank, NOT the student-facing readingLibrary/readingActivity/readingJournal
      // collections (those are already inside `students` and unaffected by this bank).
      readingPassages: readingPassages || {},
      readingQuestions: readingQuestions || {},
    };
  }

  function downloadJson(obj, filename) {
    const json = JSON.stringify(obj, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportFullBackupAsFile(filename) {
    const backup = await buildFullBackup();
    const name = filename || `sarahs-english-backup-${new Date().toISOString().slice(0, 10)}.json`;
    downloadJson(backup, name);
    return backup;
  }

  window.SarahServices.backupService = {
    buildFullBackup,
    downloadJson,
    exportFullBackupAsFile,
  };
})();
