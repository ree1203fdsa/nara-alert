const express = require('express');
const EventSource = require('eventsource');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

const DB_URL = 'https://our-nation-22b63-default-rtdb.asia-southeast1.firebasedatabase.app';

// 서비스 계정 JSON (환경변수로 설정)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

app.get('/ping', (req, res) => res.send('alive'));
app.get('/', (req, res) => res.send('나라 알림 서버 동작중'));
app.listen(PORT, () => console.log(`서버 시작: 포트 ${PORT}`));

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

let initialized = false;
const dbAuthParam = process.env.DB_SECRET ? `?auth=${process.env.DB_SECRET}` : '';
const es = new EventSource(`${DB_URL}/notifications.json${dbAuthParam}`);

es.addEventListener('put', async (e) => {
  const parsed = JSON.parse(e.data);
  const path = parsed.path;
  const data = parsed.data;

  if (path === '/') {
    initialized = true;
    console.log('DB 연결 완료, 알림 대기중...');
    return;
  }

  if (!initialized || !data) return;

  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return;

  const channel = parts[0];
  const notif = typeof data === 'object' ? data : null;
  if (!notif) return;

  console.log('새 알림 감지:', channel, notif.title || notif.message);

  if (channel === 'all') {
    await sendFCM(
      notif.title || '새 알림',
      notif.body || notif.message || '새 알림이 도착했습니다',
      'all'
    );
  } else {
    await sendFCM('새 개인 알림', '확인하려면 앱을 열어보세요', `user_${channel}`);
  }
});

es.onerror = () => console.error('DB 연결 오류, 재연결 시도중...');
