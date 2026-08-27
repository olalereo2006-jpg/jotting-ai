// src/repositories/topicMasteryRepository.js
//
// Repository layer for Topic Mastery — same architecture as the other
// repositories (plain IndexedDB via jottingDB, generic create/get/list/update/
// delete verbs). Backed by jottingDB's new "topicMastery" store (added
// alongside this file — by_userId/by_courseId indexes, matching the
// relationship fields below).
//
// SHAPE: one record per topic being tracked within a course — {id, userId,
// courseId, topic, masteryScore, confidence, trend, lastStudiedAt,
// nextReviewAt, createdAt, updatedAt}. `topic` is a plain string (e.g. "Newton's
// laws"), not linked to any other store — same "store whatever shape you're
// given" approach every other repository here takes, no validation on
// masteryScore/confidence/trend's shape or range.
//
// updatedAt behaves like materialsRepository's: refreshed automatically on
// every update() call, since a mastery record is a live, evolving value (it
// gets recalculated as a student studies more) rather than a fixed snapshot
// like a note or a quiz attempt — knowing when it was last recalculated matters
// here in a way it doesn't for most other stores.
//
// list() sorts newest-created-first, the same default every other repository
// here uses (courses/notes/materials/quizzes/...). No UI exists yet to know
// whether "soonest due for review" (sort by nextReviewAt) would actually serve
// a future screen better — that's a product decision for whenever this gets
// wired in, not guessed at here.
//
// NOT WIRED IN: nothing in App_login.js calls this yet, and no screen displays
// or edits mastery data. Repository-only, ready for whenever this gets built.

import { jottingDB } from "../db/jottingDB";

var STORE = "topicMastery";

// create(record) — stores a new topic mastery record. Fills in id/createdAt if
// the caller didn't provide them (same fallback pattern every other repository
// here uses), and defaults updatedAt to the same moment as createdAt — nothing's
// been "updated" yet, so it starts equal to when the record was made. Every
// other field — userId, courseId, topic, masteryScore, confidence, trend,
// lastStudiedAt, nextReviewAt — is stored exactly as given, no defaults invented.
async function create(record){
  var createdAt = record.createdAt != null ? record.createdAt : Date.now();
  var toStore = {
    ...record,
    id: record.id != null ? record.id : Date.now(),
    createdAt: createdAt,
    updatedAt: record.updatedAt != null ? record.updatedAt : createdAt,
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single topic mastery record, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every topic mastery record for a user, newest first. Pass no
// userId to get every record in the store (e.g. for debugging).
async function list(userId){
  var records = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return records.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// update(id, fields) — shallow-merges fields into the existing record, and
// always refreshes updatedAt to the current time regardless of what's in
// `fields` — the same protection materialsRepository already gives its
// updatedAt field, applied here for the same reason (this is how
// masteryScore/confidence/trend/lastStudiedAt/nextReviewAt get revised as a
// student keeps studying). Returns the updated record, or null if no record
// with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id, updatedAt: Date.now() };
  return jottingDB.put(STORE, merged);
}

// Deletes a topic mastery record. Named `remove` internally (delete is a
// reserved word for function names) and exposed below as `delete`, valid as a
// property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var topicMasteryRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};