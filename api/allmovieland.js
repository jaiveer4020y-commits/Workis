// api/allmovieland.js

const PROXY_URL = 'https://workingg.vercel.app/api/proxy?source=2&url=';
const PLAYER_JS_URL = 'https://allmovieland.link/player.js?v=60%20128';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://allmovieland.one/'
};

/**
 * Utility: Fetch through proxy with manual redirect handling and debug logging
 */
async function secureFetch(url, options = {}, label = 'Request') {
  const proxyUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
  console.log(`[DEBUG] ${label} -> ${url}`);
  
  try {
    const res = await fetch(proxyUrl, {
      ...options,
      headers: { ...DEFAULT_HEADERS, ...options.headers }
    });
    
    console.log(`[DEBUG] ${label} Status: ${res.status}`);
    
    // Explicitly handle 302/301 redirects
    if (res.status === 302 || res.status === 301) {
      const redirectUrl = res.headers.get('location');
      console.log(`[DEBUG] ${label} Redirecting to: ${redirectUrl}`);
      return secureFetch(redirectUrl, options, `${label} (Redirect)`);
    }

    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res;
  } catch (err) {
    console.error(`[ERROR] ${label} failed: ${err.message}`);
    throw err;
  }
}

/**
 * Extract dynamic domain from player.js
 */
async function getStreamingDomain() {
  const res = await secureFetch(PLAYER_JS_URL, {}, 'PlayerJS');
  const text = await res.text();
  const match = text.match(/AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/);
  if (!match?.[1]) throw new Error('Failed to extract domain from player.js');
  
  const domain = match[1].startsWith('http') ? match[1] : `https://${match[1]}`;
  console.log(`[DEBUG] Resolved Domain: ${domain}`);
  return domain;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, season, episode } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ID' });

  try {
    // 1. Resolve correct domain first
    const domain = await getStreamingDomain();
    
    // 2. Fetch Page using resolved domain
    const pageUrl = `${domain}/play/${id}${season ? `/s${season}-e${episode}` : ''}`;
    const pageRes = await secureFetch(pageUrl, {}, 'MainPage');
    const html = await pageRes.text();
    
    const p3Match = html.match(/(?:let|var|const)\s+p3\s*=\s*(\{[^;]+\});/);
    if (!p3Match) throw new Error('Could not find p3 config');
    const p3 = JSON.parse(p3Match[1]);

    // 3. Language Playlist
    const langUrl = p3.file.startsWith('http') ? p3.file : `${domain}/playlist/${p3.file}`;
    const langRes = await secureFetch(langUrl, { headers: { 'X-CSRF-TOKEN': p3.key } }, 'LanguageList');
    const languages = await langRes.json();

    // 4. Stream Data
    const streamUrl = languages[0].file.startsWith('http') ? languages[0].file : `${domain}/playlist/${languages[0].file}`;
    const streamRes = await secureFetch(streamUrl, { headers: { 'X-CSRF-TOKEN': p3.key } }, 'StreamData');
    
    return res.status(200).json({ success: true, data: await streamRes.text() });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
