// src/repositories/quizAttemptsRepository.js
//
// Repository layer for Quiz Attempts — same architecture as the other
// repositories (plain IndexedDB via jottingDB, generic create/get/list/update/
// delete verbs). Backed by jottingDB's new "quizAttempts" store (added
// alongside this file — by_userId/by_quizId/by_courseId indexes, matching the
// relationship fields below).
//
// This is a separate store from the existing "quizzes" store: "quizzes" holds
// generated question-sets (what Quiz Me / Exam Mode build from a note or
// course); "quizAttempts" holds a record of someone actually taking one.
//
// SHAPE: one record per attempt — {id, userId, quizId, courseId, answers,
// score, correctCount, totalQuestions, startedAt, completedAt}. `answers` is
// stored exactly as given (e.g. an array index-aligned with the quiz's
// questions, same shape Quiz Me/Exam Mode already build in App_login.js) —
// this repository doesn't interpret or validate it, same "store whatever
// shape you're given" approach every other repository here takes.
//
// INTENDED FLOW (not wired into any screen yet): create() when an attempt
// starts (startedAt set; completedAt/score/correctCount/answers still empty),
// then update() once it's submitted (completedAt, score, correctCount,
// answers filled in). Nothing forces this two-step shape — create() will just
// as happily store a fully-finished attempt in one call.
//
// NOT WIRED IN: nothing in App_login.js calls this yet. Quiz Me (NoteDetail)
// and Exam Mode are completely untouched — Exam Mode's score still persists
// exactly as before, via recordExamResult/examResults/Firestore. This file is
// repository-only, ready for whenever quiz attempts get wired into the UI.

import { jottingDB } from "../db/jottingDB";

var STORE = "quizAttempts";

// create(attempt) — stores a new quiz attempt. Fills in id/startedAt if the
// caller didn't provide them (startedAt plays the same "when was this record
// made" role createdAt plays in every other repository here). Every other
// field — userId, quizId, courseId, answers, score, correctCount,
// totalQuestions, completedAt — is stored exactly as given, no defaults
// invented.
async function create(attempt){
  var toStore = {
    ...attempt,
    id: attempt.id != null ? attempt.id : Date.now(),
    startedAt: attempt.startedAt != null ? attempt.startedAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single quiz attempt, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every quiz attempt for a user, most recently started first.
// Pass no userId to get every attempt in the store (e.g. for debugging).
async function list(userId){
  var attempts = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return attempts.slice().sort(function(a, b){ return (b.startedAt||0) - (a.startedAt||0); });
}

// update(id, fields) — shallow-merges fields into the existing attempt. This is
// how an in-progress attempt gets its completedAt/score/correctCount/answers
// filled in once it's submitted. Returns the updated attempt, or null if no
// attempt with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes a quiz attempt. Named `remove` internally (delete is a reserved word
// for function names) and exposed below as `delete`, valid as a property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var quizAttemptsRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};