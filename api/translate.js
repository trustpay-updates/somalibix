export const config = { maxDuration: 60 };

// Erayada Ingiriisiga ah ee aan la tarjumin (codku wuxuu ku akhriyaa Ingiriis).
// Halkan ku dar eray kasta oo aad rabto inuu English ahaado.
const KEEP = [
  'Play Store', 'Google Play', 'App Store', 'Firebase', 'YouTube', 'Android', 'iPhone', 'iOS',
  'APK', 'API', 'AI', 'ChatGPT', 'Gemini', 'Claude', 'Qwen', 'GitHub', 'Vercel',
  'WhatsApp', 'Telegram', 'Facebook', 'TikTok', 'Instagram', 'Google',
  'apps', 'app', 'applications', 'application',
  'models', 'model', 'laptop', 'laptops', 'computer', 'computers', 'PC',
  'mobile', 'smartphone', 'tablet', 'website', 'websites', 'link', 'links',
  'video', 'videos', 'internet', 'email', 'password', 'software', 'hardware',
  'server', 'database', 'code', 'coding', 'prompt', 'prompts', 'tool', 'tools',
  'download', 'upload', 'login', 'online', 'offline', 'screen', 'button', 'template',
  'design', 'update', 'extension', 'browser', 'chatbot', 'bot', 'program', 'programming'
];
const ALIAS = { application: 'app', applications: 'apps' };

const LIST = KEEP.slice().sort(function (a, b) { return b.length - a.length; });
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const RX = LIST.map(function (w) { return new RegExp('\\b' + esc(w) + '\\b', 'gi'); });
const BACK = LIST.map(function (w) { return ALIAS[w.toLowerCase()] || w; });

const HOSTS = ['https://translate.googleapis.com', 'https://translate.google.com'];
const BATCH = 30;
const PARALLEL = 6;

function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

function protect(t) {
  RX.forEach(function (rx, i) { t = t.replace(rx, 'Zq' + i + 'z'); });
  return t;
}
function restore(t) {
  BACK.forEach(function (w, i) {
    t = t.replace(new RegExp('Zq\\s?' + i + '\\s?z', 'gi'), w);
  });
  return t;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST kaliya' });

  const texts = req.body && req.body.texts;
  if (!Array.isArray(texts) || !texts.length) {
    return res.status(400).json({ success: false, error: 'texts maqan' });
  }
  const list = texts.slice(0, 1500).map(function (t) {
    return String(t).replace(/\s*\n\s*/g, ' ').trim();
  });

  try {
    const batches = [];
    for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));

    const stats = { failed: 0 };
    const parts = await pool(batches, PARALLEL, function (b) { return translateBatch(b, stats); });

    const out = [];
    parts.forEach(function (p) { out.push.apply(out, p); });

    return res.status(200).json({
      success: true,
      engine: 'google',
      qwenError: stats.failed
        ? (stats.failed + ' jumladood lama tarjumi karin (qoraalka asalka ayaa la ilaaliyay)')
        : '',
      translations: out
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'error' });
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = [];
  for (let w = 0; w < Math.min(n, items.length); w++) {
    workers.push((async function () {
      while (next < items.length) {
        const k = next++;
        out[k] = await fn(items[k], k);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

async function gtRaw(text) {
  let lastErr;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(
        HOSTS[a % HOSTS.length] + '/translate_a/single?client=gtx&sl=auto&tl=so&dt=t',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(8000),
          body: 'q=' + encodeURIComponent(text)
        }
      );
      if (!r.ok) throw new Error('Translate ' + r.status);
      const d = await r.json();
      return (d[0] || []).map(function (x) { return x[0] || ''; }).join('');
    } catch (e) {
      lastErr = e;
      await sleep(300 * (a + 1));
    }
  }
  throw lastErr;
}

async function gt(text) {
  return restore(await gtRaw(protect(text)));
}

async function translateBatch(arr, stats) {
  // 1) Dhammaan hal mar (degdeg)
  try {
    const parts = (await gt(arr.join('\n'))).split('\n');
    if (parts.length === arr.length) return parts.map(function (s) { return s.trim(); });
  } catch (e) {}
  // 2) Haddii tirada ay is waafaqi weydo, mid-mid isla markiiba (parallel)
  return Promise.all(arr.map(async function (line) {
    try { return (await gt(line)).trim() || line; }
    catch (e) { stats.failed++; return line; }
  }));
}
