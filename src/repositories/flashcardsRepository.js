// src/repositories/flashcardsRepository.js
//
// Repository layer for Flashcard decks — same architecture as notesRepository/
// assignmentsRepository (plain IndexedDB via jottingDB, generic create/get/list/
// update/delete verbs). Backed by jottingDB's "flashcards" store, which already
// existed (reserved when jottingDB.js was first built) but was unused until now.
//
// SHAPE: one record PER DECK, not per card — {id, userId, noteId, course, title,
// cards:[{front,back},...], createdAt}. This matches how FlashcardsScreen already
// builds and uses a deck: generated, studied, and (optionally) saved as one unit,
// never queried card-by-card.
//
// This does NOT touch Firebase — decks are IndexedDB-only, same as courses.

import { jottingDB } from "../db/jottingDB";

var STORE = "flashcards";

// create(deck) — stores a new deck. Fills in id/createdAt if the caller didn't
// provide them, same fallback pattern every other repository here uses.
async function create(deck){
  var toStore = {
    ...deck,
    id: deck.id != null ? deck.id : Date.now(),
    createdAt: deck.createdAt != null ? deck.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single deck, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every deck for a user, newest first. Pass no userId to get every
// deck in the store (e.g. for debugging).
async function list(userId){
  var decks = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return decks.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// update(id, fields) — shallow-merges fields into the existing deck. Returns the
// updated deck, or null if no deck with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes a deck. Named `remove` internally (delete is a reserved word for
// function names) and exposed below as `delete`, valid as a property name.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var flashcardsRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};