export const config = { maxDuration: 60 };

const MODEL = (process.env.AI_MODEL || 'qwen/qwen3.8-max:free').trim();
const BASE = (process.env.AI_BASE_URL || 'https://api.xkiro.com/v1').trim();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST kaliya' });

  const key = (process.env.XKIRO_API_KEY || '').trim();
  if (!key) return res.status(500).json({ success: false, error: 'XKIRO_API_KEY lama helin' });

  let words = req.body && req.body.words;
  if (!Array.isArray(words) || words.length < 5) {
    return res.status(400).json({ success: false, error: 'words maqan' });
  }
  words = words.slice(0, 6000);

  try {
    const CH = 1500;
    const jobs = [];
    for (let i = 0; i < words.length; i += CH) jobs.push(i);

    const parts = await Promise.all(jobs.map(function (start) {
      return segmentChunk(key, words, start, Math.min(start + CH, words.length));
    }));

    let starts = [];
    parts.forEach(function (p) { starts = starts.concat(p); });
    starts.sort(function (a, b) { return a.s - b.s; });

    const clean = [];
    let last = -1;
    starts.forEach(function (x) {
      if (typeof x.s === 'number' && x.s > last && x.s < words.length && x.so) {
        clean.push(x);
        last = x.s;
      }
    });
    if (!clean.length) throw new Error('AI wax ma soo celin');
    if (clean[0].s !== 0) clean[0].s = 0;

    const sentences = clean.map(function (x, i) {
      const st = words[x.s].t;
      const en = i + 1 < clean.length ? words[clean[i + 1].s].t : words[words.length - 1].t + 2;
      return { startTime: st, endTime: en, text: String(x.so).trim() };
    });

    return res.status(200).json({ success: true, total: sentences.length, sentences: sentences });
  } catch (e) {
    console.error('segment error', e);
    return res.status(500).json({ success: false, error: e.message || 'error' });
  }
}

async function segmentChunk(key, words, from, to) {
  const lines = [];
  for (let i = from; i < to; i++) {
    lines.push(i + '|' + words[i].t.toFixed(1) + '|' + words[i].w);
  }

  const prompt =
    'You are segmenting a video transcript for Somali dubbing.\n' +
    'The transcript may be in any language (English, Bengali, Hindi, Arabic, etc).\n' +
    'Each line is: index|start_time_seconds|word.\n\n' +
    'RULES:\n' +
    '1. Make natural spoken phrases of about 8-16 words and 3-6 seconds each (never more than 18 words or 7 seconds). Do NOT split a phrase into tiny pieces of 2-4 words: join short fragments that belong to the same thought, unless the speaker clearly pauses.\n' +
    '2. ALWAYS start a new segment where the speaker pauses: when the time gap between two consecutive words is noticeably bigger than normal (about 0.4s or more), and after . ? ! and at commas between clauses.\n' +
    '3. NEVER join words across a long pause. Shorter is better than longer.\n' +
    '4. Each segment must be understandable on its own.\n' +
    '5. Translate each segment into natural, SHORT Somali that can be spoken in about the same time as the original.\n' +
    '6. Keep technical words like app, AI, Android, Play Store, Firebase, API, YouTube in English.\n' +
    '7. Cover all words in order, starting at index ' + from + '.\n\n' +
    'Return ONLY a JSON array like [{"s":START_INDEX,"so":"Somali text"}]. No explanation, no markdown. "s" is the index of the first word of the segment.\n\n' +
    lines.join('\n');

  const txt = await callAI(key, prompt);
  return parseJsonArray(txt);
}

function makeOpts(key, payload) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    signal: AbortSignal.timeout(55000),
    body: JSON.stringify(payload)
  };
}

async function callAI(key, prompt) {
  const url = BASE + '/chat/completions';
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You output only valid JSON. No markdown, no commentary.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 8000,
    reasoning: { enabled: false }
  };

  let r = await fetchRetry(url, makeOpts(key, payload));

  // Haddii xkiro uu diido "reasoning", ku celi isagoon la socon
  if (r.status === 400) {
    const t400 = await r.clone().text();
    if (/reasoning/i.test(t400)) {
      delete payload.reasoning;
      r = await fetchRetry(url, makeOpts(key, payload));
    }
  }

  if (!r.ok) {
    const t = await r.text();
    let msg = t.slice(0, 200);
    try {
      const j = JSON.parse(t);
      if (j.error) msg = (j.error.code || '') + ' ' + (j.error.message || '');
    } catch (e) {}
    throw new Error('xkiro HTTP ' + r.status + ': ' + msg.slice(0, 160));
  }
  const d = await r.json();
  const txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  if (!txt) throw new Error('AI jawaab madhan');
  return txt;
}

function parseJsonArray(txt) {
  let s = String(txt).replace(/```json|```/gi, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1) throw new Error('JSON array lama helin');
  const arr = JSON.parse(s.slice(a, b + 1));
  return Array.isArray(arr) ? arr : [];
}

async function fetchRetry(url, opts) {
  let r;
  for (let i = 0; i < 2; i++) {
    r = await fetch(url, opts);
    if (r.status !== 429 && r.status !== 503) return r;
    await new Promise(function (ok) { setTimeout(ok, 5000 * (i + 1)); });
  }
  return r;
}
