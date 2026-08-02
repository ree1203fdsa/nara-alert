const express = require('express');
const EventSource = require('eventsource');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_URL = 'https://our-nation-22b63-default-rtdb.asia-southeast1.firebasedatabase.app';

const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: DB_URL });

app.get('/ping', (req, res) => res.send('alive'));
app.get('/', (req, res) => res.send('나라 알림 서버 동작중'));
app.listen(PORT, () => {
  console.log(`서버 시작: 포트 ${PORT}`);
  // Render 무료 플랜 슬립 방지 - 14분마다 자기 자신 ping
  setInterval(() => {
    fetch(`https://nara-alert-worke.onrender.com/ping`)
      .then(() => console.log('self-ping ok'))
      .catch(e => console.error('self-ping 실패:', e.message));
  }, 14 * 60 * 1000);
});

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

// Firebase Admin SDK로 새 알림 감지 (SSE 대신 안정적인 실시간 리스너)
const rtdb = admin.database();
const startTime = Date.now();

console.log('알림 감지 대기중...');

function watchUserNotifs(uid) {
  rtdb.ref(`notifications/${uid}`)
    .orderByChild('t')
    .startAt(startTime)
    .on('child_added', async (snap) => {
      const notif = snap.val();
      if (!notif) return;
      await processNotif(uid, notif);
    }, (err) => {
      console.error(`알림 리스너 오류 (${uid}):`, err.message);
    });
}

// notifications/ 아래 유저 경로가 추가될 때마다 리스너 등록
rtdb.ref('notifications').on('child_added', (snap) => {
  watchUserNotifs(snap.key);
}, (err) => {
  console.error('notifications 감지 오류:', err.message);
});

usersEs.onerror = () => console.error('유저 DB 연결 오류, 재연결중...');
