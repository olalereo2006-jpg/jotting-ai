// src/repositories/notesRepository.js
//
// Repository layer for Notes — the first of what will eventually be one repository
// per data type (assignments, flashcards, ...), each exposing the same five verbs
// so the UI can eventually work through a stable interface no matter what's
// underneath a note (Firestore today, this IndexedDB layer going forward).
//
// STORAGE: reads/writes go straight to jottingDB's "notes" store (src/db/jottingDB.js)
// — plain IndexedDB, nothing else. This does NOT touch Firebase/Firestore, and
// nothing in App_login.js calls this file yet — the existing Firestore +
// localStorage note flow (saveNoteToCloud / loadNotesFromCloud / loadNotesLocal /
// persistNotesLocal / updateNoteInCloud in App_login.js) is completely unchanged
// and is still what actually runs the app today.
//
// SHAPE: notes stored here use the exact same fields the app already produces —
// id, title, course, color, bg, tag, words, preview, content, userId, createdAt,
// plus the optional type/hidden/firestoreId fields NoteDetail and the creation
// screens already set — so this can receive real note objects later with no
// reshaping.
//
// COURSE LINKING: notes can now optionally carry courseId/semesterId, pointing at
// real Course/Semester records (coursesRepository/semestersRepository). This is
// ADDITIVE — `course` (the existing free-text name like "PHY 101") is NOT
// removed, still means exactly what it always did, and is still the only thing
// any current screen (Library, Home, Dashboard, filters, exports, ...) actually
// reads. courseId/semesterId start unset on every existing note and stay unset
// unless something explicitly connects them — see connectCourse/
// resolveCourseLink/backfillCourseLinks below. None of this is wired into
// App_login.js yet.

import { jottingDB } from "../db/jottingDB";

var STORE = "notes";

// create(note) — stores a new note. Fills in id/createdAt if the caller didn't
// provide them, the same fallback App_login.js's saveNote() already uses
// (createdAt: note.createdAt || Date.now()) — so behavior matches whether the
// id/timestamp come from the caller or from here.
async function create(note){
  var toStore = {
    ...note,
    id: note.id != null ? note.id : Date.now(),
    createdAt: note.createdAt != null ? note.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single note, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every note for a user, newest first — same ordering
// loadNotesFromCloud already uses today (sort by createdAt descending). Pass no
// userId to get every note in the store (e.g. for debugging).
async function list(userId){
  var notes = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return notes.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// update(id, fields) — shallow-merges fields into the existing note, mirroring the
// {merge:true} semantics updateNoteInCloud already uses against Firestore. Returns
// the updated note, or null if no note with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes a note. Named `remove` internally and exposed below as `delete`, since
// `delete` is a reserved word and can't be used as a function declaration's name
// (it CAN be used as an object property/method name, which is all the UI needs).
async function remove(id){
  return jottingDB.remove(STORE, id);
}

// ── Course linking (additive — see the COURSE LINKING note above) ──────────────

// connectCourse(noteId, courseId, semesterId) — explicitly links an existing note
// to a Course (and optionally its Semester) by id. Only ever touches
// courseId/semesterId — `course`, the original free-text name, and every other
// field on the note are left exactly as they were. Safe to call on any note,
// including ones that only ever had a course name and nothing else.
async function connectCourse(noteId, courseId, semesterId){
  return update(noteId, {
    courseId: courseId != null ? courseId : null,
    semesterId: semesterId != null ? semesterId : null,
  });
}

// resolveCourseLink(note, courses) — pure, no side effects. Given a note and a
// list of Course records (e.g. from coursesRepository.listCourses(userId)),
// works out which Course the note's free-text `course` name most likely refers
// to: a case-insensitive, trimmed match against each Course's `code` first (note
// names already look like course codes — "PHY 101", "MTH 101"), falling back to
// `title` if no code matches. Returns {courseId, semesterId}, both null if
// nothing matches. Never reads or writes anything beyond its arguments, and
// never touches note.course — the free-text name is treated as read-only input,
// not something this resolves "away".
function resolveCourseLink(note, courses){
  var name = ((note && note.course) || "").trim().toLowerCase();
  if (!name) return { courseId: null, semesterId: null };
  var list_ = courses || [];
  var match = list_.find(function(c){ return ((c.code||"")).trim().toLowerCase() === name; })
    || list_.find(function(c){ return ((c.title||"")).trim().toLowerCase() === name; });
  if (!match) return { courseId: null, semesterId: null };
  return { courseId: match.id, semesterId: match.semesterId != null ? match.semesterId : null };
}

// backfillCourseLinks(userId, courses) — for every one of a user's notes that
// doesn't already have a courseId, tries resolveCourseLink() against the given
// Course list and connects it only when a confident match is found. Notes that
// already have a courseId are left alone (skipped, never re-resolved or
// overwritten), and notes whose course name matches nothing are left completely
// untouched — no courseId is invented, `course` is never edited. Because there
// are no Course records anywhere yet (coursesRepository has never been wired into
// the app), calling this today will safely match nothing and change nothing —
// it's here and ready for whenever real Course data exists. Returns
// {linked, skipped} so a caller can see what happened. NOT called automatically
// by anything in this file — an explicit, opt-in operation.
async function backfillCourseLinks(userId, courses){
  var userNotes = await list(userId);
  var linked = 0, skipped = 0;
  for (var i=0; i<userNotes.length; i++){
    var note = userNotes[i];
    if (note.courseId != null) { skipped++; continue; }
    var resolved = resolveCourseLink(note, courses);
    if (resolved.courseId != null) {
      await connectCourse(note.id, resolved.courseId, resolved.semesterId);
      linked++;
    } else {
      skipped++;
    }
  }
  return { linked: linked, skipped: skipped };
}

export var notesRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
  connectCourse: connectCourse,
  resolveCourseLink: resolveCourseLink,
  backfillCourseLinks: backfillCourseLinks,
};