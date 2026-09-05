// Приймає заявку з форми (zayavka.html) і складає рядком у лист «Заявки»
// тієї ж Google Таблиці. Ті самі env, що й track.js: GOOGLE_SA_EMAIL,
// GOOGLE_SA_KEY, ANALYTICS_SHEET_ID. Без них відповідає ok:false —
// форма покаже «спробуйте ще раз», а не мовчки з'їсть заявку.

const crypto = require('node:crypto');

const SHEET_TAB = 'Заявки';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let tokenCache = { value: '', exp: 0 };

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp > now + 60) return tokenCache.value;
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('no service account env');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600, iat: now,
  }));
  const sig = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(key));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('token: ' + JSON.stringify(data).slice(0, 200));
  tokenCache = { value: data.access_token, exp: now + (data.expires_in || 3600) };
  return tokenCache.value;
}

const clean = (v, n = 120) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);

const cleanCity = (v, n = 40) => {
  const raw = clean(v, 120);
  try { return decodeURIComponent(raw).slice(0, n); } catch (e) { return raw.slice(0, n); }
};

function browserOf(ua) {
  if (/Instagram/i.test(ua)) return 'Instagram (вбудований)';
  if (/Threads/i.test(ua)) return 'Threads (вбудований)';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return 'Facebook (вбудований)';
  if (/CriOS/i.test(ua)) return 'Chrome (iOS)';
  if (/EdgA?\//i.test(ua)) return 'Edge';
  if (/Firefox|FxiOS/i.test(ua)) return 'Firefox';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Safari/i.test(ua)) return 'Safari';
  return '?';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name = clean(body.name, 80);
    const phoneRaw = clean(body.phone, 30);
    const digits = phoneRaw.replace(/\D/g, '');
    // без телефону заявка беззмістовна; 9 цифр — мінімум для укр. номера без коду
    if (digits.length < 9) return res.status(200).json({ ok: false, error: 'phone' });

    const u = body.utm || {};
    const now = new Date();
    const kyiv = new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
    const ua = clean(req.headers['user-agent'], 180);

    const row = [[
      `${kyiv.year}-${kyiv.month}-${kyiv.day} ${kyiv.hour}:${kyiv.minute}:${kyiv.second}`,
      name, "'" + phoneRaw,     // апостроф: щоб Sheets не з'їв «+» і провідні нулі
      clean(u.source, 60), clean(u.medium, 60), clean(u.campaign, 80),
      clean(u.term, 60), clean(u.content, 80),
      clean(req.headers['x-vercel-ip-country'], 8), cleanCity(req.headers['x-vercel-ip-city']),
      browserOf(ua), clean(body.sid, 40),
    ]];

    const id = process.env.ANALYTICS_SHEET_ID;
    const token = await accessToken();
    const range = encodeURIComponent(`${SHEET_TAB}!A:L`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}` +
      `:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: row }),
    });
    if (!r.ok) throw new Error('sheets ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return res.status(200).json({ ok: true });
  } catch (e) {
    // заявку НЕ ковтаємо мовчки: форма скаже «спробуйте ще раз»
    console.error('lead failed:', e.message);
    return res.status(200).json({ ok: false });
  }
};
