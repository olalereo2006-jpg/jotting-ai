// src/services/recommendationService.js
//
// Deterministic, rule-based study recommendations. No AI call anywhere — every
// rule below is a plain comparison against numbers already sitting in existing
// repositories. Nothing here is wired into any screen.
//
// THE FOUR RULES (exactly as given, nothing added or merged):
//   1. assignment due <48h            -> high priority
//   2. mastery <50%                   -> weak topic
//   3. exam <7 days AND mastery <70%  -> high priority
//   4. no study activity >3 days      -> reminder
// Rules 2 and 3 are independent, not one escalating the other — they use
// different mastery thresholds (50 vs 70) and different signals (mastery
// alone vs mastery + an approaching exam), so the same topic can legitimately
// produce BOTH a "weak topic" and an "exam prep" recommendation if it
// qualifies for both. Nothing here tries to merge or dedupe that.
//
// PRIORITY LEVELS: rules 1 and 3 explicitly say "high priority". Rules 2 and 4
// don't state a tier, so this file makes an explicit, documented choice:
// weak topic = "medium" (a real concern, but not as time-critical as 1/3),
// study reminder = "low" (a nudge). Easy to change in PRIORITY_WEIGHT below if
// that doesn't match the product's intent.
//
// buildRecommendations(input) is the whole rule engine and is PURE — no
// repository calls, no Date.now() unless the caller omits `now`, fully
// testable in isolation. getRecommendations(userId, options) is a thin
// orchestration layer around it — see the note above that function about one
// real gap (exam dates) that it does NOT try to paper over.

import { assignmentsRepository } from "../repositories/assignmentsRepository";
import { topicMasteryRepository } from "../repositories/topicMasteryRepository";
import { notesRepository } from "../repositories/notesRepository";
import { recordingsRepository } from "../repositories/recordingsRepository";
import { quizAttemptsRepository } from "../repositories/quizAttemptsRepository";

var HOUR_MS = 60 * 60 * 1000;
var DAY_MS = 24 * HOUR_MS;

var ASSIGNMENT_DUE_SOON_HOURS = 48;
export var WEAK_TOPIC_MASTERY_THRESHOLD = 50;
export var EXAM_PREP_MASTERY_THRESHOLD = 70;
var EXAM_PREP_DAYS_AHEAD = 7;
var STUDY_INACTIVITY_DAYS = 3;

var PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };

// Matches how AssignmentsScreen already parses assignment.dueDate elsewhere in
// the app (new Date(dateStr+"T00:00:00")) — same interpretation of "due date"
// (start of that calendar day), so this rule agrees with what Assignments
// already shows as Overdue/Due Soon/Upcoming.
function parseDateOnly(dateStr){
  if (dateStr == null) return null;
  if (typeof dateStr === "number") return dateStr;
  var d = new Date(dateStr + "T00:00:00");
  var t = d.getTime();
  return isNaN(t) ? null : t;
}

// buildRecommendations(input) — pure. `input`:
//   now                  — ms timestamp, defaults to Date.now()
//   assignments          — array from assignmentsRepository.list(userId)
//   topicMastery          — array from topicMasteryRepository.list(userId)
//   exams                — array of {courseId, examDate}. examDate can be a
//                          ms timestamp or a "YYYY-MM-DD" string. Not backed
//                          by any repository yet — see getRecommendations().
//   lastStudyActivityAt  — ms timestamp of the most recent study action, or
//                          null/undefined to skip rule 4 entirely (rather
//                          than assuming "infinitely long ago").
// Returns an array of recommendations, highest priority first; within a tier,
// most urgent/severe first (see sortKey comments per rule below).
export function buildRecommendations(input){
  input = input || {};
  var now = input.now != null ? input.now : Date.now();
  var assignments = input.assignments || [];
  var topicMastery = input.topicMastery || [];
  var exams = input.exams || [];
  var lastStudyActivityAt = input.lastStudyActivityAt;

  var recommendations = [];

  // ── Rule 1: assignment due <48h -> high priority ──────────────────────────
  // "<48h" is read as "less than 48 hours of runway remain", which includes
  // already-overdue assignments (negative hours remaining) under the same
  // rule — there's no separate "overdue" rule in the brief, so this doesn't
  // invent one; `overdue` is just carried in evidence for display purposes.
  assignments.forEach(function(a){
    if (a.completed) return;
    var due = parseDateOnly(a.dueDate);
    if (due == null) return;
    var hoursUntilDue = (due - now) / HOUR_MS;
    if (hoursUntilDue < ASSIGNMENT_DUE_SOON_HOURS) {
      var overdue = hoursUntilDue < 0;
      recommendations.push({
        type: "assignment_due_soon",
        priority: "high",
        title: overdue ? "Assignment overdue" : "Assignment due soon",
        message: overdue
          ? "\""+a.title+"\" ("+(a.course||"General")+") was due "+Math.round(Math.abs(hoursUntilDue)/24)+" day(s) ago."
          : "\""+a.title+"\" ("+(a.course||"General")+") is due in "+Math.max(0,Math.round(hoursUntilDue))+" hour(s).",
        assignmentId: a.id,
        courseId: a.courseId != null ? a.courseId : null,
        evidence: { hoursUntilDue: hoursUntilDue, overdue: overdue, dueDate: a.dueDate },
        sortKey: hoursUntilDue, // fewer hours (more negative if overdue) sorts first
      });
    }
  });

  // ── Rule 2: mastery <50% -> weak topic ────────────────────────────────────
  topicMastery.forEach(function(m){
    if (typeof m.masteryScore !== "number" || m.masteryScore >= WEAK_TOPIC_MASTERY_THRESHOLD) return;
    recommendations.push({
      type: "weak_topic",
      priority: "medium",
      title: "Weak topic",
      message: "\""+m.topic+"\" mastery is at "+m.masteryScore+"% — below the "+WEAK_TOPIC_MASTERY_THRESHOLD+"% mark.",
      courseId: m.courseId != null ? m.courseId : null,
      topic: m.topic,
      evidence: { masteryScore: m.masteryScore, confidence: m.confidence },
      sortKey: m.masteryScore, // lower score (weaker) sorts first within this tier
    });
  });

  // ── Rule 3: exam <7 days AND mastery <70% -> high priority ────────────────
  // Every topicMastery record is checked against every exam for the same
  // courseId — small-scale nested loop, same "filter in JS" approach used
  // elsewhere in this codebase rather than a DB-level join.
  exams.forEach(function(exam){
    var examDate = parseDateOnly(exam.examDate);
    if (examDate == null) return;
    var daysUntilExam = (examDate - now) / DAY_MS;
    if (daysUntilExam < 0 || daysUntilExam >= EXAM_PREP_DAYS_AHEAD) return;
    topicMastery.forEach(function(m){
      if (m.courseId !== exam.courseId) return;
      if (typeof m.masteryScore !== "number" || m.masteryScore >= EXAM_PREP_MASTERY_THRESHOLD) return;
      recommendations.push({
        type: "exam_prep",
        priority: "high",
        title: "Exam prep needed",
        message: "Exam in "+Math.max(0,Math.round(daysUntilExam))+" day(s) — \""+m.topic+"\" mastery is only "+m.masteryScore+"%.",
        courseId: m.courseId,
        topic: m.topic,
        evidence: { daysUntilExam: daysUntilExam, masteryScore: m.masteryScore, examDate: exam.examDate },
        sortKey: daysUntilExam, // soonest exam sorts first within this tier
      });
    });
  });

  // ── Rule 4: no study activity >3 days -> reminder ─────────────────────────
  // Only evaluated when the caller actually supplied a value — no data isn't
  // treated as "infinitely inactive".
  if (typeof lastStudyActivityAt === "number") {
    var daysSinceActivity = (now - lastStudyActivityAt) / DAY_MS;
    if (daysSinceActivity > STUDY_INACTIVITY_DAYS) {
      recommendations.push({
        type: "study_reminder",
        priority: "low",
        title: "Time to study",
        message: "No study activity in "+Math.floor(daysSinceActivity)+" day(s).",
        courseId: null,
        evidence: { daysSinceActivity: daysSinceActivity, lastStudyActivityAt: lastStudyActivityAt },
        sortKey: -daysSinceActivity, // more days inactive sorts first within this (single-item) tier
      });
    }
  }

  recommendations.sort(function(a, b){
    var weightDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
    if (weightDiff !== 0) return weightDiff;
    return a.sortKey - b.sortKey;
  });

  return recommendations;
}

// computeLastStudyActivity(userId) — most recent of: a note created, a
// recording made, or a quiz attempt completed. Doesn't consider quiz
// generation (quizzesRepository) or AI Tutor/Chat sessions (those live in
// Firestore, not the local repository layer this file otherwise reads from)
// — genuinely doing something locally-tracked counts, generating content
// doesn't. Returns null if there's no activity at all yet (rather than 0,
// which would look like "just now").
async function computeLastStudyActivity(userId){
  var results = await Promise.all([
    notesRepository.list(userId),
    recordingsRepository.list(userId),
    quizAttemptsRepository.list(userId),
  ]);
  var notes = results[0], recordings = results[1], quizAttempts = results[2];
  var timestamps = []
    .concat(notes.map(function(n){ return n.createdAt || 0; }))
    .concat(recordings.map(function(r){ return r.createdAt || 0; }))
    .concat(quizAttempts.filter(function(qa){ return qa.completedAt != null; }).map(function(qa){ return qa.completedAt; }));
  if (!timestamps.length) return null;
  return Math.max.apply(null, timestamps);
}

// getRecommendations(userId, options) — thin orchestration around
// buildRecommendations(). Auto-fetches assignments, topicMastery, and (unless
// supplied) lastStudyActivityAt from existing repositories — all read-only
// list() calls, nothing is written or changed.
//
// EXAMS ARE THE ONE GAP THIS DOESN'T PAPER OVER: there's no repository that
// stores an exam date keyed by courseId today. The closest existing data is
// studyPlansRepository (userId/courses[]/examDate), but `courses` there is an
// array of free-text course NAMES (e.g. "PHY 101"), the same convention notes
// and assignments use — not the courseId that topicMastery/quizAttempts use.
// Auto-resolving free-text names to courseId here would risk silently
// matching the wrong course, which is worse than just asking for it
// explicitly. So: pass `options.exams` as [{courseId, examDate}] yourself
// until there's a real exam concept with a courseId on it — this function
// won't guess.
export async function getRecommendations(userId, options){
  options = options || {};
  var now = options.now != null ? options.now : Date.now();
  var exams = options.exams || [];

  var results = await Promise.all([
    assignmentsRepository.list(userId),
    topicMasteryRepository.list(userId),
  ]);
  var assignments = results[0], topicMastery = results[1];

  var lastStudyActivityAt = options.lastStudyActivityAt;
  if (lastStudyActivityAt === undefined) {
    lastStudyActivityAt = await computeLastStudyActivity(userId);
  }

  return buildRecommendations({
    now: now,
    assignments: assignments,
    topicMastery: topicMastery,
    exams: exams,
    lastStudyActivityAt: lastStudyActivityAt,
  });
}