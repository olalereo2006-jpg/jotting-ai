// src/repositories/coursesRepository.js
//
// Repository layer for Courses — same shape and backing store (jottingDB, IndexedDB)
// as notesRepository, but exposing course-specific verb names as requested. Nothing
// about notes changes here: notesRepository.js and every note call site in
// App_login.js are untouched. Firebase/Firestore is untouched too — this is a new,
// standalone local repository, not wired into the app yet.
//
// STORAGE: reads/writes go straight to jottingDB's "courses" store
// (src/db/jottingDB.js) — plain IndexedDB, nothing else. That store now also has a
// "by_semesterId" index (added alongside this update) so a course can be looked up
// by the semester it belongs to, once that's needed.
//
// MODEL — fields now formally supported:
//   userId       — Firebase uid that owns this course
//   semesterId   — id of the Semester this course belongs to (semestersRepository)
//   code         — e.g. "PHY 101"
//   title        — e.g. "General Physics I"
//   units        — credit unit count
//   department   — e.g. "Physics"
//   level        — e.g. "200L"
//   status       — e.g. "active" | "completed" — not enforced here, same
//                  "store whatever shape you're given" approach every other
//                  repository in this codebase already takes
// Plus the existing id/createdAt every repository defaults if the caller omits
// them — nothing that worked before is removed, this only adds definition on top
// of what was previously a fully open, undocumented shape. The functions below
// are unchanged: they already store whatever object they're given, so no code
// here needed to change for these fields to work — this update is the model
// becoming real, not a rewrite of how it's stored.

import { jottingDB } from "../db/jottingDB";

var STORE = "courses";

// createCourse(course) — stores a new course. Fills in id/createdAt if the caller
// didn't provide them, the same fallback pattern notesRepository.create() uses.
// Any of the model fields above (userId, semesterId, code, title, units,
// department, level, status) are stored as-is — none are required or defaulted.
async function createCourse(course){
  var toStore = {
    ...course,
    id: course.id != null ? course.id : Date.now(),
    createdAt: course.createdAt != null ? course.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// getCourse(id) — a single course, or null if it doesn't exist.
async function getCourse(id){
  return jottingDB.get(STORE, id);
}

// listCourses(userId) — every course for a user, newest first. Pass no userId to
// get every course in the store (e.g. for debugging).
async function listCourses(userId){
  var courses = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return courses.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// updateCourse(id, fields) — shallow-merges fields into the existing course.
// Returns the updated course, or null if no course with that id exists yet.
async function updateCourse(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// deleteCourse(id) — removes a course.
async function deleteCourse(id){
  return jottingDB.remove(STORE, id);
}

export var coursesRepository = {
  createCourse: createCourse,
  getCourse: getCourse,
  listCourses: listCourses,
  updateCourse: updateCourse,
  deleteCourse: deleteCourse,
};