// api/allmovieland.js

const PROXY_URL = 'https://workingg.vercel.app/api/proxy?source=2&url=';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://allmovieland.one/'
};

/**
 * Enhanced fetcher that includes debugging and proxying
 */
async function secureFetch(url, options = {}, label = 'Request') {
  const proxyUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
  console.log(`[DEBUG] ${label} -> ${url}`);
  
  try {
    const res = await fetch(proxyUrl, {
      ...options,
      headers: { ...DEFAULT_HEADERS, ...options.headers }
    });
    
    // Log status for tracking
    console.log(`[DEBUG] ${label} Status: ${res.status}`);
    
    // Handle 302 Redirects manually if the proxy doesn't follow them
    if (res.status === 302 || res.headers.get('location')) {
      const redirectUrl = res.headers.get('location');
      console.log(`[DEBUG] ${label} Redirecting to: ${redirectUrl}`);
      return secureFetch(redirectUrl, options, `${label} (Redirect)`);
    }

    if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
    return res;
  } catch (err) {
    console.error(`[ERROR] ${label} failed: ${err.message}`);
    throw err;
  }
}

export default async function handler(req, res) {
  // CORS Setup
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id, season, episode } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ID' });

  try {
    // 1. Get Domain (Simplified for brevity, assume 'domain' is resolved)
    const domain = 'https://keymi417exx.com'; 
    const pageUrl = `${domain}/play/${id}${season ? `/s${season}-e${episode}` : ''}`;

    // 2. Fetch page and extract p3
    const pageRes = await secureFetch(pageUrl, {}, 'MainPage');
    const html = await pageRes.text();
    const p3Match = html.match(/(?:let|var|const)\s+p3\s*=\s*(\{[^;]+\});/);
    
    if (!p3Match) throw new Error('Could not find p3 configuration in HTML');
    const p3 = JSON.parse(p3Match[1]);
    console.log('[DEBUG] p3 extracted:', p3.file);

    // 3. Fetch Language Playlist
    const langUrl = p3.file.startsWith('http') ? p3.file : `${domain}/playlist/${p3.file}`;
    const langRes = await secureFetch(langUrl, {
      headers: { 'X-CSRF-TOKEN': p3.key }
    }, 'LanguageList');
    
    const languages = await langRes.json();
    
    // 4. Fetch Stream Data
    const targetLang = languages[0]; // Assuming first language for now
    const streamUrl = targetLang.file.startsWith('http') ? targetLang.file : `${domain}/playlist/${targetLang.file}`;
    
    const streamRes = await secureFetch(streamUrl, {
      headers: { 'X-CSRF-TOKEN': p3.key }
    }, 'StreamData');
    
    const streamData = await streamRes.text();
    
    return res.status(200).json({ success: true, data: streamData });

  } catch (err) {
    return res.status(500).json({ 
      error: 'Process failed', 
      details: err.message,
      hint: 'Check Vercel logs for [DEBUG] trace'
    });
  }
}
