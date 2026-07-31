importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDisx3nprEfnTvp75xPO9cyBo5x39O6H2k",
  authDomain: "our-nation-22b63.firebaseapp.com",
  projectId: "our-nation-22b63",
  storageBucket: "our-nation-22b63.firebasestorage.app",
  messagingSenderId: "326856301939",
  appId: "1:326856301939:web:456460193c219b02143906"
});

const messaging = firebase.messaging();

// 앱이 백그라운드/종료 상태일 때 푸시 수신
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || '우리들의 나라';
  const body  = payload.notification?.body  || '';

  self.registration.showNotification(title, {
    body,
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    vibrate: [200, 100, 200],
    data:    payload.data || {}
  });
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(cs => {
      if (cs.length > 0) cs[0].focus();
      else clients.openWindow('/');
    })
  );
});
