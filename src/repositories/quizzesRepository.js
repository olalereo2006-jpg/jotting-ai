// src/repositories/quizzesRepository.js
//
// Repository layer for Quizzes — same architecture as the other repositories.
// Backed by jottingDB's "quizzes" store (already existed, unused until now).
//
// SHAPE: one record per generated question-set — {id, userId, noteId, course,
// source, questions:[{question,options,answer},...], createdAt}. `source` is
// "quizme" (NoteDetail's Quiz Me) or "exam" (Exam Mode) so the two origins stay
// distinguishable without needing two separate stores.
//
// This does NOT touch Firebase or examResults — Exam Mode's SCORE still saves to
// Firestore via recordExamResult/examResults exactly as before; this only adds a
// local, structured copy of the quiz QUESTIONS themselves, which previously went
// nowhere at all once the screen was left.

import { jottingDB } from "../db/jottingDB";

var STORE = "quizzes";

// create(quiz) — stores a new quiz. Fills in id/createdAt if the caller didn't
// provide them, same fallback pattern every other repository here uses.
async function create(quiz){
  var toStore = {
    ...quiz,
    id: quiz.id != null ? quiz.id : Date.now(),
    createdAt: quiz.createdAt != null ? quiz.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single quiz, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every quiz for a user, newest first. Pass no userId to get every
// quiz in the store (e.g. for debugging).
async function list(userId){
  var quizzes = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return quizzes.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// update(id, fields) — shallow-merges fields into the existing quiz. Returns the
// updated quiz, or null if no quiz with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes a quiz. Named `remove` internally (delete is a reserved word for
// function names) and exposed below as `delete`, valid as a property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var quizzesRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};