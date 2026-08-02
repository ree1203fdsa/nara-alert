const express = require('express');
const EventSource = require('eventsource');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_URL = 'https://our-nation-22b63-default-rtdb.asia-southeast1.firebasedatabase.app';

const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: DB_URL });

const rtdb = admin.database();

app.get('/ping', (req, res) => res.send('alive'));
app.get('/', (req, res) => res.send('나라 알림 서버 동작중'));

// 전송 통계 조회 API
app.get('/stats', async (req, res) => {
  const snap = await rtdb.ref('notification_logs').limitToLast(20).once('value');
  res.json(snap.val() || {});
});

app.listen(PORT, () => {
  console.log(`서버 시작: 포트 ${PORT}`);
  // Render 무료 플랜 슬립 방지 - 10분마다 self-ping
  setInterval(() => {
    fetch(`https://nara-alert-worke.onrender.com/ping`)
      .then(() => console.log('self-ping ok'))
      .catch(e => console.error('self-ping 실패:', e.message));
  }, 10 * 60 * 1000);
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

// FCM 푸시 전송 (실패 시 최대 3번 재시도)
async function sendFCM(title, body, topic, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await admin.messaging().send({
        notification: { title, body },
        android: { notification: { sound: 'default', channelId: 'nara-alert' } },
        topic
      });
      console.log(`FCM 전송 완료 (시도 ${attempt}):`, topic, response);
      return { success: true, response, attempt };
    } catch (err) {
      console.error(`FCM 전송 실패 (시도 ${attempt}/${retries}):`, err.message);
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return { success: false, attempt: retries };
}

// 전송 결과를 Firebase에 기록
async function logResult(channel, notif, result) {
  const log = {
    channel,
    title: notif.title || '',
    msg: notif.msg || '',
    topic: channel.toUpperCase() === 'ALL' ? 'all' : `user_${channel}`,
    success: result.success,
    attempt: result.attempt,
    t: Date.now()
  };
  await rtdb.ref('notification_logs').push(log);
  console.log(`전송 기록 저장: ${log.success ? '✅ 성공' : '❌ 실패'} → ${log.topic} (${log.attempt}번 시도)`);
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
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'fcm_token' && typeof data === 'string') {
    await subscribeToken(data, parts[0]);
  }
});
usersEs.onerror = () => console.error('유저 DB 연결 오류, 재연결중...');

// 알림 처리 공통 함수
async function processNotif(channel, notif) {
  if (!notif || typeof notif !== 'object') return;
  console.log('새 알림 감지:', channel, notif.title);
  const topic = channel.toUpperCase() === 'ALL' ? 'all' : `user_${channel}`;
  const body = notif.body || notif.msg || notif.message || '확인하려면 앱을 열어보세요';
  const result = await sendFCM(notif.title || '새 알림', body, topic);
  await logResult(channel, notif, result);
}

// Firebase Admin SDK 실시간 리스너
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

rtdb.ref('notifications').on('child_added', (snap) => {
  watchUserNotifs(snap.key);
}, (err) => {
  console.error('notifications 감지 오류:', err.message);
});
