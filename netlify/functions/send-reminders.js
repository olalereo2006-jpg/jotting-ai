// netlify/functions/send-reminders.js
//
// Runs on a schedule (see netlify.toml) instead of being called by the client — this is
// what makes reminders arrive even when nobody has the app open. It mirrors the same
// eligibility logic the client's in-app checkReminders() effect already uses (kept in
// sync deliberately — if you change one, change the other), but:
//   - reads notifPrefs from Firestore (profiles/{uid}.notifPrefs) instead of localStorage,
//     since it obviously can't see any browser's local storage
//   - tracks "already reminded today" in Firestore instead of localStorage, for the same reason
//   - sends via the Web Push protocol instead of the in-page Notification API
//
// ⚠️ SAME INTEGRATION NOTE AS manage-subscription.js: I don't have your generate.js in
// this project, so this initializes firebase-admin independently (guarded, safe to
// deploy), but if you already have a shared admin-init module, point all three
// functions at it instead of each initializing separately.
//
// Required additions beyond manage-subscription.js's env vars:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — the pair generated for you; the public half
//     is already in App_login.js, set the private half here as a Netlify env var. NEVER
//     put the private key in client code.
//   `web-push` needs to be an installed dependency wherever your functions build from
//     (run `npm install web-push` in that package.json before deploying).
//
// ⏰ TIMEZONE NOTE: Netlify functions run in UTC. Nigeria (WAT) is UTC+1 with no DST, so
// this shifts the "hour" check by +1 to approximate local time for your actual student
// base. If you later have users outside WAT, this stops being accurate for them — real
// per-user timezone handling would need to store each student's timezone and check it
// individually, which this MVP doesn't do.

const admin = require("firebase-admin");
const webpush = require("web-push");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
  });
}
const db = admin.firestore();

webpush.setVapidDetails(
  "mailto:support@jottingai.example", // TODO: swap in a real, monitored contact address
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function dayKey(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}
function isToday(ts) {
  var now = new Date();
  var d = new Date(ts || 0);
  return now.getFullYear() === d.getFullYear() && now.getMonth() === d.getMonth() && now.getDate() === d.getDate();
}

async function sendPush(subDoc, payload) {
  try {
    await webpush.sendNotification(subDoc.subscription, JSON.stringify(payload));
  } catch (e) {
    // 404/410 = the subscription is dead (browser data cleared, permission revoked, etc.)
    if (e.statusCode === 404 || e.statusCode === 410) {
      await db.collection("pushSubscriptions").doc(subDoc._docId).delete().catch(function () {});
    } else {
      console.error("Push send failed for", subDoc._docId, ":", e.message);
    }
  }
}

exports.handler = async function () {
  var subsSnap = await db.collection("pushSubscriptions").get();
  var byUid = {};
  subsSnap.forEach(function (docSnap) {
    var data = docSnap.data();
    if (!data.uid || !data.subscription) return;
    if (!byUid[data.uid]) byUid[data.uid] = [];
    byUid[data.uid].push({ ...data, _docId: docSnap.id });
  });

  var uids = Object.keys(byUid);
  var today = dayKey();
  var hour = new Date(Date.now() + 60 * 60 * 1000).getHours(); // UTC+1 ≈ WAT, see timezone note above

  for (var i = 0; i < uids.length; i++) {
    var uid = uids[i];
    var subs = byUid[uid];

    var profileSnap = await db.collection("profiles").doc(uid).get();
    var profile = profileSnap.exists ? profileSnap.data() : {};
    var notifPrefs = profile.notifPrefs || {};
    var remindersSent = profile.remindersSent || {};
    var newRemindersSent = { ...remindersSent };
    var toSend = [];

    var notesSnap = await db.collection("notes").where("userId", "==", uid).get();
    var notes = notesSnap.docs.map(function (d) { return d.data(); });

    var recordingsSnap = await db.collection("recordings").where("userId", "==", uid).get();
    var recordings = recordingsSnap.docs.map(function (d) { return d.data(); });

    if (notifPrefs.daily && hour >= 19 && remindersSent.daily !== today) {
      var todayCount = notes.filter(function (n) { return isToday(n.id || n.createdAt); }).length;
      if (todayCount < 3) {
        newRemindersSent.daily = today;
        toSend.push({ title: "🎯 Daily goal reminder", body: "You're at " + todayCount + "/3 notes today — a quick session before bed keeps your streak alive." });
      }
    }
    if (notifPrefs.study && hour >= 9 && remindersSent.study !== today) {
      var lastNoteTs = notes.length ? Math.max.apply(null, notes.map(function (n) { return n.id || n.createdAt || 0; })) : 0;
      var daysSince = lastNoteTs ? Math.floor((Date.now() - lastNoteTs) / 86400000) : 999;
      if (daysSince >= 2) {
        newRemindersSent.study = today;
        toSend.push({ title: "📚 Haven't studied in a while", body: "It's been " + daysSince + " days since your last note. Jump back in!" });
      }
    }
    if (notifPrefs.recording && hour >= 9 && remindersSent.recording !== today) {
      var lastRecTs = recordings.length ? Math.max.apply(null, recordings.map(function (r) { return r.createdAt || 0; })) : 0;
      var daysSinceRec = lastRecTs ? Math.floor((Date.now() - lastRecTs) / 86400000) : 999;
      if (daysSinceRec >= 7) {
        newRemindersSent.recording = today;
        toSend.push({ title: "🎙️ Record your next lecture", body: "It's been a while since you recorded a lecture — don't fall behind on notes." });
      }
    }
    if (notifPrefs.assignment && hour >= 9) {
      var assignmentsSnap = await db.collection("assignments").where("userId", "==", uid).where("completed", "==", false).get();
      var today0 = new Date();
      today0.setHours(0, 0, 0, 0);
      for (var j = 0; j < assignmentsSnap.docs.length; j++) {
        var aDoc = assignmentsSnap.docs[j];
        var a = aDoc.data();
        if (!a.dueDate || a.lastRemindedDate === today) continue;
        var due = new Date(a.dueDate + "T00:00:00");
        var daysLeft = Math.round((due.getTime() - today0.getTime()) / 86400000);
        if (daysLeft >= 0 && daysLeft <= 2) {
          await aDoc.ref.update({ lastRemindedDate: today });
          toSend.push({
            title: "📋 Assignment due soon",
            body: "\"" + a.title + "\" (" + a.course + ") is due " + (daysLeft === 0 ? "today" : daysLeft === 1 ? "tomorrow" : "in " + daysLeft + " days") + ".",
          });
        }
      }
    }

    if (JSON.stringify(newRemindersSent) !== JSON.stringify(remindersSent)) {
      await db.collection("profiles").doc(uid).set({ remindersSent: newRemindersSent }, { merge: true });
    }

    for (var k = 0; k < toSend.length; k++) {
      for (var m = 0; m < subs.length; m++) {
        await sendPush(subs[m], { title: toSend[k].title, body: toSend[k].body, url: "/" });
      }
    }
  }

  return { statusCode: 200, body: JSON.stringify({ checked: uids.length }) };
};
