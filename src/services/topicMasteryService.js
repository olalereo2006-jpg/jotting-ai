// src/services/topicMasteryService.js
//
// Turns a completed quiz attempt into an update to topic mastery. This is the
// first thing in the codebase that connects the two new stores built earlier
// this session (quizAttempts, topicMastery) — everything below is pure
// calculation plus repository reads/writes. No AI call anywhere, and nothing
// here is wired into any screen — Quiz Me (NoteDetail) and Exam Mode in
// App_login.js are completely untouched.
//
// WHY A TOPIC IS PASSED IN SEPARATELY: neither quizzesRepository nor
// quizAttemptsRepository stores a "topic" today — quizzes link to a
// note/course, attempts link to a quiz/course. Rather than invent a topic
// field on either of those stores (out of scope here), the caller supplies
// which topic a given attempt is evidence for. A quiz that covers several
// topics can be recorded against each one by calling
// updateTopicMasteryFromQuizAttempt once per topic.
//
// THE MATH (deterministic, no AI, tunable via the constants below):
//   masteryScore — an exponential moving average. This attempt's accuracy
//     (correctCount/totalQuestions) is blended into the existing score at a
//     fixed weight (EVIDENCE_WEIGHT), so one bad quiz doesn't erase a long
//     track record but recent performance still moves the needle. A topic
//     with no prior record just takes the first attempt's accuracy directly —
//     nothing to blend with yet.
//   confidence — grows a fixed step per attempt (bigger quizzes count for a
//     bit more), capped at 1. Reflects how much evidence has accumulated, not
//     how good the score is — a topic can have low mastery but high
//     confidence (the student reliably struggles with it), or the reverse.
//   trend — "new" on the very first attempt for a topic, otherwise
//     "up"/"down"/"steady" depending on whether this attempt moved
//     masteryScore by more than TREND_THRESHOLD_POINTS.
//   nextReviewAt — a simple spaced-repetition bucket: higher mastery pushes
//     the next review further out, lower mastery brings it sooner.

import { topicMasteryRepository } from "../repositories/topicMasteryRepository";

var ONE_DAY_MS = 24 * 60 * 60 * 1000;

// How much a single new attempt shifts an existing masteryScore.
// 0 = ignore new evidence entirely, 1 = ignore history, use the new score only.
var EVIDENCE_WEIGHT = 0.35;

// Confidence gained per attempt, before the quiz-size adjustment below.
var CONFIDENCE_STEP_BASE = 0.15;
// Quiz-size adjustment: a 10-question quiz counts as "normal" (factor 1);
// shorter/longer quizzes count for a bit less/more, bounded so one huge quiz
// can't saturate confidence by itself.
var CONFIDENCE_SIZE_FACTOR_MIN = 0.5;
var CONFIDENCE_SIZE_FACTOR_MAX = 1.5;

// masteryScore has to move by more than this many points for an attempt to
// count as "up"/"down" rather than "steady".
var TREND_THRESHOLD_POINTS = 5;

// masteryScore floor -> days until next review. Checked in order; the first
// threshold the score meets or exceeds wins. Below the lowest threshold falls
// through to REVIEW_INTERVAL_DEFAULT_DAYS.
var REVIEW_INTERVALS = [
  { minScore: 85, days: 14 },
  { minScore: 70, days: 7 },
  { minScore: 50, days: 3 },
];
var REVIEW_INTERVAL_DEFAULT_DAYS = 1;

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }

function reviewIntervalDaysFor(score){
  for (var i=0; i<REVIEW_INTERVALS.length; i++){
    if (score >= REVIEW_INTERVALS[i].minScore) return REVIEW_INTERVALS[i].days;
  }
  return REVIEW_INTERVAL_DEFAULT_DAYS;
}

// calculateMasteryUpdate(currentMastery, evidence) — pure, no repository
// calls, easy to test in isolation. `currentMastery` is the existing
// topicMastery record, or null/undefined for a topic with no record yet.
// `evidence` is {correctCount, totalQuestions, completedAt}. Returns only the
// fields that change: {masteryScore, confidence, trend, lastStudiedAt,
// nextReviewAt} — never touches identity fields (id/userId/courseId/topic),
// that's the caller's job.
export function calculateMasteryUpdate(currentMastery, evidence){
  var totalQuestions = evidence.totalQuestions;
  if (!totalQuestions || totalQuestions <= 0) {
    throw new Error("calculateMasteryUpdate: evidence.totalQuestions must be greater than 0.");
  }
  var accuracyPct = clamp((evidence.correctCount||0) / totalQuestions * 100, 0, 100);

  var hasPriorRecord = !!(currentMastery && typeof currentMastery.masteryScore === "number");
  var previousScore = hasPriorRecord ? currentMastery.masteryScore : accuracyPct;
  var newScore = hasPriorRecord
    ? Math.round(previousScore * (1 - EVIDENCE_WEIGHT) + accuracyPct * EVIDENCE_WEIGHT)
    : Math.round(accuracyPct);
  newScore = clamp(newScore, 0, 100);

  var sizeFactor = clamp(totalQuestions / 10, CONFIDENCE_SIZE_FACTOR_MIN, CONFIDENCE_SIZE_FACTOR_MAX);
  var priorConfidence = (currentMastery && typeof currentMastery.confidence === "number") ? currentMastery.confidence : 0;
  var rawConfidence = priorConfidence + CONFIDENCE_STEP_BASE * sizeFactor;
  var newConfidence = Math.round(clamp(rawConfidence, 0, 1) * 100) / 100; // 2 decimals, not a long float

  var trend;
  if (!hasPriorRecord) {
    trend = "new";
  } else {
    var delta = newScore - previousScore;
    trend = delta > TREND_THRESHOLD_POINTS ? "up" : delta < -TREND_THRESHOLD_POINTS ? "down" : "steady";
  }

  var lastStudiedAt = evidence.completedAt != null ? evidence.completedAt : Date.now();
  var nextReviewAt = lastStudiedAt + reviewIntervalDaysFor(newScore) * ONE_DAY_MS;

  return {
    masteryScore: newScore,
    confidence: newConfidence,
    trend: trend,
    lastStudiedAt: lastStudiedAt,
    nextReviewAt: nextReviewAt,
  };
}

// updateTopicMasteryFromQuizAttempt(quizAttempt, topic) — the orchestration
// half: finds (or creates) the topicMastery record for
// (quizAttempt.userId, quizAttempt.courseId, topic), runs
// calculateMasteryUpdate against it, and persists the result via
// topicMasteryRepository. Returns the resulting topicMastery record.
//
// Requires a COMPLETED attempt (completedAt set, totalQuestions > 0) — an
// in-progress attempt isn't evidence of anything yet. Throws rather than
// silently no-op-ing, since calling this on an incomplete attempt is a caller
// bug to fix, not something to swallow quietly.
//
// Lookup is a plain list(userId) + JS filter rather than a new repository
// index, since topicMastery has no compound (userId+courseId+topic) index and
// adding one wasn't asked for here — fine at the scale this runs at, same
// "filter in JS" approach the app already uses for things like course/tag
// counts in DashboardScreen.
export async function updateTopicMasteryFromQuizAttempt(quizAttempt, topic){
  if (!quizAttempt || quizAttempt.completedAt == null) {
    throw new Error("updateTopicMasteryFromQuizAttempt: quizAttempt must be completed (completedAt set).");
  }
  if (!topic) {
    throw new Error("updateTopicMasteryFromQuizAttempt: topic is required.");
  }
  var userId = quizAttempt.userId;
  var courseId = quizAttempt.courseId;

  var existingForUser = await topicMasteryRepository.list(userId);
  var existing = existingForUser.find(function(m){ return m.courseId===courseId && m.topic===topic; }) || null;

  var updatedFields = calculateMasteryUpdate(existing, {
    correctCount: quizAttempt.correctCount,
    totalQuestions: quizAttempt.totalQuestions,
    completedAt: quizAttempt.completedAt,
  });

  if (existing) {
    return topicMasteryRepository.update(existing.id, updatedFields);
  }
  return topicMasteryRepository.create({
    userId: userId,
    courseId: courseId,
    topic: topic,
    ...updatedFields,
  });
}