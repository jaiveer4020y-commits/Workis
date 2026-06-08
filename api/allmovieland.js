// api/allmovieland.js

// Known domains (update periodically)
const KNOWN_DOMAINS = [
  'https://gemma416okl.com',
  'https://keymi417exx.com',
  'https://allmovieland.cfd',
  'https://allmovieland.rest'
];

async function getStreamingDomain() {
  const playerJsUrl = 'https://allmovieland.link/player.js?v=60%20128';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    'Cache-Control': 'max-age=0',
    'Host': 'allmovieland.link',
    'Connection': 'Keep-Alive',
    'Accept-Encoding': 'gzip'
  };
  try {
    const response = await fetch(playerJsUrl, { headers });
    const scriptText = await response.text();
    const patterns = [
      /const\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
      /let\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
      /var\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
      /AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
      /https?:\/\/[a-z0-9]+\.(com|net|cfd|rest)\/play/
    ];
    for (const pattern of patterns) {
      const match = scriptText.match(pattern);
      if (match) {
        let domain = match[1];
        if (!domain.startsWith('http')) domain = 'https://' + domain;
        return domain;
      }
    }
  } catch (e) {
    console.error('getStreamingDomain error:', e.message);
  }
  return null;
}

async function testDomain(domain, id, season, episode) {
  let url = `${domain}/play/${id}`;
  if (season && episode) url += `/s${season}-e${episode}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://allmovieland.one/',
    'Host': new URL(domain).hostname
  };
  try {
    // Use GET because some servers block HEAD
    const res = await fetch(url, { method: 'GET', headers });
    return { ok: res.ok, status: res.status, url };
  } catch (err) {
    return { ok: false, status: 0, url, error: err.message };
  }
}

function extractP3Object(html) {
  const patterns = [
    /let p3 = (\{[^;]+\});/,
    /var p3 = (\{[^;]+\});/,
    /const p3 = (\{[^;]+\});/,
    /window\.p3 = (\{[^;]+\});/
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {}
    }
  }
  return null;
}

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { id, season, episode, debug } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });
  if (season) season = parseInt(season);
  if (episode) episode = parseInt(episode);

  const debugLog = []; // collect debug messages

  try {
    // Step 1: get extracted domain
    const extracted = await getStreamingDomain();
    debugLog.push(`Extracted from player.js: ${extracted || 'none'}`);
    let candidates = extracted ? [extracted, ...KNOWN_DOMAINS] : [...KNOWN_DOMAINS];
    candidates = [...new Set(candidates)];
    debugLog.push(`Candidates: ${candidates.join(', ')}`);

    let workingDomain = null;
    let domainTestResults = [];
    for (const domain of candidates) {
      const result = await testDomain(domain, id, season, episode);
      domainTestResults.push(result);
      debugLog.push(`Test ${domain} -> status ${result.status} ${result.ok ? 'OK' : 'FAIL'}`);
      if (result.ok) {
        workingDomain = domain;
        break;
      }
    }

    if (!workingDomain) {
      // Return detailed debug info
      return res.status(404).json({
        error: 'No working domain found for this ID',
        debug: {
          id,
          season,
          episode,
          candidates_tested: domainTestResults,
          logs: debugLog
        }
      });
    }

    debugLog.push(`✅ Using domain: ${workingDomain}`);

    // Step 2: fetch movie page
    let pageUrl = `${workingDomain}/play/${id}`;
    if (season && episode) pageUrl += `/s${season}-e${episode}`;
    const pageHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://allmovieland.one/',
      'Host': new URL(workingDomain).hostname
    };
    const pageRes = await fetch(pageUrl, { headers: pageHeaders });
    if (!pageRes.ok) {
      return res.status(500).json({
        error: `Movie page returned ${pageRes.status}`,
        debug: { url: pageUrl, status: pageRes.status, logs: debugLog }
      });
    }
    const html = await pageRes.text();
    debugLog.push(`Movie page fetched (${html.length} bytes)`);

    // Step 3: extract p3
    const p3 = extractP3Object(html);
    if (!p3) {
      return res.status(500).json({
        error: 'Could not extract p3 object from page',
        debug: { html_preview: html.substring(0, 500), logs: debugLog }
      });
    }
    debugLog.push('p3 object extracted');

    // Step 4: get language list
    let langUrl = p3.file;
    if (langUrl.startsWith('/playlist')) {
      langUrl = workingDomain + langUrl;
    } else if (!langUrl.startsWith('http')) {
      langUrl = workingDomain + '/playlist/' + langUrl;
    }
    const langHeaders = {
      'X-CSRF-TOKEN': p3.key,
      'Referer': 'https://allmovieland.link/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    const langRes = await fetch(langUrl, { headers: langHeaders });
    if (!langRes.ok) {
      return res.status(500).json({
        error: `Language list request failed: ${langRes.status}`,
        debug: { url: langUrl, status: langRes.status, logs: debugLog }
      });
    }
    const languages = await langRes.json();
    debugLog.push(`Languages: ${languages.map(l => l.title).join(', ')}`);

    // Step 5: process streams
    const streams = [];
    for (const lang of languages) {
      if (lang.file && lang.file !== '-') {
        let streamUrl = lang.file;
        if (streamUrl.startsWith('/playlist')) {
          streamUrl = workingDomain + streamUrl;
        } else if (streamUrl.startsWith('~')) {
          streamUrl = workingDomain + '/playlist' + streamUrl;
        } else if (!streamUrl.startsWith('http')) {
          streamUrl = workingDomain + '/playlist/' + streamUrl;
        }
        if (!streamUrl.endsWith('.txt')) streamUrl += '.txt';

        const streamRes = await fetch(streamUrl, {
          headers: {
            'X-CSRF-TOKEN': p3.key,
            'Referer': 'https://allmovieland.one/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        if (!streamRes.ok) {
          debugLog.push(`Stream fetch failed for ${lang.title}: ${streamRes.status}`);
          continue;
        }
        const content = await streamRes.text();
        const trimmed = content.trim();

        if (trimmed.startsWith('[')) {
          const qualities = JSON.parse(trimmed);
          for (const q of qualities) {
            if (q.file && q.file !== '-') {
              let qUrl = q.file;
              if (qUrl.startsWith('/playlist')) qUrl = workingDomain + qUrl;
              else if (qUrl.startsWith('~')) qUrl = workingDomain + '/playlist' + qUrl;
              else if (!qUrl.startsWith('http')) qUrl = workingDomain + '/playlist/' + qUrl;
              if (!qUrl.endsWith('.txt')) qUrl += '.txt';
              streams.push({
                language: `${lang.title} - ${q.title || 'HD'}`,
                url: qUrl
              });
            }
          }
        } else if (trimmed.startsWith('http')) {
          streams.push({ language: lang.title, url: trimmed });
        } else {
          streams.push({ language: lang.title, url: streamUrl });
        }
      }
    }

    if (streams.length === 0) {
      return res.status(500).json({
        error: 'No streams found',
        debug: { logs: debugLog }
      });
    }

    // If debug flag is present, include logs in response
    const response = { success: true, streams };
    if (debug === 'true') response.debug = { logs: debugLog };
    return res.status(200).json(response);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message,
      debug: { logs: debugLog, stack: error.stack }
    });
  }
}
