// src/repositories/assignmentsRepository.js
//
// Repository layer for Assignments — same architecture as notesRepository (plain
// IndexedDB via jottingDB, generic create/get/list/update/delete verbs). Nothing
// about notes or courses changes here: notesRepository.js, coursesRepository.js,
// and everything else are untouched. Firebase/Firestore is untouched too.
//
// STORAGE: reads/writes go straight to jottingDB's "assignments" store
// (src/db/jottingDB.js, already created) — plain IndexedDB, nothing else.
//
// SHAPE: assignments stored here use the exact same fields the app already
// produces — id, title, course, dueDate, notes, completed, completedAt, userId,
// createdAt, plus the optional firestoreId App_login.js's Firestore sync adds —
// so this can receive real assignment objects with no reshaping.
//
// ORDERING: list() sorts by dueDate ascending (soonest due first), matching
// loadAssignmentsFromCloud's existing sort in App_login.js — deliberately NOT
// "newest created first" like notesRepository, since due date is what assignments
// are actually organized by everywhere in the app (Overdue/Due Soon/Upcoming).

import { jottingDB } from "../db/jottingDB";

var STORE = "assignments";

// create(assignment) — stores a new assignment. Fills in id/createdAt/completed if
// the caller didn't provide them, matching the defaults addAssignment() already
// applies (id:Date.now(), completed:false) before this is ever called.
async function create(assignment){
  var toStore = {
    ...assignment,
    id: assignment.id != null ? assignment.id : Date.now(),
    createdAt: assignment.createdAt != null ? assignment.createdAt : Date.now(),
    completed: assignment.completed != null ? assignment.completed : false,
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single assignment, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every assignment for a user, soonest due date first. Pass no
// userId to get every assignment in the store (e.g. for debugging).
async function list(userId){
  var assignments = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return assignments.slice().sort(function(a, b){ return (a.dueDate||"").localeCompare(b.dueDate||""); });
}

// update(id, fields) — shallow-merges fields into the existing assignment. This is
// also how "complete" works — toggleAssignment() in App_login.js just calls
// update(id, {completed, completedAt}), same as it already calls updateAssignment().
// Returns the updated assignment, or null if no assignment with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes an assignment. Named `remove` internally (delete is a reserved word for
// function names) and exposed below as `delete`, which IS valid as a property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var assignmentsRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};