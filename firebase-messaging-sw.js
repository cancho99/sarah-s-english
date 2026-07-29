importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAj45YlZPyJmsDha4p9rqFSjQUdnHeg-PU",
  authDomain: "sarah-s-english.firebaseapp.com",
  projectId: "sarah-s-english",
  storageBucket: "sarah-s-english.firebasestorage.app",
  messagingSenderId: "444699532890",
  appId: "1:444699532890:web:44084cd90d0aa0b5ca0263",
});

const messaging = firebase.messaging();

// Notifications are sent as data-only messages (see notifyTeacher/homeworkReminderCheck in
// functions/index.js) rather than with a `notification` payload, so the browser never displays
// one automatically — this handler is what actually shows it, keeping foreground (onMessage in
// index.html) and background display logic consistent instead of the browser doing its own thing.
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.data || {};
  self.registration.showNotification(title || "Sarah's English", { body: body || "" });
});
