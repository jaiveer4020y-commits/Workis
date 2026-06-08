// api/allmovieland.js

// ======================== CONFIGURATION ========================
const PROXY_URL = 'https://workingg.vercel.app/api/proxy?source=2&url=';
const DIRECT_FALLBACK = true;  // fallback to direct fetch (may fail due to CORS but faster)

// Hardcoded fallback domains (update when known)
const FALLBACK_DOMAINS = [
  'https://gemma416okl.com',
  'https://keymi417exx.com'
];
// ================================================================

// Fast fetch with timeout (max 8 seconds per request)
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Fetch via proxy (primary) or fallback to direct
async function fetchViaProxy(url, options = {}) {
  // Try proxy first
  const proxyUrl = PROXY_URL + encodeURIComponent(url);
  try {
    const res = await fetchWithTimeout(proxyUrl, {
      method: options.method || 'GET',
      headers: options.headers || {}
    });
    if (res.ok) return res;
  } catch (e) {
    console.log(`Proxy failed: ${e.message}`);
  }

  // Fallback to direct fetch (faster but may have CORS)
  if (DIRECT_FALLBACK) {
    console.log('Falling back to direct fetch');
    const res = await fetchWithTimeout(url, options);
    if (res.ok) return res;
  }
  throw new Error(`All fetch attempts failed for ${url}`);
}

// Get streaming domain (cached in memory)
let cachedDomain = null;
async function getStreamingDomain() {
  if (cachedDomain) return cachedDomain;

  // Try to extract from player.js
  const playerUrl = 'https://allmovieland.link/player.js?v=60%20128';
  try {
    const res = await fetchViaProxy(playerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cache-Control': 'max-age=0'
      }
    });
    const text = await res.text();
    const match = text.match(/AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/);
    if (match && match[1]) {
      let domain = match[1];
      if (!domain.startsWith('http')) domain = 'https://' + domain;
      cachedDomain = domain;
      return domain;
    }
  } catch (e) {
    console.log('Player.js extraction failed, using fallback domains');
  }

  // Use fallback domains
  for (const domain of FALLBACK_DOMAINS) {
    try {
      const testUrl = `${domain}/play/tt33014583`;
      const res = await fetchWithTimeout(testUrl, { method: 'GET' }, 3000);
      if (res.ok) {
        cachedDomain = domain;
        return domain;
      }
    } catch (e) {}
  }
  throw new Error('No working domain found');
}

// Extract p3 object (fast)
function extractP3(html) {
  const match = html.match(/(?:let|var|const)\s+p3\s*=\s*(\{[^;]+\});/);
  if (match) {
    try { return JSON.parse(match[1]); } catch(e) {}
  }
  return null;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, season, episode } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  try {
    // Get domain (cached)
    const domain = await getStreamingDomain();

    // Build page URL
    let pageUrl = `${domain}/play/${id}`;
    if (season && episode) pageUrl += `/s${season}-e${episode}`;

    // Fetch movie page
    const pageRes = await fetchViaProxy(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://allmovieland.one/'
      }
    });
    const html = await pageRes.text();
    const p3 = extractP3(html);
    if (!p3) throw new Error('No p3 object');

    // Fetch language list (first .txt)
    let langUrl = p3.file;
    if (langUrl.startsWith('/playlist')) langUrl = domain + langUrl;
    else if (!langUrl.startsWith('http')) langUrl = domain + '/playlist/' + langUrl;

    const langRes = await fetchViaProxy(langUrl, {
      headers: {
        'X-CSRF-TOKEN': p3.key,
        'Referer': 'https://allmovieland.link/'
      }
    });
    const languages = await langRes.json();

    // For each language, get the stream URL – but stop after first working one to save time
    let streams = [];
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
      if (!streamRes.ok) continue;
      const content = await streamRes.text();
      const trimmed = content.trim();

      if (trimmed.startsWith('[')) {
        const qualities = JSON.parse(trimmed);
        for (const q of qualities) {
          if (q.file && q.file !== '-') {
            let qUrl = q.file;
            if (qUrl.startsWith('/playlist')) qUrl = domain + qUrl;
            else if (qUrl.startsWith('~')) qUrl = domain + '/playlist' + qUrl;
            else if (!qUrl.startsWith('http')) qUrl = domain + '/playlist/' + qUrl;
            if (!qUrl.endsWith('.txt')) qUrl += '.txt';
            streams.push({ language: `${lang.title} - ${q.title || 'HD'}`, url: qUrl });
          }
        }
      } else if (trimmed.startsWith('http')) {
        streams.push({ language: lang.title, url: trimmed });
        break; // take first working stream to save time
      } else {
        streams.push({ language: lang.title, url: streamUrl });
        break;
      }
      if (streams.length > 0) break; // stop after first stream
    }

    if (streams.length === 0) throw new Error('No streams found');
    return res.status(200).json({ success: true, streams });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
