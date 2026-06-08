// api/allmovieland.js

/**
 * CONFIGURATION
 */
const PROXY_URL = 'https://workingg.vercel.app/api/proxy?source=2&url=';
const FALLBACK_DOMAINS = ['https://gemma416okl.com', 'https://keymi417exx.com'];
const PLAYER_JS_URL = 'https://allmovieland.link/player.js?v=60%20128';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://allmovieland.one/'
};

let cachedDomain = null;

/**
 * UTILITIES
 */
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

async function fetchViaProxy(url, options = {}) {
  const proxyUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
  try {
    const res = await fetchWithTimeout(proxyUrl, options);
    if (res.ok) return res;
  } catch (e) {
    console.warn(`[DEBUG] Proxy failed for ${url}: ${e.message}`);
  }
  return fetchWithTimeout(url, options);
}

function resolveUrl(baseUrl, path) {
  if (path.startsWith('http')) return path;
  if (path.startsWith('/playlist')) return `${baseUrl}${path}`;
  if (path.startsWith('~')) return `${baseUrl}/playlist${path.slice(1)}`;
  return `${baseUrl}/playlist/${path}`;
}

async function getStreamingDomain() {
  if (cachedDomain) return cachedDomain;

  try {
    const res = await fetchViaProxy(PLAYER_JS_URL, { headers: DEFAULT_HEADERS });
    const text = await res.text();
    const match = text.match(/AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/);
    if (match?.[1]) {
      cachedDomain = match[1].startsWith('http') ? match[1] : `https://${match[1]}`;
      return cachedDomain;
    }
  } catch (e) {
    console.error('[DEBUG] Player.js extraction failed.');
  }

  for (const domain of FALLBACK_DOMAINS) {
    try {
      const res = await fetchWithTimeout(`${domain}/play/tt33014583`, { method: 'HEAD' }, 3000);
      if (res.ok) return (cachedDomain = domain);
    } catch (e) {}
  }
  throw new Error('No working streaming domain found');
}

/**
 * MAIN HANDLER
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, season, episode } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  try {
    const domain = await getStreamingDomain();
    const pageUrl = `${domain}/play/${id}${season && episode ? `/s${season}-e${episode}` : ''}`;
    
    console.log(`[DEBUG] Fetching page: ${pageUrl}`);
    const pageRes = await fetchViaProxy(pageUrl, { headers: DEFAULT_HEADERS });
    const html = await pageRes.text();

    // Debugging checks
    if (html.length < 500 || html.includes('captcha') || html.includes('Cloudflare')) {
      console.error(`[DEBUG] Blocked or empty response. HTML Length: ${html.length}`);
      throw new Error('Target site returned a block page or unexpected content');
    }

    const p3Match = html.match(/(?:let|var|const)\s+p3\s*=\s*(\{[^;]+\});/);
    if (!p3Match) {
      console.error(`[DEBUG] Failed to find p3. HTML snippet: ${html.substring(0, 300)}`);
      throw new Error('Could not find p3 configuration');
    }
    
    const p3 = JSON.parse(p3Match[1]);
    const langRes = await fetchViaProxy(resolveUrl(domain, p3.file), {
      headers: { ...DEFAULT_HEADERS, 'X-CSRF-TOKEN': p3.key }
    });
    
    const languages = await langRes.json();
    for (const lang of languages) {
      if (!lang.file || lang.file === '-') continue;

      const streamUrl = resolveUrl(domain, lang.file.endsWith('.txt') ? lang.file : `${lang.file}.txt`);
      const streamRes = await fetchViaProxy(streamUrl, {
        headers: { ...DEFAULT_HEADERS, 'X-CSRF-TOKEN': p3.key }
      });
      
      const content = (await streamRes.text()).trim();
      if (!content) continue;

      if (content.startsWith('[')) {
        const qualities = JSON.parse(content);
        const streams = qualities
          .filter(q => q.file && q.file !== '-')
          .map(q => ({
            language: `${lang.title} - ${q.title || 'HD'}`,
            url: resolveUrl(domain, q.file.endsWith('.txt') ? q.file : `${q.file}.txt`)
          }));
        return res.status(200).json({ success: true, streams });
      } 
      
      return res.status(200).json({ success: true, streams: [{ language: lang.title, url: content }] });
    }

    throw new Error('No valid streams found');
  } catch (err) {
    console.error('[API ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
