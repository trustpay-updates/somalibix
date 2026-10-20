export const config = { maxDuration: 60 };

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
    const B = 40, batches = [];
    for (let i = 0; i < list.length; i += B) batches.push(list.slice(i, i + B));

    const out = [];
    for (let i = 0; i < batches.length; i += 5) {
      const group = batches.slice(i, i + 5);
      const res5 = await Promise.all(group.map(translateBatch));
      res5.forEach(function (r) { out.push.apply(out, r); });
    }
    return res.status(200).json({ success: true, translations: out });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'error' });
  }
}

const KEEP = ['Play Store', 'Google Play', 'Firebase', 'YouTube', 'Android', 'APK', 'API', 'AI', 'apps', 'app', 'applications', 'application', 'mobile'];

async function gt(text) {
  let t = text;
  KEEP.forEach(function (w, i) {
    t = t.replace(new RegExp('\\b' + w + '\\b', 'g'), 'Zq' + i + 'z');
  });
  let out = await gtRaw(t);
  KEEP.forEach(function (w, i) {
    out = out.replace(new RegExp('Zq' + i + 'z', 'gi'), w);
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
  // haddii tirada ay isku mid noqon weyday, mid-mid u tarjun
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    try { out.push((await gt(arr[i])).trim()); } catch (e) { out.push(arr[i]); }
  }
  return out;
}
