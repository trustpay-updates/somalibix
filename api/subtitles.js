// =============================================
// SomaliBix — YouTube Subtitles Serverless Function
// Faylkan wuxuu ku socdaa Vercel Server-ka
// =============================================

export default async function handler(req, res) {

  // ===== CORS HEADERS =====
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // TALLAABO 1: YouTube page
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

    // TALLAABO 2: INNERTUBE_API_KEY
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);

    if (!apiKeyMatch || !apiKeyMatch[1]) {
      return res.status(500).json({
        success: false,
        error: 'INNERTUBE_API_KEY lama helin YouTube page-ka'
      });
    }

    const apiKey = apiKeyMatch[1];

    // TALLAABO 3: Innertube Player API (Android client)
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

    if (playerData.playabilityStatus && playerData.playabilityStatus.status !== 'OK') {
      return res.status(403).json({
        success: false,
        error: 'YouTube: ' + (playerData.playabilityStatus.reason || 'Video not available')
      });
    }

    // TALLAABO 4: Caption Tracks
    let captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      const htmlCaptionMatch = html.match(/"captionTracks"\s*:\s*(\[[^\]]+\])/);
      if (htmlCaptionMatch) {
        try {
          captionTracks = JSON.parse(htmlCaptionMatch[1]);
        } catch (parseErr) {}
      }
    }

    if (!captionTracks || captionTracks.length === 0) {
      const initMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
      if (initMatch) {
        try {
          const initData = JSON.parse(initMatch[1]);
          captionTracks = initData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        } catch (parseErr) {}
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

    // TALLAABO 5: Dooro luuqadda
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

    // TALLAABO 6: Captions XML
    let captionUrl = selectedTrack.baseUrl;
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

    // TALLAABO 7: Parse + isku dar jumlado
    const rawCaptions = parseCaptionsXml(xmlText);
    const captions = mergeCaptions(rawCaptions);

    if (captions.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Captions XML waa la helay laakiin wax content ah ma jiro',
        language: selectedTrack.languageCode
      });
    }

    // TALLAABO 8: Natiijada
    return res.status(200).json({
      success: true,
      videoId: videoId,
      language: selectedTrack.languageCode,
      languageName: selectedTrack.name?.simpleText || selectedTrack.languageCode,
      isAutoGenerated: selectedTrack.kind === 'asr',
      totalRawCaptions: rawCaptions.length,
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
// FUNCTION: Dooro Track-ga ugu fiican
// =============================================
function selectBestTrack(tracks, preferredLang) {
  if (!tracks || tracks.length === 0) return null;

  var somali = tracks.find(function(t) { return t.languageCode === 'so'; });
  if (somali) return somali;

  if (preferredLang && preferredLang !== 'en' && preferredLang !== 'so') {
    var pref = tracks.find(function(t) { return t.languageCode === preferredLang; });
    if (pref) return pref;
  }

  var enManual = tracks.find(function(t) {
    return t.languageCode === 'en' && t.kind !== 'asr';
  });
  if (enManual) return enManual;

  var enAuto = tracks.find(function(t) { return t.languageCode === 'en'; });
  if (enAuto) return enAuto;

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

  return tracks[0];
}


// =============================================
// FUNCTION: Parse YouTube Captions XML → Array
// =============================================
function parseCaptionsXml(xml) {
  var results = [];

  if (!xml || typeof xml !== 'string') return results;

  var regex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?(?:\s+[^>]*)?>([\s\S]*?)<\/text>/gi;
  var match;

  while ((match = regex.exec(xml)) !== null) {
    var startTime = parseFloat(match[1]);
    var duration = match[2] ? parseFloat(match[2]) : 2.0;
    var rawText = match[3];

    var cleanText = rawText
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, function(m, num) {
        return String.fromCharCode(parseInt(num));
      })
      .replace(/&nbsp;/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\r/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length > 0) {
      results.push({
        startTime: Math.round(startTime * 1000) / 1000,
        endTime: Math.round((startTime + duration) * 1000) / 1000,
        text: cleanText
      });
    }
  }

  if (results.length === 0) {
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
    } catch (jsonErr) {}
  }

  return results;
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


// =============================================
// FUNCTION: Signature Timestamp
// =============================================
function extractSignatureTimestamp(html) {
  if (!html) return undefined;

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
