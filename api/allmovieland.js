// api/allmovieland.js
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Allow only GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }
  
  // Get the movie/TV show ID from query parameters
  const { id, season, episode } = req.query;
  
  // Validate required parameters
  if (!id) {
    return res.status(400).json({ 
      error: 'Missing parameter',
      message: 'id parameter is required. Example: ?id=tt33014583',
      usage: {
        movie: '/api/allmovieland?id=tt33014583',
        tv_series: '/api/allmovieland?id=tt1234567&season=1&episode=1'
      }
    });
  }
  
  try {
    console.log(`🎬 Processing request for ID: ${id}`);
    
    // Step 1: Get the working domain from player.js
    let domain = await getWorkingDomain();
    console.log(`🏠 Using domain: ${domain}`);
    
    // Step 2: Fetch the player page
    const playerUrl = `${domain}/play/${id}`;
    console.log(`📡 Fetching: ${playerUrl}`);
    
    const pageResponse = await fetchWithRetry(playerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://allmovieland.link/',
        'Cache-Control': 'no-cache'
      }
    });
    
    const html = await pageResponse.text();
    console.log(`📄 Page fetched, size: ${html.length} bytes`);
    
    // Step 3: Extract video data from the script tag
    const videoData = extractVideoData(html);
    
    if (!videoData || !videoData.file || !videoData.key) {
      console.error('❌ Could not extract video data');
      
      // Try alternative extraction if first method fails
      const altVideoData = extractAlternativeData(html);
      if (altVideoData && altVideoData.file) {
        videoData = altVideoData;
      } else {
        return res.status(404).json({
          error: 'Video data not found',
          message: 'Could not extract stream information from the page',
          htmlPreview: html.substring(0, 500)
        });
      }
    }
    
    console.log('✅ Video data extracted successfully');
    console.log(`📹 Stream file: ${videoData.file.substring(0, 100)}...`);
    
    // Step 4: Get the actual stream URL
    const streamUrl = await getStreamUrl(videoData);
    
    if (!streamUrl || (!streamUrl.startsWith('http') && !streamUrl.startsWith('/'))) {
      return res.status(404).json({
        error: 'Invalid stream URL',
        message: 'Could not extract a valid stream URL'
      });
    }
    
    // Step 5: Prepare the response
    const response = {
      success: true,
      id: id,
      title: season && episode ? `Episode S${season}E${episode}` : `Movie ${id}`,
      sources: [
        {
          name: `Allmovieland ${season && episode ? `S${season}E${episode}` : ''}`.trim(),
          url: streamUrl,
          type: 'm3u8',
          quality: videoData.hls === 1 ? '1080p' : '720p',
          headers: {
            'X-CSRF-TOKEN': videoData.key,
            'Referer': `https://${videoData.host || domain.replace('https://', '')}/`,
            'User-Agent': 'Mozilla/5.0'
          }
        }
      ],
      metadata: {
        host: videoData.host,
        cuid: videoData.cuid,
        translator: videoData.translator,
        p2p: videoData.p2p || false
      }
    };
    
    // Add season/episode info if provided
    if (season && episode) {
      response.season = parseInt(season);
      response.episode = parseInt(episode);
    }
    
    console.log('✅ Stream URL obtained successfully');
    return res.status(200).json(response);
    
  } catch (error) {
    console.error('💥 Error:', error);
    
    const errorMessage = error.message || 'Unknown error';
    const statusCode = errorMessage.includes('not found') ? 404 : 
                      errorMessage.includes('forbidden') ? 403 : 500;
    
    return res.status(statusCode).json({
      error: 'Failed to process request',
      details: errorMessage,
      suggestion: 'Try again later or check if the ID is correct',
      id: id
    });
  }
}

// Helper function to fetch with retry logic
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status === 404) throw new Error('Resource not found');
      if (response.status === 403) throw new Error('Access forbidden');
      if (response.status >= 500) throw new Error(`Server error: ${response.status}`);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Retry ${i + 1}/${maxRetries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error(`Failed after ${maxRetries} retries`);
}

// Get working domain from player.js or use fallbacks
async function getWorkingDomain() {
  const domains = [];
  
  // Try to extract from player.js first
  try {
    const playerScript = await fetch('https://allmovieland.link/player.js?v=60%20128', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const scriptText = await playerScript.text();
    
    // Try multiple patterns to find the domain
    const patterns = [
      /const AwsIndStreamDomain.*'(https?:\/\/[^']+)';/,
      /AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
      /let AwsIndStreamDomain.*'(https?:\/\/[^']+)';/
    ];
    
    for (const pattern of patterns) {
      const match = scriptText.match(pattern);
      if (match && match[1]) {
        domains.push(match[1]);
      }
    }
  } catch (e) {
    console.log('Could not fetch player.js, using fallback domains');
  }
  
  // Fallback domains (update these as needed)
  domains.push(
    'https://gemma416okl.com',
    'https://keymi417exx.com',
    'https://allmovieland.cfd',
    'https://allmovieland.rest'
  );
  
  // Test each domain
  for (const domain of domains) {
    try {
      const testUrl = `${domain}/play/tt33014583`; // Test with a known ID
      const test = await fetch(testUrl, { 
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (test.ok) {
        console.log(`✅ Working domain found: ${domain}`);
        return domain;
      }
    } catch (e) {
      continue;
    }
  }
  
  // Return the most recent domain as default
  return 'https://gemma416okl.com';
}

// Extract video data from page HTML
function extractVideoData(html) {
  // Method 1: Look for let p3 = {...};
  let match = html.match(/let p3 = (\{[^;]+\});/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {}
  }
  
  // Method 2: Look for var p3 = {...};
  match = html.match(/var p3 = (\{[^;]+\});/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {}
  }
  
  // Method 3: Look for window.p3 = {...};
  match = html.match(/window\.p3 = (\{[^;]+\});/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {}
  }
  
  return null;
}

// Alternative extraction method
function extractAlternativeData(html) {
  // Look for any object containing file and key
  const match = html.match(/\{[^{]*"file"\s*:\s*"[^"]+"[^{]*"key"\s*:\s*"[^"]+"[^{]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {}
  }
  return null;
}

// Get the actual stream URL from the video data
async function getStreamUrl(videoData) {
  let streamUrl = videoData.file;
  
  // If it's a .txt file, fetch the actual M3U8 URL
  if (streamUrl && streamUrl.endsWith('.txt')) {
    console.log('📄 Fetching playlist from .txt file...');
    try {
      const playlistResponse = await fetchWithRetry(streamUrl, {
        headers: {
          'X-CSRF-TOKEN': videoData.key,
          'Referer': `https://${videoData.host || 'keymi417exx.com'}/`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      streamUrl = await playlistResponse.text();
      streamUrl = streamUrl.trim();
    } catch (error) {
      console.error('Failed to fetch playlist:', error.message);
      throw error;
    }
  }
  
  return streamUrl;
}
