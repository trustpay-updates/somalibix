
          'YouTube page lama helin (Status: ' +
          pageResponse.status +
          ')'
      });
    }

    const html = await pageResponse.text();

    // =============================================
    // TALLAABO 2: Soo saar INNERTUBE_API_KEY
    // =============================================
    const apiKeyMatch = html.match(
      /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/
    );

    if (!apiKeyMatch || !apiKeyMatch[1]) {
      return res.status(500).json({
        success: false,
        error: 'INNERTUBE_API_KEY lama helin YouTube page-ka'
      });
    }

    const apiKey = apiKeyMatch[1];

    // =============================================
    // TALLAABO 3: Wac YouTube Innertube Player API
    // =============================================
    const playerResponse = await fetch(
      'https://www.youtube.com/youtubei/v1/player?key=' +
        encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'com.google.android.youtube/20.10.38 (Linux; U; Android 13; en_US) gzip',
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
              userAgent:
                'com.google.android.youtube/20.10.38 (Linux; U; Android 13; en_US) gzip'
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
        error:
          'Innertube API failed (Status: ' +
          playerResponse.status +
          ')'
      });
    }

    const playerData = await playerResponse.json();

    if (
      playerData.playabilityStatus &&
      playerData.playabilityStatus.status !== 'OK'
    ) {
      return res.status(403).json({
        success: false,
        error:
          'YouTube: ' +
          (playerData.playabilityStatus.reason ||
            'Video not available')
      });
    }

    // =============================================
    // TALLAABO 4: Soo hel Caption Tracks
    // =============================================
    let captionTracks =
      playerData?.captions
        ?.playerCaptionsTracklistRenderer
        ?.captionTracks;

    // Fallback 1: ka raadi HTML-ga
    if (!captionTracks || captionTracks.length === 0) {
      const htmlCaptionMatch = html.match(
        /"captionTracks"\s*:\s*(\[[^\]]+\])/
      );

      if (htmlCaptionMatch) {
        try {
          captionTracks = JSON.parse(htmlCaptionMatch[1]);
        } catch (parseErr) {
          // Sii wad fallback-ka xiga
        }
      }
    }

    // Fallback 2: ytInitialPlayerResponse
    if (!captionTracks || captionTracks.length === 0) {
      const initMatch = html.match(
        /ytInitialPlayerResponse\s*=\s*(\{.+?\});/
      );

      if (initMatch) {
        try {
          const initData = JSON.parse(initMatch[1]);

          captionTracks =
            initData?.captions
              ?.playerCaptionsTracklistRenderer
              ?.captionTracks;
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
    // TALLAABO 5: Doorashada luuqadda
    // =============================================
    const selectedTrack = selectBestTrack(
      captionTracks,
      lang || 'en'
    );

    if (!selectedTrack) {
      return res.status(404).json({
        success: false,
        error: 'Luuqad ku habboon lama helin',
        availableLanguages: captionTracks.map(function(t) {
          return {
            code: t.languageCode,
            name: t.name?.simpleText || t.languageCode
          };
        })
      });
    }

    // =============================================
    // TALLAABO 6: Soo qaado Captions XML
    // =============================================
    let captionUrl = selectedTrack.baseUrl;

    captionUrl = captionUrl.replace(/&fmt=\w+/g, '');
    captionUrl = captionUrl.replace(/\?fmt=\w+&?/, '?');

    const captionResponse = await fetch(captionUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/xml,application/xml,*/*'
      }
    });

    if (!captionResponse.ok) {
      return res.status(500).json({
        success: false,
        error:
          'Captions XML lama soo dejin karo (Status: ' +
          captionResponse.status +
          ')'
      });
    }

    const xmlText = await captionResponse.text();

    // =============================================
    // TALLAABO 7: Parse XML → Isku dar jumlado
    // =============================================
    const rawCaptions = parseCaptionsXml(xmlText);

    if (rawCaptions.length === 0) {
      return res.status(404).json({
        success: false,
        error:
          'Captions XML waa la helay laakiin wax content ah ma jiro',
        language: selectedTrack.languageCode
      });
    }

    const captions = mergeCaptions(rawCaptions);

    // =============================================
    // TALLAABO 8: Soo celi natiijada
    // =============================================
    return res.status(200).json({
      success: true,
      videoId: videoId,
      language: selectedTrack.languageCode,
      languageName:
        selectedTrack.name?.simpleText ||
        selectedTrack.languageCode,
      isAutoGenerated: selectedTrack.kind === 'asr',
      totalCaptions: captions.length,
      originalCaptionCount: rawCaptions.length,
      duration:
        captions.length > 0
          ? captions[captions.length - 1].endTime
          : 0,
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
      error:
        'Server error: ' +
        (error.message || 'Unknown error'),
      videoId: videoId
    });
  }
}


// =============================================
// FUNCTION: Doorashada Track-ga Ugu Fiican
// =============================================
function selectBestTrack(tracks, preferredLang) {
  if (!tracks || tracks.length === 0) return null;

  // Priority 1: Af-Soomaali
  const somali = tracks.find(function(t) {
    return t.languageCode === 'so';
  });

  if (somali) return somali;

  // Priority 2: Luuqadda la codsaday
  if (
    preferredLang &&
    preferredLang !== 'en' &&
    preferredLang !== 'so'
  ) {
    const pref = tracks.find(function(t) {
      return t.languageCode === preferredLang;
    });

    if (pref) return pref;
  }

  // Priority 3: English manual
  const enManual = tracks.find(function(t) {
    return t.languageCode === 'en' && t.kind !== 'asr';
  });

  if (enManual) return enManual;

  // Priority 4: English auto-generated
  const enAuto = tracks.find(function(t) {
    return t.languageCode === 'en';
  });

  if (enAuto) return enAuto;

  // Priority 5: Luuqadaha Latin-based
  const latinCodes = [
    'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi',
    'pl', 'cs', 'ro', 'hu', 'tr', 'vi', 'id', 'ms', 'tl', 'sw',
    'ha', 'yo', 'ig', 'am', 'om', 'et', 'rw', 'ny', 'sn', 'zu',
    'xh', 'st', 'tn', 'ts', 've', 'nr', 'ss', 'lg', 'ak', 'tw'
  ];

  for (let i = 0; i < latinCodes.length; i++) {
    const latTrack = tracks.find(function(t) {
      return t.languageCode === latinCodes[i];
    });

    if (latTrack) return latTrack;
  }

  // Priority 6: Ka fogow scripts aan Latin ahayn
  const nonLatinCodes = [
    'bn', 'zh', 'ja', 'ko', 'ar', 'hi', 'th', 'ta', 'te', 'kn',
    'ml', 'gu', 'pa', 'mr', 'ur', 'fa', 'he', 'my', 'km', 'lo',
    'si', 'ne', 'sd', 'ps', 'ug', 'yi', 'hy', 'ka', 'mk', 'bg',
    'sr', 'ru', 'uk', 'be', 'kk', 'uz', 'tg', 'ky', 'mn', 'bo',
    'dz', 'chr', 'iu', 'or', 'as', 'bho', 'mai', 'awa', 'hne',
    'raj', 'mag', 'sat', 'doi', 'kok', 'mni', 'bod', 'sin'
  ];

  const safeTracks = tracks.filter(function(t) {
    return nonLatinCodes.indexOf(t.languageCode) === -1;
  });

  if (safeTracks.length > 0) return safeTracks[0];

  return tracks[0];
}


// =============================================
// FUNCTION: Parse YouTube Captions XML → Array
// =============================================
function parseCaptionsXml(xml) {
  const results = [];

  if (!xml || typeof xml !== 'string') return results;

  // YouTube XML format:
  // <text start="0.5" dur="2.3">Hello world</text>

  const regex =
    /<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;

  let match;

  while ((match = regex.exec(xml)) !== null) {
    const startTime = parseFloat(match[1]);
    const tag = match[0];

    const durationMatch = tag.match(/\bdur="([\d.]+)"/);
    const duration = durationMatch
      ? parseFloat(durationMatch[1])
      : 2.0;

    const rawText = match[2];

    const cleanText = decodeEntities(
      rawText
        .replace(/<[^>]+>/g, '')
        .replace(/\n/g, ' ')
        .replace(/\r/g, '')
    )
      .replace(/\s+/g, ' ')
      .trim();

    if (
      cleanText.length > 0 &&
      Number.isFinite(startTime) &&
      Number.isFinite(duration)
    ) {
      results.push({
        startTime: Math.round(startTime * 1000) / 1000,
        endTime:
          Math.round((startTime + duration) * 1000) / 1000,
        text: cleanText
      });
    }
  }

  // Fallback: YouTube JSON3 format
  if (results.length === 0) {
    try {
      const jsonData = JSON.parse(xml);

      if (Array.isArray(jsonData.events)) {
        for (const evt of jsonData.events) {
          if (evt.segs && evt.segs.length > 0) {
            const text = evt.segs
              .map(function(s) {
                return s.utf8 || '';
              })
              .join('')
              .replace(/\s+/g, ' ')
              .trim();

            if (text && text !== '\n') {
              results.push({
                startTime: (evt.tStartMs || 0) / 1000,
                endTime:
                  ((evt.tStartMs || 0) +
                    (evt.dDurationMs || 2000)) /
                  1000,
                text: text
              });
            }
          }
        }
      }
    } catch (jsonErr) {
      // Ma aha JSON sax ah
    }
  }

  return results.sort(function(a, b) {
    return a.startTime - b.startTime;
  });
}


// =============================================
// FUNCTION: Decode HTML/XML Entities
// =============================================
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function(match, hex) {
      return String.fromCodePoint(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function(match, num) {
      return String.fromCodePoint(parseInt(num, 10));
    })
    .replace(/&nbsp;/g, ' ');
}


// =============================================
// FUNCTION: Isku dar captions-ka → jumlado
// =============================================
function mergeCaptions(caps) {
  if (!Array.isArray(caps) || caps.length === 0) {
    return [];
  }

  const output = [];
  let current = null;

  // Xaddidaad si aan captions-ku aad u dheeraan
  const MAX_LENGTH = 180;
  const MAX_DURATION = 12;

  function flush() {
    if (current && current.text.trim()) {
      current.text = current.text.trim();
      output.push(current);
    }

    current = null;
  }

  for (const caption of caps) {
    const text = (caption.text || '').trim();

    if (!text) continue;

    if (!current) {
      current = {
        startTime: caption.startTime,
        endTime: caption.endTime,
        text: text
      };
    } else {
      current.text += ' ' + text;
      current.endTime = Math.max(
        current.endTime,
        caption.endTime
      );
    }

    const sentence = current.text.trim();
    const duration = current.endTime - current.startTime;

    // Jooji marka jumladdu dhammaato.
    // Ha u qaadan Mr. ama Dr. inay yihiin dhammaad jumlad.
    const endsSentence = /[!?]["')\]]?$/.test(sentence) ||
      (/\.$/.test(sentence) && !/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.$/i.test(sentence));

    // Hakadyo macquul ah oo jumlad dheer kala qaybiya
    const endsClause =
      /[,;:]$/.test(sentence) && sentence.length >= 100;

    // Xaddidaadaha badbaadada
    const tooLong = sentence.length >= MAX_LENGTH;
    const tooLongDuration = duration >= MAX_DURATION;

    if (
      endsSentence ||
      endsClause ||
      tooLong ||
      tooLongDuration
    ) {
      flush();
    }
  }

  flush();

  return output;
}


// =============================================
// FUNCTION: Extract Signature Timestamp
// =============================================
function extractSignatureTimestamp(html) {
  if (!html) return undefined;

  const patterns = [
    /signatureTimestamp["']?\s*[:=]\s*(\d+)/,
    /sts["']?\s*[:=]\s*(\d+)/,
    /"sts"\s*:\s*(\d+)/
  ];

  for (let i = 0; i < patterns.length; i++) {
    const match = html.match(patterns[i]);

    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  }

  return undefined;
}
