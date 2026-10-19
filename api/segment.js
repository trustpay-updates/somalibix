export const config = { maxDuration: 60 };

const MODEL = 'gemini-flash-latest';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'POST kaliya' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY lama helin' });

  let words = req.body && req.body.words;
  if (!Array.isArray(words) || words.length < 5) {
    return res.status(400).json({ success: false, error: 'words maqan' });
  }
  words = words.slice(0, 6000);

  try {
    const CH = 300;
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
    'Each line is: index|start_time_seconds|word.\n\n' +
    'RULES:\n' +
    '1. Make SHORT segments, like subtitles: maximum 12 words and maximum 5 seconds each.\n' +
    '2. ALWAYS start a new segment where the speaker pauses: when the time gap between two consecutive words is noticeably bigger than normal (about 0.4s or more), and after . ? ! and at commas between clauses.\n' +
    '3. NEVER join words across a long pause. Shorter is better than longer.\n' +
    '4. Each segment must be understandable on its own.\n' +
    '5. Translate each segment into natural, SHORT Somali that can be spoken in about the same time as the English.\n' +
    '6. Cover all words in order, starting at index ' + from + '.\n\n' +
    'Return ONLY a JSON array like [{"s":START_INDEX,"so":"Somali text"}]. "s" is the index of the first word of the segment.\n\n' +
    lines.join('\n');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json'
      }
    })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error('Gemini ' + r.status + ': ' + t.slice(0, 200));
  }
  const d = await r.json();
  const txt = d.candidates && d.candidates[0] && d.candidates[0].content.parts[0].text;
  const arr = JSON.parse(txt);
  return Array.isArray(arr) ? arr : [];
}
