// src/repositories/materialsRepository.js
//
// Repository layer for Materials — same architecture as the other repositories
// (plain IndexedDB via jottingDB, generic create/get/list/update/delete verbs).
// Backed by jottingDB's "materials" store, which already existed (reserved when
// jottingDB.js was first built) but was unused until now. That store's
// "by_semesterId" index is new, added alongside this — same reasoning as the
// courses update before it: Material now has a real semesterId field, so it
// needs to be indexable the same way userId/courseId already are.
//
// MODEL — fields, as specified:
//   userId       — Firebase uid that owns this material
//   courseId     — id of the Course this material belongs to (coursesRepository)
//   semesterId   — id of the Semester this material belongs to (semestersRepository)
//   title        — display name
//   type         — one of MATERIAL_TYPES below
//   status       — not enforced here, same permissive approach every repository
//                  in this codebase already takes
//   tags         — array of strings, caller-defined, not indexed
//   createdAt    — set once, on create()
//   updatedAt    — refreshed automatically on every update() call (see below);
//                  starts equal to createdAt on create()
// Plus id, same as every repository.
//
// TYPE ENUM: MATERIAL_TYPES is the canonical list of supported `type` values,
// exported so a future UI (a dropdown, a filter, etc.) can reference it instead
// of hardcoding the list a second time. It is NOT hard-enforced in create()/
// update() below — they still store whatever `type` they're given, same
// permissive "store whatever shape you're given" approach every other repository
// in this codebase already takes, so nothing breaks if a caller (or a future
// migration) needs to pass something outside this list temporarily. The list
// exists as the single source of truth for what's *expected*, not a runtime gate.
//
// NOT WIRED INTO ANY UI, and nothing migrates into it — model + repository only.
// Doesn't touch Firebase or any existing store's data.

import { jottingDB } from "../db/jottingDB";

var STORE = "materials";

export var MATERIAL_TYPES = [
  "lecture_note",
  "lecture_slide",
  "handout",
  "pdf",
  "document",
  "image",
  "recording",
  "transcript",
  "past_question",
  "assignment",
  "other",
];

// create(material) — stores a new material. Fills in id/createdAt if the caller
// didn't provide them (same fallback pattern every other repository here uses),
// and defaults updatedAt to the same moment as createdAt — nothing's been
// "updated" yet, so it starts equal to when the record was made.
async function create(material){
  var createdAt = material.createdAt != null ? material.createdAt : Date.now();
  var toStore = {
    ...material,
    id: material.id != null ? material.id : Date.now(),
    createdAt: createdAt,
    updatedAt: material.updatedAt != null ? material.updatedAt : createdAt,
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single material, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every material for a user, newest first. Pass no userId to get
// every material in the store (e.g. for debugging).
async function list(userId){
  var materials = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return materials.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// update(id, fields) — shallow-merges fields into the existing material, and
// always refreshes updatedAt to the current time regardless of what's in
// `fields` — the same kind of protection every repository already gives `id`
// (which also can't be overwritten via fields), just applied to the one other
// field a caller shouldn't be able to leave stale. Returns the updated material,
// or null if no material with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id, updatedAt: Date.now() };
  return jottingDB.put(STORE, merged);
}

// Deletes a material. Named `remove` internally (delete is a reserved word for
// function names) and exposed below as `delete`, valid as a property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var materialsRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};