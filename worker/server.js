const express = require('express');
const EventSource = require('eventsource');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_URL = 'https://our-nation-22b63-default-rtdb.asia-southeast1.firebasedatabase.app';

const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

app.get('/ping', (req, res) => res.send('alive'));
app.get('/', (req, res) => res.send('나라 알림 서버 동작중'));
app.listen(PORT, () => console.log(`서버 시작: 포트 ${PORT}`));

// FCM 토픽에 토큰 구독
async function subscribeToken(token, username) {
  try {
    await admin.messaging().subscribeToTopic([token], 'all');
    await admin.messaging().subscribeToTopic([token], `user_${username}`);
    console.log(`토픽 구독 완료: ${username}`);
  } catch (err) {
    console.error(`토픽 구독 실패 (${username}):`, err.message);
  }
}

// FCM 푸시 전송
async function sendFCM(title, body, topic) {
  try {
    const response = await admin.messaging().send({
      notification: { title, body },
      android: { notification: { sound: 'default', channelId: 'nara-alert' } },
      topic
    });
    console.log('FCM 전송 완료:', topic, response);
  } catch (err) {
    console.error('FCM 전송 실패:', err.message);
  }
}

// 시작 시 기존 FCM 토큰 모두 구독
async function subscribeAllExisting() {
  try {
    const res = await fetch(`${DB_URL}/users.json?shallow=true`);
    const users = await res.json();
    if (!users) return;
    for (const username of Object.keys(users)) {
      const r = await fetch(`${DB_URL}/users/${encodeURIComponent(username)}/fcm_token.json`);
      const token = await r.json();
      if (token && typeof token === 'string') {
        await subscribeToken(token, username);
      }
    }
    console.log('기존 토큰 구독 완료');
  } catch (err) {
    console.error('기존 토큰 구독 실패:', err.message);
  }
}

subscribeAllExisting();

// 새 FCM 토큰 감지 → 토픽 구독
const usersEs = new EventSource(`${DB_URL}/users.json`);
let usersInit = false;
usersEs.addEventListener('put', async (e) => {
  const { path, data } = JSON.parse(e.data);
  if (path === '/') { usersInit = true; return; }
  if (!usersInit || !data) return;

  // path = /username/fcm_token
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'fcm_token' && typeof data === 'string') {
    await subscribeToken(data, parts[0]);
  }
});

// 알림 처리 공통 함수
async function processNotif(channel, notif) {
  if (!notif || typeof notif !== 'object') return;
  console.log('새 알림:', channel, notif.title);
  if (channel.toUpperCase() === 'ALL') {
    await sendFCM(notif.title || '새 알림', notif.body || notif.msg || notif.message || '', 'all');
  } else {
    await sendFCM(notif.title || '새 알림', notif.body || notif.msg || notif.message || '확인하려면 앱을 열어보세요', `user_${channel}`);
  }
}

// 새 알림 감지 → FCM 전송
let notifInit = false;
const notifEs = new EventSource(`${DB_URL}/notifications.json`);

// 모든 SSE 이벤트 raw 로그 (디버그)
const _origAdd = notifEs.addEventListener.bind(notifEs);
notifEs.onmessage = (e) => console.log('[SSE raw]', e.type, e.data?.slice?.(0, 200));

// 단건 put 이벤트 (개인 알림 push)
notifEs.addEventListener('put', async (e) => {
  const parsed = JSON.parse(e.data);
  const { path, data } = parsed;
  console.log('[SSE put] path:', path, '| data keys:', data ? Object.keys(data).slice(0,5) : null);
  if (path === '/') { notifInit = true; console.log('알림 감지 대기중...'); return; }
  if (!notifInit || !data) return;

  const parts = path.split('/').filter(Boolean);
  console.log('[SSE put] parts:', parts);
  if (parts.length < 2) return;

  const channel = parts[0];
  const notif = typeof data === 'object' ? data : null;
  if (!notif) return;

  await processNotif(channel, notif);
});

// 다건 patch 이벤트 (전체 알림 update 배치)
notifEs.addEventListener('patch', async (e) => {
  const parsed = JSON.parse(e.data);
  const { path, data } = parsed;
  console.log('[SSE patch] path:', path, '| data keys:', data ? Object.keys(data).slice(0,5) : null);
  if (!notifInit || !data) return;

  const parts = path.split('/').filter(Boolean);

  if (parts.length === 0) {
    for (const [uid, notifs] of Object.entries(data)) {
      if (typeof notifs !== 'object') continue;
      for (const notif of Object.values(notifs)) {
        await processNotif(uid, notif);
      }
    }
  } else if (parts.length === 1) {
    const channel = parts[0];
    for (const notif of Object.values(data)) {
      await processNotif(channel, notif);
    }
  }
});

notifEs.onerror = () => console.error('알림 DB 연결 오류, 재연결중...');
usersEs.onerror = () => console.error('유저 DB 연결 오류, 재연결중...');
