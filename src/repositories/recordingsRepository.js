// src/repositories/recordingsRepository.js
//
// Repository layer for Recording METADATA ONLY — same architecture as the other
// repositories (plain IndexedDB via jottingDB, generic create/get/list/update/
// delete verbs). Backed by jottingDB's "recordings" store, which already existed
// (reserved when jottingDB.js was first built) but was unused until now.
//
// IMPORTANT — DO NOT CONFUSE WITH THE AUDIO BLOB STORE: App_login.js has TWO
// separate IndexedDB databases that each have a store named "recordings":
//   1. jotting_audio_db.recordings — holds the raw audio Blob for each recording
//      (openAudioDb/saveAudioBlobLocal/getAudioBlobLocal/deleteAudioBlobLocal).
//      Completely untouched by this file. Audio is NEVER uploaded to Firebase.
//   2. jotting_db.recordings (jottingDB.js) — holds only metadata: title, course,
//      duration, size, mimeType, transcribed flag, linked noteId. This repository
//      only ever touches #2.
// Every field stored here mirrors what already syncs to Firestore's "recordings"
// collection (saveRecordingMeta etc. in App_login.js) — this is just a local,
// structured copy in place of localStorage's old "jotting_recordings_{uid}" cache.

import { jottingDB } from "../db/jottingDB";

var STORE = "recordings";

// create(recording) — stores a recording's metadata. Fills in id/createdAt if the
// caller didn't provide them, same fallback pattern every other repository here uses.
async function create(recording){
  var toStore = {
    ...recording,
    id: recording.id != null ? recording.id : Date.now(),
    createdAt: recording.createdAt != null ? recording.createdAt : Date.now(),
  };
  return jottingDB.put(STORE, toStore);
}

// get(id) — a single recording's metadata, or null if it doesn't exist.
async function get(id){
  return jottingDB.get(STORE, id);
}

// list(userId) — every recording's metadata for a user, newest first — matches
// loadRecordingsFromCloud's existing sort. Pass no userId to get everything in
// the store (e.g. for debugging).
async function list(userId){
  var recordings = userId != null
    ? await jottingDB.getAllByIndex(STORE, "by_userId", userId)
    : await jottingDB.getAll(STORE);
  return recordings.slice().sort(function(a, b){ return (b.createdAt||0) - (a.createdAt||0); });
}

// update(id, fields) — shallow-merges fields into existing metadata (e.g. marking
// audioReady/transcribed, renaming). Returns the updated record, or null if no
// recording with that id exists yet.
async function update(id, fields){
  var existing = await jottingDB.get(STORE, id);
  if (!existing) return null;
  var merged = { ...existing, ...fields, id: existing.id }; // id never changes on update
  return jottingDB.put(STORE, merged);
}

// Deletes a recording's metadata (NOT its audio — that's deleteAudioBlobLocal's
// job, in the other database, called separately). Named `remove` internally
// (delete is a reserved word for function names) and exposed below as `delete`.
async function remove(id){
  return jottingDB.remove(STORE, id);
}

export var recordingsRepository = {
  create: create,
  get: get,
  list: list,
  update: update,
  delete: remove,
};