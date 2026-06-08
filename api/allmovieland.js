// api/allmovieland.js

// Helper function to extract the streaming domain from player.js
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

  // Extract domain using regex
  const match = scriptText.match(/const AwsIndStreamDomain = '([^']+)';/);
  if (!match) throw new Error('Could not extract streaming domain from player.js');
  return match[1];
}

// Helper function to extract p3 object from movie page HTML
function extractP3Object(html) {
  // Try to find p3 object with let, var, or const
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
      } catch (e) {
        console.error('Failed to parse p3 object:', e);
      }
    }
  }
  return null;
}

// Main Vercel handler
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Missing id parameter' });
  }

  try {
    // Step 1: Get the streaming domain
    const domain = await getStreamingDomain();
    console.log(`✅ Streaming domain: ${domain}`);

    // Step 2: Fetch the movie page
    const moviePageUrl = `${domain}/play/${id}`;
    const moviePageHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
      'Referer': 'https://allmovieland.one/',
      'Host': new URL(domain).hostname,
      'Connection': 'Keep-Alive',
      'Accept-Encoding': 'gzip'
    };

    const moviePageResponse = await fetch(moviePageUrl, { headers: moviePageHeaders });
    const html = await moviePageResponse.text();
    console.log(`✅ Movie page fetched (${html.length} bytes)`);

    // Step 3: Extract p3 object
    const p3 = extractP3Object(html);
    if (!p3) {
      return res.status(500).json({ error: 'Could not extract p3 object from page' });
    }

    // Step 4: Get the language list from the file URL
    // The file URL can be either an absolute URL or a relative path
    let languageListUrl = p3.file;
    if (languageListUrl.startsWith('/playlist')) {
      // Relative path - prepend the streaming domain
      languageListUrl = domain + languageListUrl;
    }
    // If it's already an absolute URL, use it as is

    const languageListHeaders = {
      'X-CSRF-TOKEN': p3.key,
      'Referer': 'https://allmovieland.link/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    };

    const languageListResponse = await fetch(languageListUrl, { headers: languageListHeaders });
    const languages = await languageListResponse.json();
    console.log(`✅ Found ${languages.length} languages: ${languages.map(l => l.title).join(', ')}`);

    // Step 5: For each language, get the actual stream URL
    const streams = [];

    for (const lang of languages) {
      if (lang.file && lang.file !== '-') {
        let streamUrl = lang.file;

        // Handle file path similarly: if it starts with '/playlist', prepend domain; otherwise use as is
        if (streamUrl.startsWith('/playlist')) {
          streamUrl = domain + streamUrl;
        } else if (streamUrl.startsWith('~')) {
          // If it starts with '~', it's a relative path that needs the domain
          streamUrl = domain + '/playlist' + streamUrl;
        } else if (!streamUrl.startsWith('http')) {
          // If it doesn't start with http, prepend domain and /playlist
          streamUrl = `${domain}/playlist/${streamUrl}`;
        }

        // Add .txt extension if missing (some responses may not include it)
        if (!streamUrl.endsWith('.txt')) {
          streamUrl += '.txt';
        }

        const streamHeaders = {
          'X-CSRF-TOKEN': p3.key,
          'Referer': 'https://allmovieland.one/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
        };

        const streamResponse = await fetch(streamUrl, { headers: streamHeaders });
        const content = await streamResponse.text();

        // Check if the content is a direct M3U8 URL or a nested JSON
        if (content.trim().startsWith('[')) {
          // Nested qualities (e.g., different resolutions)
          const qualities = JSON.parse(content);
          for (const quality of qualities) {
            if (quality.file && quality.file !== '-') {
              let qualityUrl = quality.file;
              if (qualityUrl.startsWith('/playlist')) {
                qualityUrl = domain + qualityUrl;
              } else if (qualityUrl.startsWith('~')) {
                qualityUrl = domain + '/playlist' + qualityUrl;
              } else if (!qualityUrl.startsWith('http')) {
                qualityUrl = `${domain}/playlist/${qualityUrl}`;
              }
              if (!qualityUrl.endsWith('.txt')) qualityUrl += '.txt';
              streams.push({
                language: `${lang.title} - ${quality.title || 'HD'}`,
                url: qualityUrl
              });
            }
          }
        } else if (content.trim().startsWith('http')) {
          // Direct stream URL (e.g., M3U8)
          streams.push({
            language: lang.title,
            url: content.trim()
          });
        } else {
          // Possibly the response is the stream URL itself
          streams.push({
            language: lang.title,
            url: streamUrl
          });
        }
      }
    }

    if (streams.length === 0) {
      return res.status(500).json({ error: 'No streams found' });
    }

    return res.status(200).json({
      success: true,
      streams
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
