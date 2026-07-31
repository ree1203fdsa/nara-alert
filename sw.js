const CACHE_NAME = 'nara-alert-v1';
const DB_URL = 'https://our-nation-22b63-default-rtdb.asia-southeast1.firebasedatabase.app';
const CHECK_INTERVAL = 30000; // 30초마다 체크

// 마지막으로 본 알림 타임스탬프 추적
let lastSeenTimestamp = Date.now();
let username = null;
let checkTimer = null;

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// 메인 페이지에서 메시지 수신
self.addEventListener('message', (e) => {
  if (e.data.type === 'SET_USER') {
    username = e.data.username;
    lastSeenTimestamp = e.data.timestamp || Date.now();
    startPolling();
  }
  if (e.data.type === 'STOP_POLLING') {
    stopPolling();
  }
  if (e.data.type === 'UPDATE_TIMESTAMP') {
    lastSeenTimestamp = e.data.timestamp;
  }
});

function startPolling() {
  stopPolling();
  checkTimer = setInterval(checkForNewNotifications, CHECK_INTERVAL);
}

function stopPolling() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

async function checkForNewNotifications() {
  // 열려있는 클라이언트가 있으면 메인 페이지가 처리하므로 스킵
  const allClients = await clients.matchAll({ type: 'window' });
  if (allClients.length > 0) return;

  try {
    const paths = ['ALL'];
    if (username) paths.push(encodeURIComponent(username));

    for (const path of paths) {
      const url = `${DB_URL}/notifications/${path}.json?orderBy="t"&startAt=${lastSeenTimestamp + 1}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) {
          const n = data[key];
          if (n && n.t > lastSeenTimestamp) {
            lastSeenTimestamp = n.t;
            await showNotification(n);
          }
        }
      }
    }
  } catch (err) {
    console.error('[SW] 알림 확인 오류:', err);
  }
}

async function showNotification(n) {
  const title = n.title || '우리들의 나라';
  const body = n.msg || '';
  const tag = `nara-${n.t}`;

  const icon = getTypeIcon(n.type);

  await self.registration.showNotification(title, {
    body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag,
    data: { type: n.type, t: n.t },
    requireInteraction: false,
    vibrate: [200, 100, 200],
  });
}

function getTypeIcon(type) {
  return 'icon-192.png';
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then((cs) => {
      if (cs.length > 0) {
        cs[0].focus();
      } else {
        clients.openWindow('/');
      }
    })
  );
});
