// =============================================
// SomaliBix — YouTube Subtitles Serverless Function
// Faylkan wuxuu ku socdaa Vercel Server-ka
// CORS ma jiro — Server-to-Server request
// =============================================

export default async function handler(req, res) {

  // ===== CORS HEADERS =====
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ===== GET VIDEO ID =====
  const { videoId, lang } = req.query;

  if (!videoId || typeof videoId !== 'string' || videoId.length !== 11) {
    return res.status(400).json({
      success: false,
      error: 'videoId waa inuu ahaadaa 11 xaraf (YouTube Video ID)'
    });
  }

  try {

    // =============================================
    // TALLAABO 1: Ka soo qaado YouTube page-ka
    // Si aan u helno INNERTUBE_API_KEY
    // =============================================
    const pageResponse = await fetch(
      'https://www.youtube.com/watch?v=' + videoId,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow'
      }
    );

    if (!pageResponse.ok) {
      return res.status(404).json({
        success: false,
        error: 'YouTube page lama helin (Status: ' + pageResponse.status + ')'
      });
    }

    const html = await pageResponse.text();

    // =============================================
    // TALLAABO 2: Ka soo saar INNERTUBE_API_KEY
    // =============================================
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);

    if (!apiKeyMatch || !apiKeyMatch[1]) {
      return res.status(500).json({
        success: false,
        error: 'INNERTUBE_API_KEY lama helin YouTube page-ka'
      });
    }

    const apiKey = apiKeyMatch[1];

    // =============================================
    // TALLAABO 3: Wac YouTube Innertube Player API
    // Android client ahaan (si captions loo helo)
    // =============================================
    const playerResponse = await fetch(
      'https://www.youtube.com/youtubei/v1/player?key=' + apiKey,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 13; en_US) gzip',
          'X-YouTube-Client-Name': '3',
          'X-YouTube-Client-Version': '20.10.38'
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: '20.10.38',
              hl: 'en',
              gl: 'US',
              userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 13; en_US) gzip'
            }
          },
          videoId: videoId,
          playbackContext: {
            contentPlaybackContext: {
              signatureTimestamp: extractSignatureTimestamp(html)
            }
          }
        })
      }
    );

    if (!playerResponse.ok) {
      return res.status(500).json({
        success: false,
        error: 'Innertube API failed (Status: ' + playerResponse.status + ')'
      });
    }

    const playerData = await playerResponse.json();

    // Check for YouTube errors
    if (playerData.playabilityStatus && playerData.playabilityStatus.status !== 'OK') {
      return res.status(403).json({
        success: false,
        error: 'YouTube: ' + (playerData.playabilityStatus.reason || 'Video not available')
      });
    }

    // =============================================
    // TALLAABO 4: Ka hel Caption Tracks
    // =============================================
    let captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    // Fallback: ka raadi HTML-ga
    if (!captionTracks || captionTracks.length === 0) {
      const htmlCaptionMatch = html.match(/"captionTracks"\s*:\s*(\[[^\]]+\])/);
      if (htmlCaptionMatch) {
        try {
          captionTracks = JSON.parse(htmlCaptionMatch[1]);
        } catch (parseErr) {
          // Continue without tracks
        }
      }
    }

    // Fallback 2: ka raadi ytInitialPlayerResponse
    if (!captionTracks || captionTracks.length === 0) {
      const initMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
      if (initMatch) {
        try {
          const initData = JSON.parse(initMatch[1]);
          captionTracks = initData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        } catch (parseErr) {
          // Continue
        }
      }
    }

    if (!captionTracks || captionTracks.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Video-gan ma laha subtitles/captions',
        videoId: videoId,
        availableLanguages: []
      });
    }

    // =============================================
    // TALLAABO 5: Doorashada Luuqadda Saxda Ah
    // Priority: so → en (manual) → en (auto) → Latin → safe
    // Marna ha dooran: Bengali, Chinese, Arabic, Hindi...
    // =============================================
    const selectedTrack = selectBestTrack(captionTracks, lang || 'en');

    if (!selectedTrack) {
      return res.status(404).json({
        success: false,
        error: 'Luuqad ku habboon lama helin',
        availableLanguages: captionTracks.map(function(t) {
          return { code: t.languageCode, name: t.name?.simpleText || t.languageCode };
        })
      });
    }

    // =============================================
    // TALLAABO 6: Soo qaado Captions XML-ka
    // =============================================
    let captionUrl = selectedTrack.baseUrl;

    // Remove format parameter to get clean XML
    captionUrl = captionUrl.replace(/&fmt=\w+/g, '');
    captionUrl = captionUrl.replace(/\?fmt=\w+&?/, '?');

    const captionResponse = await fetch(captionUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/xml,application/xml,*/*'
      }
    });

    if (!captionResponse.ok) {
      return res.status(500).json({
        success: false,
        error: 'Captions XML lama soo dejin karo (Status: ' + captionResponse.status + ')'
      });
    }

    const xmlText = await captionResponse.text();

    // =============================================
    // TALLAABO 7: Parse XML → JSON Array
    // =============================================
    const rawCaptions = parseCaptionsXml(xmlText);
    const captions = mergeCaptions(rawCaptions);

    if (captions.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Captions XML waa la helay laakiin wax content ah ma jiro',
        language: selectedTrack.languageCode
      });
    }

    // =============================================
    // TALLAABO 8: Dib u celi Result-ga
    // =============================================
    return res.status(200).json({
      success: true,
      videoId: videoId,
      language: selectedTrack.languageCode,
      languageName: selectedTrack.name?.simpleText || selectedTrack.languageCode,
      isAutoGenerated: selectedTrack.kind === 'asr',
      totalCaptions: captions.length,
      duration: captions.length > 0 ? captions[captions.length - 1].endTime : 0,
      captions: captions,
      allAvailableLanguages: captionTracks.map(function(t) {
        return {
          code: t.languageCode,
          name: t.name?.simpleText || t.languageCode,
          isAuto: t.kind === 'asr'
        };
      })
    });

  } catch (error) {
    console.error('SomaliBix Subtitle Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Server error: ' + (error.message || 'Unknown error'),
      videoId: videoId
    });
  }
}


// =============================================
// FUNCTION: Doorashada Track-ga Ugu Fiican
// =============================================
function selectBestTrack(tracks, preferredLang) {
  if (!tracks || tracks.length === 0) return null;

  // Priority 1: Af-Soomaali (so)
  var somali = tracks.find(function(t) { return t.languageCode === 'so'; });
  if (somali) return somali;

  // Priority 2: Luuqadda la rabay (haddii aan ahayn 'en')
  if (preferredLang && preferredLang !== 'en' && preferredLang !== 'so') {
    var pref = tracks.find(function(t) { return t.languageCode === preferredLang; });
    if (pref) return pref;
  }

  // Priority 3: English manual (aan ahayn auto-generated)
  var enManual = tracks.find(function(t) {
    return t.languageCode === 'en' && t.kind !== 'asr';
  });
  if (enManual) return enManual;

  // Priority 4: English auto-generated
  var enAuto = tracks.find(function(t) { return t.languageCode === 'en'; });
  if (enAuto) return enAuto;

  // Priority 5: Luuqadaha Latin-based (la aqrin karo)
  var latinCodes = [
    'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi',
    'pl', 'cs', 'ro', 'hu', 'tr', 'vi', 'id', 'ms', 'tl', 'sw',
    'ha', 'yo', 'ig', 'am', 'om', 'et', 'rw', 'ny', 'sn', 'zu',
    'xh', 'st', 'tn', 'ts', 've', 'nr', 'ss', 'lg', 'ak', 'tw'
  ];

  for (var i = 0; i < latinCodes.length; i++) {
    var latTrack = tracks.find(function(t) { return t.languageCode === latinCodes[i]; });
    if (latTrack) return latTrack;
  }

  // Priority 6: Filter OUT non-Latin scripts
  var nonLatinCodes = [
    'bn', 'zh', 'ja', 'ko', 'ar', 'hi', 'th', 'ta', 'te', 'kn',
    'ml', 'gu', 'pa', 'mr', 'ur', 'fa', 'he', 'my', 'km', 'lo',
    'si', 'ne', 'sd', 'ps', 'ug', 'yi', 'hy', 'ka', 'mk', 'bg',
    'sr', 'ru', 'uk', 'be', 'kk', 'uz', 'tg', 'ky', 'mn', 'bo',
    'dz', 'chr', 'iu', 'or', 'as', 'bho', 'mai', 'awa', 'hne',
    'raj', 'mag', 'sat', 'doi', 'kok', 'mni', 'bod', 'sin'
  ];

  var safeTracks = tracks.filter(function(t) {
    return nonLatinCodes.indexOf(t.languageCode) === -1;
  });

  if (safeTracks.length > 0) return safeTracks[0];

  // Last resort: track-kii ugu horreeyay
  return tracks[0];
}


// =============================================
// FUNCTION: Parse YouTube Captions XML → Array
// =============================================
function parseCaptionsXml(xml) {
  var results = [];

  if (!xml || typeof xml !== 'string') return results;

  // YouTube XML format:
  // <text start="0.5" dur="2.3">Hello world</text>
  // <text start="2.8" dur="1.5" t="1">Next line</text>

  var regex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?(?:\s+[^>]*)?>([\s\S]*?)<\/text>/gi;
  var match;

  while ((match = regex.exec(xml)) !== null) {
    var startTime = parseFloat(match[1]);
    var duration = match[2] ? parseFloat(match[2]) : 2.0;
    var rawText = match[3];

    // Clean HTML entities and tags
    var cleanText = rawText
      .replace(/<[^>]+>/g, '')           // Remove HTML tags
      .replace(/&amp;/g, '&')            // &amp; → &
      .replace(/&lt;/g, '<')             // &lt; → <
      .replace(/&gt;/g, '>')             // &gt; → >
      .replace(/&#39;/g, "'")            // &#39; → '
      .replace(/&apos;/g, "'")           // &apos; → '
      .replace(/&quot;/g, '"')           // &quot; → "
      .replace(/&#(\d+);/g, function(m, num) {  // Numeric entities
        return String.fromCharCode(parseInt(num));
      })
      .replace(/&nbsp;/g, ' ')           // &nbsp; → space
      .replace(/\n/g, ' ')               // Newlines → space
      .replace(/\r/g, '')                // Remove carriage returns
      .replace(/\s+/g, ' ')              // Multiple spaces → single
      .trim();

    // Skip empty captions
    if (cleanText.length > 0) {
      results.push({
        startTime: Math.round(startTime * 1000) / 1000,
        endTime: Math.round((startTime + duration) * 1000) / 1000,
        text: cleanText
      });
    }
  }

  // If regex didn't match, try alternative format (JSON3 or srv3)
  if (results.length === 0) {
    // Try parsing as JSON (sometimes YouTube returns JSON)
    try {
      var jsonData = JSON.parse(xml);
      if (jsonData.events) {
        for (var i = 0; i < jsonData.events.length; i++) {
          var evt = jsonData.events[i];
          if (evt.segs && evt.segs.length > 0) {
            var text = evt.segs.map(function(s) { return s.utf8 || ''; }).join('').trim();
            if (text && text !== '\n') {
              results.push({
                startTime: (evt.tStartMs || 0) / 1000,
                endTime: ((evt.tStartMs || 0) + (evt.dDurationMs || 2000)) / 1000,
                text: text.replace(/\n/g, ' ').trim()
              });
            }
          }
        }
      }
    } catch (jsonErr) {
      // Not JSON, ignore
    }
  }

  return results;
}


// =============================================
// FUNCTION: Extract Signature Timestamp
// (Helps with video playback authorization)
// =============================================
function extractSignatureTimestamp(html) {
  if (!html) return undefined;

  // Try multiple patterns
  var patterns = [
    /signatureTimestamp["']?\s*[:=]\s*(\d+)/,
    /sts["']?\s*[:=]\s*(\d+)/,
    /"sts"\s*:\s*(\d+)/
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = html.match(patterns[i]);
    if (match && match[1]) {
      return parseInt(match[1]);
    }
  }

  return undefined;
      }
      // =============================================
// FUNCTION: Isku dar jajabyada captions → jumlado
// =============================================
function mergeCaptions(caps) {
  if (!caps || caps.length === 0) return caps;
  var out = [];
  var cur = null;

  function flush() {
    if (cur) { out.push(cur); cur = null; }
  }

  for (var i = 0; i < caps.length; i++) {
    var c = caps[i];
    if (!cur) {
      cur = { startTime: c.startTime, endTime: c.endTime, text: c.text };
    } else {
      cur.text = cur.text + ' ' + c.text;
      cur.endTime = c.endTime;
    }

    var t = cur.text;
    var len = t.length;
    var dur = cur.endTime - cur.startTime;
    var endsSentence = /[.?!]["')\]]?$/.test(t);
    var endsClause = /[,;:]$/.test(t) && len >= 60;

    if (endsSentence || endsClause || len >= 120 || dur >= 8) {
      flush();
    }
  }
  flush();
  return out;
  }
