// Аналітика лендінга: складає події сеансу рядками в Google Таблицю (лист «События»).
// Вмикається трьома env: GOOGLE_SA_EMAIL, GOOGLE_SA_KEY, ANALYTICS_SHEET_ID.
// Без них — тихо відповідає ok:true, сторінка працює як раніше.
// CommonJS навмисно: репозиторій статичний, без package.json.

const crypto = require('node:crypto');

const SHEET_TAB = 'События';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let tokenCache = { value: '', exp: 0 };

const b64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp > now + 60) return tokenCache.value;

  const email = process.env.GOOGLE_SA_EMAIL;
  // у Vercel приватний ключ зберігається одним рядком — повертаємо переноси
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

async function appendRows(rows) {
  const id = process.env.ANALYTICS_SHEET_ID;
  const token = await accessToken();
  const range = encodeURIComponent(`${SHEET_TAB}!A:T`);
  // OVERWRITE, не INSERT_ROWS: вставка рядків зсуває діапазони у формулах
  // на листах «Сеансы» і «Сводка», і зведення перестає бачити свіжі події.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}` +
    `:append?valueInputOption=USER_ENTERED&insertDataOption=OVERWRITE`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!r.ok) throw new Error('sheets ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

const clean = (v, n = 120) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').slice(0, n);

// Вбудований браузер Instagram/Facebook — окремою колонкою: у ньому конверсія
// зазвичай нижча, і без цього розрізу цього не видно. Порядок перевірок
// важливий: рядок вбудованого браузера теж містить Safari та Chrome.
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

// Vercel віддає місто percent-кодуванням: «Sofiivska%20Borschahivka».
// У таблиці це читати неможливо, тож розкодовуємо.
const cleanCity = (v, n = 40) => {
  const raw = clean(v, 120);
  try { return decodeURIComponent(raw).slice(0, n); } catch (e) { return raw.slice(0, n); }
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const on = process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_KEY && process.env.ANALYTICS_SHEET_ID;
  if (!on) return res.status(200).json({ ok: true, stored: false });

  try {
    // sendBeacon шле Blob — тіло може прийти рядком
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const events = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
    if (!events.length) return res.status(200).json({ ok: true, stored: false });

    // Фільтр краулерів Meta: після запуску реклами Facebook сканує оголошення
    // ботами з США/Швеції/Ірландії — рівні короткі «сеанси», клік по кнопках.
    // Реклама йде лише на Україну, тож закордонний трафік З РЕКЛАМНОГО посилання —
    // бот. Органіка з-за кордону проходить: у неї немає utm_source=fb.
    const country = clean(req.headers['x-vercel-ip-country'], 8);
    const ref = clean(body.ref, 120);
    const url = String(body.url || '');
    const adTraffic = /utm_source=(fb|facebook|ig|instagram)/i.test(url) || /facebook\.com|fb\.com/i.test(ref);
    if (country && country !== 'UA' && adTraffic) {
      return res.status(200).json({ ok: true, stored: false, bot: true });
    }

    const now = new Date();
    const kyiv = new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
    const date = `${kyiv.year}-${kyiv.month}-${kyiv.day}`;
    const time = `${kyiv.hour}:${kyiv.minute}:${kyiv.second}`;

    const city = cleanCity(req.headers['x-vercel-ip-city']);
    const ua = clean(req.headers['user-agent'], 180);

    const sid = clean(body.sid, 40);
    const dev = clean(body.dev, 10);
    const os = clean(body.os, 12);
    const u = body.utm || {};

    const rows = events.map(e => ([
      `${date} ${time}`, date, sid,
      clean(e.ev, 30), clean(e.meta, 120),
      Number(e.t) || 0, Number(e.ta) || 0,
      clean(u.source, 60), clean(u.medium, 60), clean(u.campaign, 80),
      clean(u.content, 80), clean(u.term, 60),
      dev, os, country, city, ref, clean(url, 300), ua, browserOf(ua),
    ]));

    await appendRows(rows);
    return res.status(200).json({ ok: true, stored: true, rows: rows.length });
  } catch (e) {
    // аналітика ніколи не ламає сторінку — тільки лог
    console.error('track failed:', e.message);
    return res.status(200).json({ ok: true, stored: false });
  }
};
