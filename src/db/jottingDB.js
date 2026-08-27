// src/db/jottingDB.js
//
// A single reusable IndexedDB database for Jotting AI's local-first data layer.
//
// WHY THIS EXISTS: App_login.js already has an ad-hoc IndexedDB database
// ("jotting_audio_db") used only for lecture-recording audio blobs, plus a matching
// set of localStorage caches (jotting_notes_{uid}, jotting_assignments_{uid}, ...)
// that each shadow one Firestore collection. This file is a separate, general-purpose
// database — "jotting_db" — with one object store per data type the app deals with,
// so future local-first / offline work has a single place to read and write instead
// of hand-rolling a new localStorage key or IndexedDB store every time a feature
// needs one.
//
// NOT WIRED IN YET: nothing calls this file, no existing feature's storage has
// moved, Firebase/Firestore is untouched, and the old jotting_audio_db is completely
// separate and untouched. Safe to drop into the project and import from wherever a
// future feature needs it.
//
// NAME HEADS-UP: this DB has a store called "recordings", and so does the OLD
// jotting_audio_db. They're two different databases with two different jobs —
// jotting_audio_db.recordings holds raw audio Blobs keyed by recording id;
// jotting_db.recordings (this file) is for recording records in the new unified
// layer. Don't confuse the two when this eventually gets wired up.
//
// DESIGN: one small set of generic CRUD helpers (put/get/getAll/getAllByIndex/
// remove/clear) shared by every store below, instead of ten bespoke read/write
// functions per store.

var DB_NAME = "jotting_db";
// Bumped 4 -> 5 to add a "by_semesterId" index to the existing "notes" store
// (notes can now optionally link to a Semester, same relationship courses and
// materials already got). Same existing-store-safe upgrade path as before —
// existing stores and their data are unaffected, this only adds what's missing.
//
// Bumped 5 -> 6 to add a "by_materialId" index to the existing "notes" store
// (notes can now optionally reference a Material, same relationship pattern as
// by_courseId/by_semesterId above). Schema-only change: no note gets a
// materialId automatically, nothing about note create/update flows changes,
// and old notes with no materialId field simply don't show up in a
// by_materialId lookup — they're otherwise completely unaffected. Same
// existing-store-safe upgrade path as every bump before it.
//
// Bumped 6 -> 7 to add "by_semesterId" and "by_materialId" indexes to the
// existing "recordings" store (metadata only — this is jottingDB's
// "recordings" store, NOT the separate jotting_audio_db that holds the actual
// audio Blobs; that database, its store, and every helper touching it
// — openAudioDb/saveAudioBlobLocal/getAudioBlobLocal/deleteAudioBlobLocal in
// App_login.js — are completely untouched by this change, audio still never
// leaves the device). Recordings already had "by_courseId" from an earlier
// version; this just rounds it out with the same Course/Semester/Material
// relationship trio notes now has. Schema-only: no recording gets a
// semesterId/materialId automatically, nothing about how recordings are
// created/renamed/deleted/transcribed changes. Same existing-store-safe
// upgrade path as every bump before it.
//
// Bumped 7 -> 8 to add a brand-new "quizAttempts" store (userId/quizId/
// courseId indexes) — separate from the existing "quizzes" store, which holds
// generated question-sets, not attempts at answering them. New store, so
// nothing existing is touched; not wired into any screen yet (see
// quizAttemptsRepository.js).
var DB_VERSION = 8;

// Every store uses "id" as its primary key, matching how the app already
// identifies records (note.id, assignment.id, recording.id, ...) — so values
// already flowing through the app can be put() into these stores as-is, with no
// reshaping, whenever a feature is actually migrated to use this file.
//
// Each store gets a "by_userId" index, since every piece of content in this app is
// scoped to a Firebase uid. A few stores also get a relationship index
// (by_courseId / by_noteId) for the natural "everything belonging to this
// course/note" queries those features need.
var STORE_CONFIG = {
  courses:       { indexes: [["by_userId", "userId"], ["by_semesterId", "semesterId"]] },
  semesters:     { indexes: [["by_userId", "userId"]] },
  notes:         { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"], ["by_semesterId", "semesterId"], ["by_materialId", "materialId"]] },
  materials:     { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"], ["by_semesterId", "semesterId"]] },
  assignments:   { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"]] },
  flashcards:    { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"], ["by_noteId", "noteId"]] },
  quizzes:       { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"], ["by_noteId", "noteId"]] },
  quizAttempts:  { indexes: [["by_userId", "userId"], ["by_quizId", "quizId"], ["by_courseId", "courseId"]] },
  studyPlans:    { indexes: [["by_userId", "userId"]] },
  studySessions: { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"]] },
  recordings:    { indexes: [["by_userId", "userId"], ["by_courseId", "courseId"], ["by_semesterId", "semesterId"], ["by_materialId", "materialId"]] },
  // Pending offline writes waiting to be pushed to Firestore later — not user
  // CONTENT like the stores above, so it gets its own shape: an auto-incrementing
  // key (queue entries don't have a natural id of their own) plus indexes for the
  // two questions a future sync worker needs to ask: "what's still pending?" and
  // "what's queued for this particular store?".
  syncQueue:     { autoIncrement: true, indexes: [["by_status", "status"], ["by_storeName", "storeName"]] },
};

var STORE_NAMES = Object.keys(STORE_CONFIG);

// ── Open / upgrade ────────────────────────────────────────────────────────────
var dbPromise = null;
function openJottingDB(){
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function(resolve, reject){
    if (!("indexedDB" in window)) { reject(new Error("This browser doesn't support local storage for Jotting AI.")); return; }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(){
      var db = req.result;
      var tx = req.transaction; // the versionchange transaction — lets us reach into stores that already existed from an earlier version, not just brand-new ones
      STORE_NAMES.forEach(function(name){
        var cfg = STORE_CONFIG[name];
        var store;
        if (db.objectStoreNames.contains(name)) {
          // Store already exists from an earlier version — don't recreate it
          // (that would wipe its data). Just get a reference so any indexes
          // added to STORE_CONFIG since then can still be created below.
          store = tx.objectStore(name);
        } else {
          store = cfg.autoIncrement
            ? db.createObjectStore(name, { keyPath:"id", autoIncrement:true })
            : db.createObjectStore(name, { keyPath:"id" });
        }
        (cfg.indexes||[]).forEach(function(pair){
          if (!store.indexNames.contains(pair[0])) store.createIndex(pair[0], pair[1], { unique:false });
        });
      });
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ dbPromise = null; reject(req.error || new Error("Couldn't open Jotting AI's local database.")); };
  });
  return dbPromise;
}

function assertStore(storeName){
  if (STORE_NAMES.indexOf(storeName) === -1) {
    throw new Error("Unknown Jotting DB store: \""+storeName+"\". Valid stores: "+STORE_NAMES.join(", "));
  }
}
function withStore(storeName, mode){
  assertStore(storeName);
  return openJottingDB().then(function(db){ return db.transaction(storeName, mode).objectStore(storeName); });
}

// ── Generic CRUD — reused by every store above ──────────────────────────────
// Insert or overwrite a record by its id (or let autoIncrement assign one, for
// syncQueue entries that don't pass an id at all).
async function put(storeName, value){
  var store = await withStore(storeName, "readwrite");
  return new Promise(function(resolve, reject){
    var req = store.put(value);
    req.onsuccess = function(){ resolve(value); };
    req.onerror = function(){ reject(req.error); };
  });
}
async function get(storeName, id){
  var store = await withStore(storeName, "readonly");
  return new Promise(function(resolve, reject){
    var req = store.get(id);
    req.onsuccess = function(){ resolve(req.result || null); };
    req.onerror = function(){ reject(req.error); };
  });
}
async function getAll(storeName){
  var store = await withStore(storeName, "readonly");
  return new Promise(function(resolve, reject){
    var req = store.getAll();
    req.onsuccess = function(){ resolve(req.result || []); };
    req.onerror = function(){ reject(req.error); };
  });
}
// e.g. getAllByIndex("notes", "by_userId", uid) or getAllByIndex("flashcards", "by_courseId", courseId)
async function getAllByIndex(storeName, indexName, value){
  var store = await withStore(storeName, "readonly");
  return new Promise(function(resolve, reject){
    var req = store.index(indexName).getAll(value);
    req.onsuccess = function(){ resolve(req.result || []); };
    req.onerror = function(){ reject(req.error); };
  });
}
async function remove(storeName, id){
  var store = await withStore(storeName, "readwrite");
  return new Promise(function(resolve, reject){
    var req = store.delete(id);
    req.onsuccess = function(){ resolve(true); };
    req.onerror = function(){ reject(req.error); };
  });
}
async function clear(storeName){
  var store = await withStore(storeName, "readwrite");
  return new Promise(function(resolve, reject){
    var req = store.clear();
    req.onsuccess = function(){ resolve(true); };
    req.onerror = function(){ reject(req.error); };
  });
}

// Single facade export — one object to import wherever this eventually gets used:
//   import { jottingDB } from "./db/jottingDB";
//   await jottingDB.put("notes", note);
//   var myNotes = await jottingDB.getAllByIndex("notes", "by_userId", uid);
export var jottingDB = {
  STORE_NAMES: STORE_NAMES,
  open: openJottingDB,
  put: put,
  get: get,
  getAll: getAll,
  getAllByIndex: getAllByIndex,
  remove: remove,
  clear: clear,
};