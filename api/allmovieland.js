// api/allmovieland.js

// Known domains that have worked recently (update as needed)
const KNOWN_DOMAINS = [
  'https://gemma416okl.com',
  'https://keymi417exx.com',
  'https://allmovieland.cfd',
  'https://allmovieland.rest'
];

// Fetch streaming domain from player.js or fallback
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
    console.log('Failed to fetch player.js, using fallback domains');
  }
  return null;
}

// Test if a domain works for a given ID (and season/episode)
async function testDomain(domain, id, season, episode) {
  let url = `${domain}/play/${id}`;
  if (season && episode) url += `/s${season}-e${episode}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://allmovieland.one/',
    'Host': new URL(domain).hostname
  };
  try {
    const res = await fetch(url, { method: 'HEAD', headers });
    return res.ok;
  } catch {
    return false;
  }
}

// Extract p3 object from HTML
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let { id, season, episode } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });

  // Convert season/episode to numbers if present
  if (season) season = parseInt(season);
  if (episode) episode = parseInt(episode);

  try {
    // Step 1: Get candidate domains (extracted + known)
    let extractedDomain = await getStreamingDomain();
    let domainsToTry = extractedDomain ? [extractedDomain, ...KNOWN_DOMAINS] : [...KNOWN_DOMAINS];
    domainsToTry = [...new Set(domainsToTry)]; // remove duplicates

    let workingDomain = null;
    for (const domain of domainsToTry) {
      console.log(`Testing domain: ${domain}`);
      if (await testDomain(domain, id, season, episode)) {
        workingDomain = domain;
        break;
      }
    }
    if (!workingDomain) {
      return res.status(404).json({ error: 'No working domain found for this ID' });
    }
    console.log(`✅ Using domain: ${workingDomain}`);

    // Step 2: Fetch movie page
    let pageUrl = `${workingDomain}/play/${id}`;
    if (season && episode) pageUrl += `/s${season}-e${episode}`;
    const pageHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://allmovieland.one/',
      'Host': new URL(workingDomain).hostname
    };
    const pageRes = await fetch(pageUrl, { headers: pageHeaders });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} from movie page`);
    const html = await pageRes.text();

    // Step 3: Extract p3
    const p3 = extractP3Object(html);
    if (!p3) throw new Error('Could not extract p3 object');
    console.log('✅ p3 extracted');

    // Step 4: Get language list
    let langUrl = p3.file;
    if (langUrl.startsWith('/playlist')) {
      langUrl = workingDomain + langUrl;
    } else if (!langUrl.startsWith('http')) {
      langUrl = workingDomain + '/playlist/' + langUrl;
    }
    const langRes = await fetch(langUrl, {
      headers: {
        'X-CSRF-TOKEN': p3.key,
        'Referer': 'https://allmovieland.link/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const languages = await langRes.json();
    console.log(`✅ Languages: ${languages.map(l => l.title).join(', ')}`);

    // Step 5: Process each language
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

    if (streams.length === 0) throw new Error('No streams found');
    return res.status(200).json({ success: true, streams });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
