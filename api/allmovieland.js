// api/allmovieland.js

// Helper to fetch streaming domain from player.js with multiple patterns
async function getStreamingDomain() {
  const playerJsUrl = 'https://allmovieland.link/player.js?v=60%20128';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    'Cache-Control': 'max-age=0',
    'Host': 'allmovieland.link',
    'Connection': 'Keep-Alive',
    'Accept-Encoding': 'gzip'
  };

  const response = await fetch(playerJsUrl, { headers });
  const scriptText = await response.text();
  console.log('player.js fetched, length:', scriptText.length);

  // Try multiple patterns to extract the domain
  const patterns = [
    /const\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /let\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /var\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
    /"AwsIndStreamDomain"\s*:\s*['"]([^'"]+)['"]/,
    /domain\s*:\s*['"](https?:\/\/[^'"]+)['"]/,
    /https?:\/\/[a-z0-9]+\.(com|net|cfd|rest)\/play/
  ];

  for (const pattern of patterns) {
    const match = scriptText.match(pattern);
    if (match && match[1]) {
      let domain = match[1];
      // Ensure it's a valid URL
      if (!domain.startsWith('http')) {
        domain = 'https://' + domain;
      }
      console.log(`✅ Extracted domain using pattern: ${pattern}`);
      return domain;
    }
  }

  // Fallback: try to find any domain pattern in the script
  const fallbackMatch = scriptText.match(/(?:https?:)?\/\/[a-z0-9]+\.(com|net|cfd|rest)\//);
  if (fallbackMatch) {
    let domain = fallbackMatch[0];
    if (!domain.startsWith('http')) domain = 'https:' + domain;
    if (domain.endsWith('/')) domain = domain.slice(0, -1);
    console.log(`⚠️ Fallback domain extracted: ${domain}`);
    return domain;
  }

  // If all fails, use a list of known working domains (update as needed)
  const knownDomains = [
    'https://gemma416okl.com',
    'https://keymi417exx.com',
    'https://allmovieland.cfd',
    'https://allmovieland.rest'
  ];
  console.log('⚠️ Using fallback known domain list');
  // Return the first that might work (you can test each with a HEAD request)
  return knownDomains[0];
}

// Helper to extract p3 object from HTML
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

// Main handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id parameter' });

  try {
    // Get streaming domain
    const domain = await getStreamingDomain();
    console.log(`🏠 Using domain: ${domain}`);

    // Fetch movie page
    const pageUrl = `${domain}/play/${id}`;
    const pageHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
      'Referer': 'https://allmovieland.one/',
      'Host': new URL(domain).hostname,
      'Connection': 'Keep-Alive',
      'Accept-Encoding': 'gzip'
    };
    const pageRes = await fetch(pageUrl, { headers: pageHeaders });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} from movie page`);
    const html = await pageRes.text();

    // Extract p3
    const p3 = extractP3Object(html);
    if (!p3) throw new Error('Could not extract p3 object from page');
    console.log('✅ p3 object extracted');

    // Get language list URL
    let langUrl = p3.file;
    if (langUrl.startsWith('/playlist')) {
      langUrl = domain + langUrl;
    } else if (!langUrl.startsWith('http')) {
      langUrl = domain + '/playlist/' + langUrl;
    }
    const langHeaders = {
      'X-CSRF-TOKEN': p3.key,
      'Referer': 'https://allmovieland.link/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    const langRes = await fetch(langUrl, { headers: langHeaders });
    const languages = await langRes.json();
    console.log(`✅ Languages: ${languages.map(l => l.title).join(', ')}`);

    // Process each language
    const streams = [];
    for (const lang of languages) {
      if (lang.file && lang.file !== '-') {
        let streamUrl = lang.file;
        if (streamUrl.startsWith('/playlist')) {
          streamUrl = domain + streamUrl;
        } else if (streamUrl.startsWith('~')) {
          streamUrl = domain + '/playlist' + streamUrl;
        } else if (!streamUrl.startsWith('http')) {
          streamUrl = domain + '/playlist/' + streamUrl;
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
    }

    if (streams.length === 0) throw new Error('No streams found');
    return res.status(200).json({ success: true, streams });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
