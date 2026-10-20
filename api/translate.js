export const config = { maxDuration: 60 };

const MODEL = 'gemini-flash-latest';
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
    const key = process.env.GEMINI_API_KEY;
    const CH = 150;
    const chunks = [];
    for (let i = 0; i < list.length; i += CH) chunks.push(list.slice(i, i + CH));

    let usedGemini = 0;
    const parts = await Promise.all(chunks.map(async function (c, idx) {
      if (key && idx < 4) {
        try {
          const g = await geminiChunk(key, c);
          usedGemini++;
          return g;
        } catch (e) {
          console.error('gemini translate failed:', e.message);
        }
      }
      return googleChunk(c);
    }));

    const out = [];
    parts.forEach(function (p) { out.push.apply(out, p); });
    return res.status(200).json({
      success: true,
      engine: usedGemini ? 'gemini' : 'google',
      translations: out
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'error' });
  }
}

async function geminiChunk(key, arr) {
  const prompt =
    'Translate each English subtitle line below into natural, simple, spoken Somali (Af-Soomaali).\n' +
    'Keep technical words like app, AI, Android, Play Store, Firebase, API, YouTube in English, as Somali speakers say them.\n' +
    'Keep each translation short, about the same length as the English, so it can be spoken in the same time.\n' +
    'Return ONLY a JSON array of strings with EXACTLY ' + arr.length + ' items, in the same order.\n\n' +
    JSON.stringify(arr);

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(35000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
    })
  });
  if (!r.ok) throw new Error('Gemini ' + r.status);
  const d = await r.json();
  const txt = d.candidates && d.candidates[0] && d.candidates[0].content.parts[0].text;
  const out = JSON.parse(txt);
  if (!Array.isArray(out) || out.length !== arr.length) throw new Error('length mismatch');
  return out.map(function (s, i) { return String(s || arr[i]).trim(); });
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
