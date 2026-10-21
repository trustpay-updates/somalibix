export const config = { maxDuration: 60 };

const MODEL = (process.env.AI_MODEL || 'qwen/qwen3.8-max:free').trim();
const BASE = (process.env.AI_BASE_URL || 'https://api.xkiro.com/v1').trim();
const KEEP = ['Play Store', 'Google Play', 'Firebase', 'YouTube', 'Android', 'APK', 'API', 'AI', 'apps', 'app', 'applications', 'application', 'mobile'];

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
    const key = (process.env.XKIRO_API_KEY || '').trim();
    const CH = 40;
    const chunks = [];
    for (let i = 0; i < list.length; i += CH) chunks.push(list.slice(i, i + CH));

    let usedQwen = 0;
    let qwenError = key ? '' : 'XKIRO_API_KEY lama helin (ku dar Vercel + Redeploy)';
    const parts = await Promise.all(chunks.map(async function (c, idx) {
      if (key && idx < 10) {
        try {
          const g = await aiChunk(key, c);
          usedQwen++;
          return g;
        } catch (e) {
          console.error('ai translate failed:', e.message);
          if (!qwenError) qwenError = e.message;
        }
      }
      return googleChunk(c);
    }));

    const out = [];
    parts.forEach(function (p) { out.push.apply(out, p); });
    return res.status(200).json({
      success: true,
      engine: usedQwen ? 'qwen' : 'google',
      qwenError: qwenError,
      translations: out
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'error' });
  }
}

function makeOpts(key, payload) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify(payload)
  };
}

async function aiChunk(key, arr) {
  const prompt =
    'Translate each subtitle line below into natural, simple, spoken Somali (Af-Soomaali). The lines may be in any language.\n' +
    'Keep technical words like app, AI, Android, Play Store, Firebase, API, YouTube in English, as Somali speakers say them.\n' +
    'Keep each translation short, about the same length as the original, so it can be spoken in the same time.\n' +
    'Return ONLY a JSON array of strings with EXACTLY ' + arr.length + ' items, in the same order. No markdown, no explanation.\n\n' +
    JSON.stringify(arr);

  const url = BASE + '/chat/completions';
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You output only valid JSON. No markdown, no commentary.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 4000,
    reasoning: { enabled: false }
  };

  let r = await fetch(url, makeOpts(key, payload));

  // Haddii xkiro uu diido "reasoning", ku celi isagoon la socon
  if (r.status === 400) {
    const t400 = await r.clone().text();
    if (/reasoning/i.test(t400)) {
      delete payload.reasoning;
      r = await fetch(url, makeOpts(key, payload));
    }
  }

  if (!r.ok) {
    const bt = await r.text();
    let m = bt.slice(0, 150);
    try { const j = JSON.parse(bt); if (j.error) m = (j.error.code || '') + ' ' + (j.error.message || ''); } catch (e) {}
    throw new Error('xkiro HTTP ' + r.status + ': ' + m.slice(0, 150));
  }
  const d = await r.json();
  const txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!txt) throw new Error('empty');

  const s = String(txt).replace(/```json|```/gi, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1) throw new Error('no array');
  const out = JSON.parse(s.slice(a, b + 1));
  if (!Array.isArray(out) || out.length !== arr.length) throw new Error('length mismatch');
  return out.map(function (x, i) { return String(x || arr[i]).trim(); });
}

async function googleChunk(arr) {
  const B = 40, batches = [];
  for (let i = 0; i < arr.length; i += B) batches.push(arr.slice(i, i + B));
  const res = await Promise.all(batches.map(translateBatch));
  const out = [];
  res.forEach(function (r) { out.push.apply(out, r); });
  return out;
}

async function gt(text) {
  let t = text;
  KEEP.forEach(function (w, i) {
    t = t.replace(new RegExp('\\b' + w + '\\b', 'g'), 'Zq' + i + 'z');
  });
  let out = await gtRaw(t);
  KEEP.forEach(function (w, i) {
    const back = w === 'application' ? 'app' : (w === 'applications' ? 'apps' : w);
    out = out.replace(new RegExp('Zq' + i + 'z', 'gi'), back);
  });
  return out;
}

async function gtRaw(text) {
  const r = await fetch(
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=so&dt=t',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'q=' + encodeURIComponent(text)
    }
  );
  if (!r.ok) throw new Error('Translate ' + r.status);
  const d = await r.json();
  return (d[0] || []).map(function (x) { return x[0] || ''; }).join('');
}

async function translateBatch(arr) {
  try {
    const parts = (await gt(arr.join('\n'))).split('\n');
    if (parts.length === arr.length) return parts.map(function (s) { return s.trim(); });
  } catch (e) {}
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    try { out.push((await gt(arr[i])).trim()); } catch (e) { out.push(arr[i]); }
  }
  return out;
}
