// Shared Firestore access helpers for the services/ layer.
//
// No build step / no ES modules for this app (see CLAUDE.md) — index.html's own Firebase
// module script hangs the SDK functions it needs off `window.__db`/`window.__doc`/etc. so the
// classic (non-module) app script can call them. These service files are also classic scripts,
// loaded with `defer` after that module script, so `window.__db` is guaranteed ready by the time
// any function below actually runs (top-level code here does not touch Firestore).
//
// This file must load before any other services/*.js file.
window.SarahServices = window.SarahServices || {};

(function () {
  function db() {
    return window.__db;
  }

  async function getDoc(collectionName, id) {
    const ref = window.__doc(db(), collectionName, id);
    const snap = await window.__getDoc(ref);
    return snap.exists() ? snap.data() : null;
  }

  // Reads every document in a collection. Returns { [docId]: docData }.
  async function getAllDocs(collectionName) {
    const snap = await window.__getDocs(window.__collection(db(), collectionName));
    const out = {};
    snap.forEach((docSnap) => {
      out[docSnap.id] = docSnap.data();
    });
    return out;
  }

  // Phase 9-D bugfix — a plain getAllDocs() (unconstrained getDocs over the whole collection)
  // fails with permission-denied under a Firestore Rule that depends on a per-document field
  // (e.g. examAssignments' "own studentId only" rule) when called by a non-teacher token: Firestore
  // rejects list queries it can't statically prove the rule holds for across the whole potential
  // result set. Adding a matching where() clause lets Firestore verify the rule against the query
  // itself instead, so this works for both teacher (rule's isTeacher() branch is data-independent,
  // already worked either way) and student/parent (now actually query-provable) callers.
  async function getDocsWhere(collectionName, field, value) {
    const snap = await window.__getDocs(window.__query(window.__collection(db(), collectionName), window.__where(field, "==", value)));
    const out = {};
    snap.forEach((docSnap) => {
      out[docSnap.id] = docSnap.data();
    });
    return out;
  }

  // Same byte-size measure index.html's StorageCleanupPanel uses for the 1MB-doc-cap check.
  function docSizeBytes(data) {
    return new Blob([JSON.stringify(data)]).size;
  }

  // Generic write primitives — added for Phase 5 (Question Bank), which is the first services/
  // consumer that owns a standalone collection of its own (one doc per item, like materialsLibrary/
  // readingLibrary) rather than only reading/joining collections index.html or another file already
  // owns. Kept generic (collectionName as a parameter) so any future collection with the same
  // one-doc-per-item shape can reuse these instead of every service reimplementing addDoc/setDoc/
  // deleteDoc calls against window.__* directly.
  async function addDocTo(collectionName, data) {
    const ref = await window.__addDoc(window.__collection(db(), collectionName), data);
    return ref.id;
  }
  async function setDocAt(collectionName, id, data, opts) {
    await window.__setDoc(window.__doc(db(), collectionName, id), data, opts || {});
  }
  async function deleteDocAt(collectionName, id) {
    await window.__deleteDoc(window.__doc(db(), collectionName, id));
  }

  window.SarahServices.firebaseClient = { getDoc, getAllDocs, getDocsWhere, docSizeBytes, addDocTo, setDocAt, deleteDocAt };
})();
