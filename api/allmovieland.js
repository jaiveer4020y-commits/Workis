// api/allmovieland.js

const PROXY_URL = 'https://workingg.vercel.app/api/proxy?source=2&url=';
const PLAYER_JS_URL = 'https://allmovieland.link/player.js?v=60%20128';

// Use the exact headers captured from your logs
const EXACT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
  'Referer': 'https://allmovieland.one/',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'max-age=0'
};

/**
 * Proxy fetcher that forces specific headers to bypass blocks
 */
async function secureFetch(url, customHeaders = {}, label = 'Request') {
  const proxyUrl = `${PROXY_URL}${encodeURIComponent(url)}`;
  
  // Merge exact headers with any specific ones (like X-CSRF-TOKEN)
  const headers = { ...EXACT_HEADERS, ...customHeaders };
  
  console.log(`[DEBUG] ${label} -> ${url}`);
  
  const res = await fetch(proxyUrl, { headers });
  console.log(`[DEBUG] ${label} Status: ${res.status}`);

  if (res.status === 302 || res.status === 301) {
    const redirectUrl = res.headers.get('location');
    return secureFetch(redirectUrl, customHeaders, `${label} (Redirect)`);
  }

  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return res;
}

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ID' });

  try {
    // 1. Get Domain
    const playerRes = await secureFetch(PLAYER_JS_URL, {}, 'PlayerJS');
    const playerText = await playerRes.text();
    const domainMatch = playerText.match(/AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/);
    if (!domainMatch) throw new Error('Could not resolve domain');
    const domain = domainMatch[1].startsWith('http') ? domainMatch[1] : `https://${domainMatch[1]}`;

    // 2. Fetch Page with exact headers
    const pageUrl = `${domain}/play/${id}`;
    const pageRes = await secureFetch(pageUrl, { 'Host': domain.replace('https://', '') }, 'MainPage');
    const html = await pageRes.text();

    // 3. Extract P3
    const p3Match = html.match(/(?:let|var|const)\s+p3\s*=\s*(\{[^;]+\});/);
    if (!p3Match) throw new Error('P3 extraction failed');
    const p3 = JSON.parse(p3Match[1]);

    // 4. Fetch Stream
    const langRes = await secureFetch(p3.file, { 'X-CSRF-TOKEN': p3.key }, 'LanguageList');
    const langData = await langRes.json();
    
    return res.status(200).json({ success: true, streams: langData });

  } catch (err) {
    console.error('[CRITICAL ERROR]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
