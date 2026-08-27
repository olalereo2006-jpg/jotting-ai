// src/repositories/studySessionsRepository.js
//
// Repository layer for Study Sessions — same architecture as the other
// repositories (plain IndexedDB via jottingDB, generic create/get/list/update/
// delete verbs). Backed by jottingDB's "studySessions" store, which already
// existed (reserved when jottingDB.js was first built) but was unused until now.
//
// NOT WIRED IN: unlike studyPlansRepository (built alongside this in the same
// task), there's no existing "study session" feature anywhere in the app today —
// no screen creates, starts, stops, or tracks anything called a session, so
// there's no current behavior to preserve or move. Wiring this into real behavior
// would mean inventing new tracking logic (what counts as a session — a timer?
// time spent on a note? an AI Tutor conversation?), which is a product decision,
// not a "move this persistence" instruction, and guessing risks touching screens
// that have nothing to do with it. This file is built and ready — same treatment
// coursesRepository got, for the same reason — so wiring it in later is just a
// few create() calls away once a real "study session" concept is defined.
//
// SHAPE left open on purpose (only id/userId/createdAt are assumed) since the
// exact fields depend on what a session ends up representing.

import { jottingDB } from "../db/jottingDB";

var STORE = "studySessions";

async function create(session){
  var toStore = {
    ...session,
    id: session.id != null ? session.id : Date.now(),
    createdAt: session.createdAt != null ? session.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

async function get(id){
  return jottingDB.get(STORE, id);
}

async function list(userId){
  var sessions = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return sessions.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id };
  return jottingDB.put(STORE, merged);
}

async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var studySessionsRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};