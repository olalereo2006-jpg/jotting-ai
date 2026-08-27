// src/repositories/semestersRepository.js
//
// Repository layer for Semesters — same architecture as the other repositories
// (plain IndexedDB via jottingDB, generic create/get/list/update/delete verbs).
// Backed by jottingDB's "semesters" store — a NEW store added in this same change
// (jottingDB.js's DB_VERSION was bumped 1 -> 2 so IndexedDB actually creates it for
// anyone who already has jotting_db open; every existing store/its data is
// completely unaffected by that bump).
//
// MODEL — fields, as specified:
//   userId       — Firebase uid that owns this semester
//   name         — e.g. "First Semester", "Fall 2026"
//   academicYear — e.g. "2025/2026"
//   startDate    — ISO date string, e.g. "2026-01-12"
//   endDate      — ISO date string, e.g. "2026-05-30"
//   status       — e.g. "upcoming" | "active" | "completed" — not enforced here,
//                  same "store whatever shape you're given" approach every other
//                  repository in this codebase already takes
// Plus the usual id/createdAt every repository defaults if the caller omits them.
//
// NOT WIRED INTO ANY UI, and nothing migrates into it — this is model +
// repository only, per the request. Doesn't touch Firebase, courses, or any
// existing store; nothing in App_login.js imports this file yet.

import { jottingDB } from "../db/jottingDB";

var STORE = "semesters";

// create(semester) — stores a new semester. Fills in id/createdAt if the caller
// didn't provide them, same fallback pattern every other repository here uses.
async function create(semester){
  var toStore = {
    ...semester,
    id: semester.id != null ? semester.id : Date.now(),
    createdAt: semester.createdAt != null ? semester.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single semester, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every semester for a user, soonest-starting first (matches the
// dueDate-ascending convention assignmentsRepository already uses for date-driven
// data). Pass no userId to get every semester in the store (e.g. for debugging).
async function list(userId){
  var semesters = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return semesters.slice().sort(function(a, b){ return (a.startDate||"").localeCompare(b.startDate||""); });
}

// update(id, fields) — shallow-merges fields into the existing semester (e.g.
// flipping status as a term progresses). Returns the updated semester, or null if
// no semester with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes a semester. Named `remove` internally (delete is a reserved word for
// function names) and exposed below as `delete`, valid as a property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var semestersRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};