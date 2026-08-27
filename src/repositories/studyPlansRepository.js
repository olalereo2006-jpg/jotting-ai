// src/repositories/studyPlansRepository.js
//
// Repository layer for Study Plans — same architecture as the other repositories
// (plain IndexedDB via jottingDB, generic create/get/list/update/delete verbs).
// Backed by jottingDB's "studyPlans" store, which already existed (reserved when
// jottingDB.js was first built) but was unused until now.
//
// SHAPE: one record per generated plan — {id, userId, courses, examDate,
// hoursPerDay, planText, createdAt}. Mirrors what StudyPlannerScreen already
// generates and displays; planText is the same Markdown it renders today.
//
// This does NOT touch Firebase — plans are IndexedDB-only, same as courses. The
// existing "Save" button in StudyPlannerScreen (which flattens a plan into a Note)
// is completely untouched and still works exactly as before; this just adds a
// second, silent, structured local copy the moment a plan is generated.

import { jottingDB } from "../db/jottingDB";

var STORE = "studyPlans";

async function create(planRecord){
  var toStore = {
    ...planRecord,
    id: planRecord.id != null ? planRecord.id : Date.now(),
    createdAt: planRecord.createdAt != null ? planRecord.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

async function get(id){
  return jottingDB.get(STORE, id);
}

async function list(userId){
  var plans = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return plans.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
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

export var studyPlansRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};