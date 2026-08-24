// Read access to the two collections index.html's App() already centrally owns
// (sarahsEnglishMeta/main, sarahsEnglishStudents/*) — see ARCHITECTURE.md §2 for the full
// schema. This does NOT replace App()'s loadStore/saveMeta/ensureData/updateData (those still
// own all writes and the React-state cache); it exists so new, non-React code — the backup
// feature, future report/analytics tooling — can read the same data without depending on
// App()'s component tree or duplicating window.__db boilerplate.
//
// Read-only in Phase 1. Do not add write functions here without updating updateData()'s
// transaction logic in index.html to match — see the "1MB-per-student-document limit" and
// "Data storage" sections of CLAUDE.md before writing to sarahsEnglishStudents/*.
window.SarahServices = window.SarahServices || {};

(function () {
  const { getDoc, getAllDocs } = window.SarahServices.firebaseClient;

  const META_COLLECTION = "sarahsEnglishMeta";
  const META_DOC_ID = "main";
  const STUDENTS_COLLECTION = "sarahsEnglishStudents";

  async function getMeta() {
    return await getDoc(META_COLLECTION, META_DOC_ID);
  }

  async function getRoster() {
    const meta = await getMeta();
    return (meta && meta.roster) || [];
  }

  async function getStudentDoc(studentId) {
    return await getDoc(STUDENTS_COLLECTION, studentId);
  }

  // Reads the whole sarahsEnglishStudents collection in one query (rather than looping over the
  // roster with one getDoc per student) — also catches any student document that has no matching
  // roster entry, which a roster-driven loop would silently skip.
  async function getAllStudentDocs() {
    return await getAllDocs(STUDENTS_COLLECTION);
  }

  window.SarahServices.studentService = {
    getMeta,
    getRoster,
    getStudentDoc,
    getAllStudentDocs,
  };
})();
