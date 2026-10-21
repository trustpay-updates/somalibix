export const config = { maxDuration: 60 };

const MODEL = (process.env.AI_MODEL || 'qwen/qwen3.8-max:free').trim();
const BASE = (process.env.AI_BASE_URL || 'https://api.xkiro.com/v1').trim();
const KEEP = ['Play Store', 'Google Play', 'Firebase', 'YouTube', 'Android', 'APK', 'API', 'AI', 'apps', 'app', 'applications', 'application', 'mobile'];

const CH = 30;            // jumladaha chunk kasta
const MAX_AI_CHUNKS = 12; // AI wuxuu qabanayaa CH x 12 = 360 jumladood; inta kale Google
const BUDGET_MS = 46000;  // wadarta waqtiga AI
const TRY_MS = 20000;     // isku day kasta

function sleep(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }

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

  const t0 = Date.now();
  const key = (process.env.XKIRO_API_KEY || '').trim();
  const results = new Array(list.length).fill(null);
  const errs = [];

  try {
    if (key) {
      const jobs = [];
      for (let s = 0, ci = 0; s < list.length && ci < MAX_AI_CHUNKS; s += CH, ci++) {
        jobs.push({ start: s, arr: list.slice(s, s + CH) });
      }
      await Promise.all(jobs.map(async function (j) {
        const out = await aiRobust(key, j.arr, t0, errs);
        out.forEach(function (v, k) { if (v) results[j.start + k] = v; });
      }));
    } else {
      errs.push('XKIRO_API_KEY lama helin (ku dar Vercel + Redeploy)');
    }

    let aiCount = 0;
    const missing = [];
    results.forEach(function (v, i) { if (v) aiCount++; else missing.push(i); });

    if (missing.length) {
      const g = await googleChunk(missing.map(function (i) { return list[i]; }));
      missing.forEach(function (i, k) { results[i] = g[k] || list[i]; });
    }

    return res.status(200).json({
      success: true,
      engine: aiCount ? 'qwen' : 'google',
      qwenError: missing.length
        ? (errs[0] || ('AI waxaa loo isticmaalay ' + (MAX_AI_CHUNKS * CH) + ' jumladood oo hore')) +
          ' (' + missing.length + '/' + list.length + ' Google)'
        : '',
      translations: results
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message || 'error' });
  }
}

function makeOpts(key, payload, ms) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    signal: AbortSignal.timeout(ms),
    body: JSON.stringify(payload)
  };
}

// Dib u isku day: kuwa maqan oo kaliya ayaa dib loo weydiiyaa
async function aiRobust(key, arr, t0, errs) {
  const out = new Array(arr.length).fill(null);
  for (let attempt = 0; attempt < 3; attempt++) {
    const idx = [];
    out.forEach(function (v, i) { if (!v) idx.push(i); });
    if (!idx.length) break;
    const left = BUDGET_MS - (Date.now() - t0);
    if (left < 6000) break;
    try {
      const part = await aiCall(key, idx.map(function (i) { return arr[i]; }), Math.min(TRY_MS, left));
      part.forEach(function (v, k) { if (v) out[idx[k]] = v; });
    } catch (e) {
      console.error('ai attempt failed:', e.message);
      errs.push(e.message);
      await sleep(600 * (attempt + 1));
    }
  }
  return out;
}

async function aiCall(key, lines, timeoutMs) {
  const numbered = lines.map(function (t, i) { return (i + 1) + '|' + t; }).join('\n');
  const prompt =
    'Translate each subtitle line below into natural, simple, spoken Somali (Af-Soomaali). The lines may be in any language.\n' +
    'Keep technical words like app, AI, Android, Play Store, Firebase, API, YouTube in English, as Somali speakers say them.\n' +
    'Keep each translation short, about the same length as the original, so it can be spoken in the same time.\n' +
    'Output EXACTLY ' + lines.length + ' lines, one per input line, in the format N|Somali translation (same number N as the input line).\n' +
    'Output nothing else: no markdown, no explanations, no blank lines.\n\n' +
    numbered;

  const url = BASE + '/chat/completions';
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a translation engine. Output only the numbered lines requested.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 8000,
    reasoning: { enabled: false }
  };

  const deadline = Date.now() + timeoutMs;
  let r = await fetch(url, makeOpts(key, payload, timeoutMs));

  // Haddii xkiro uu diido "reasoning", ku celi isagoon la socon
  if (r.status === 400) {
    const t400 = await r.clone().text();
    if (/reasoning/i.test(t400)) {
      delete payload.reasoning;
      r = await fetch(url, makeOpts(key, payload, Math.max(3000, deadline - Date.now())));
    }
  }

  if (!r.ok) {
    const bt = await r.text();
    let m = bt.slice(0, 150);
    try { const j = JSON.parse(bt); if (j.error) m = (j.error.code || '') + ' ' + (j.error.message || ''); } catch (e) {}
    throw new Error('xkiro HTTP ' + r.status + ': ' + m.slice(0, 120));
  }

  const d = await r.json();
  const txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!txt) throw new Error('jawaab madhan');

  const out = new Array(lines.length).fill(null);
  let got = 0;
  String(txt).replace(/```[a-z]*/gi, '').split('\n').forEach(function (ln) {
    const m = ln.match(/^\s*(\d+)\s*\|\s*(.+?)\s*$/);
    if (!m) return;
    const n = parseInt(m[1], 10) - 1;
    if (n >= 0 && n < out.length && !out[n]) { out[n] = m[2].trim(); got++; }
  });
  if (!got) throw new Error('qaab jawaab khaldan');
  return out;
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
      signal: AbortSignal.timeout(8000),
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
