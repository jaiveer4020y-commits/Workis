// api/allmovieland.js

const PROXY_BASE = 'https://workingg.vercel.app/api/proxy?source=2&url=';

// Helper: fetch any URL via the proxy
async function fetchViaProxy(url, options = {}) {
  const proxyUrl = PROXY_BASE + encodeURIComponent(url);
  // Merge headers; the proxy may add its own, but we keep ours
  const response = await fetch(proxyUrl, {
    method: options.method || 'GET',
    headers: options.headers || {}
  });
  // The proxy returns the status and body of the target
  if (!response.ok) throw new Error(`Proxy request failed: ${response.status}`);
  return response;
}

// Extract streaming domain from player.js (still via proxy)
async function getStreamingDomain() {
  const playerUrl = 'https://allmovieland.link/player.js?v=60%20128';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    'Cache-Control': 'max-age=0'
  };
  const res = await fetchViaProxy(playerUrl, { headers });
  const text = await res.text();

  const patterns = [
    /const\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /let\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /var\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /['"]AwsIndStreamDomain['"]\s*:\s*['"]([^'"]+)['"]/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let domain = match[1];
      if (!domain.startsWith('http')) domain = 'https://' + domain;
      return domain;
    }
  }
  throw new Error('Could not extract streaming domain from player.js');
}

// Extract p3 object from HTML
function extractP3(html) {
  const patterns = [
    /let p3 = (\{[^;]+\});/,
    /var p3 = (\{[^;]+\});/,
    /const p3 = (\{[^;]+\});/
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { id, season, episode, debug } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });
  if (season) season = parseInt(season);
  if (episode) episode = parseInt(episode);

  const debugLog = [];

  try {
    // 1. Get streaming domain (via proxy)
    const domain = await getStreamingDomain();
    debugLog.push(`Streaming domain: ${domain}`);

    // 2. Fetch movie/TV page (via proxy)
    let pageUrl = `${domain}/play/${id}`;
    if (season && episode) pageUrl += `/s${season}-e${episode}`;
    debugLog.push(`Page URL: ${pageUrl}`);

    const pageRes = await fetchViaProxy(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://allmovieland.one/'
      }
    });
    const html = await pageRes.text();
    debugLog.push(`Page loaded, ${html.length} bytes`);

    // 3. Extract p3
    const p3 = extractP3(html);
    if (!p3) throw new Error('No p3 object found');
    debugLog.push('p3 object extracted');

    // 4. Fetch language list (via proxy)
    let langUrl = p3.file;
    if (langUrl.startsWith('/playlist')) langUrl = domain + langUrl;
    else if (!langUrl.startsWith('http')) langUrl = domain + '/playlist/' + langUrl;
    debugLog.push(`Language list URL: ${langUrl}`);

    const langRes = await fetchViaProxy(langUrl, {
      headers: {
        'X-CSRF-TOKEN': p3.key,
        'Referer': 'https://allmovieland.link/'
      }
    });
    const languages = await langRes.json();
    debugLog.push(`Languages: ${languages.map(l => l.title).join(', ')}`);

    // 5. For each language, get stream URL (via proxy)
    const streams = [];
    for (const lang of languages) {
      if (!lang.file || lang.file === '-') continue;
      let streamUrl = lang.file;
      if (streamUrl.startsWith('/playlist')) streamUrl = domain + streamUrl;
      else if (streamUrl.startsWith('~')) streamUrl = domain + '/playlist' + streamUrl;
      else if (!streamUrl.startsWith('http')) streamUrl = domain + '/playlist/' + streamUrl;
      if (!streamUrl.endsWith('.txt')) streamUrl += '.txt';

      const streamRes = await fetchViaProxy(streamUrl, {
        headers: {
          'X-CSRF-TOKEN': p3.key,
          'Referer': 'https://allmovieland.one/'
        }
      });
      if (!streamRes.ok) {
        debugLog.push(`${lang.title} stream failed: ${streamRes.status}`);
        continue;
      }
      const content = await streamRes.text();
      const trimmed = content.trim();

      if (trimmed.startsWith('[')) {
        // Nested qualities
        const qualities = JSON.parse(trimmed);
        for (const q of qualities) {
          if (q.file && q.file !== '-') {
            let qUrl = q.file;
            if (qUrl.startsWith('/playlist')) qUrl = domain + qUrl;
            else if (qUrl.startsWith('~')) qUrl = domain + '/playlist' + qUrl;
            else if (!qUrl.startsWith('http')) qUrl = domain + '/playlist/' + qUrl;
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

    if (streams.length === 0) throw new Error('No streams extracted');

    const response = { success: true, streams };
    if (debug === 'true') response.debug = debugLog;
    return res.status(200).json(response);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message,
      debug: debug === 'true' ? debugLog : undefined
    });
  }
}
