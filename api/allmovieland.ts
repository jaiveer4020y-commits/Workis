// api/allmovieland.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

interface VideoData {
  file: string;
  key: string;
  host: string;
  hls: number;
  p2p: boolean;
  cuid: string;
  movie: string;
  translator: string;
  autoplay: number;
  poster?: string;
  referrer?: string | null;
  domain?: string | null;
  kp: string;
  masterId?: string;
  masterHash?: string;
  userIp?: string;
  href?: string;
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      if (response.status === 404) throw new Error('Resource not found');
      if (response.status === 403) throw new Error('Access forbidden');
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

function extractVideoData(html: string): VideoData | null {
  // Method 1: Look for let p3 = {...};
  let match = html.match(/let p3 = (\{[^;]+\});/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.log('Failed to parse p3 object');
    }
  }
  
  // Method 2: Look for var p3 = {...};
  match = html.match(/var p3 = (\{[^;]+\});/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.log('Failed to parse var p3 object');
    }
  }
  
  // Method 3: Look for window.p3 = {...};
  match = html.match(/window\.p3 = (\{[^;]+\});/);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (e) {
      console.log('Failed to parse window.p3 object');
    }
  }
  
  // Method 4: Look for any object containing file and key
  match = html.match(/\{[^{]*"file"\s*:\s*"[^"]+"[^{]*"key"\s*:\s*"[^"]+"[^{]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      console.log('Failed to parse generic object');
    }
  }
  
  return null;
}

async function getWorkingDomain(id: string): Promise<string> {
  // First try to extract from player.js
  try {
    const playerScript = await fetchWithRetry(
      'https://allmovieland.link/player.js?v=60%20128',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/javascript, */*;q=0.8'
        }
      }
    );
    const scriptText = await playerScript.text();
    const domainMatch = scriptText.match(/const AwsIndStreamDomain.*'(https?:\/\/[^']+)';/);
    if (domainMatch && domainMatch[1]) {
      return domainMatch[1];
    }
  } catch (e) {
    console.log('Failed to extract domain from player.js, using default');
  }
  
  // Fallback domains (update these as needed)
  const fallbackDomains = [
    'https://gemma416okl.com',
    'https://keymi417exx.com',
    'https://allmovieland.cfd',
    'https://allmovieland.rest'
  ];
  
  for (const domain of fallbackDomains) {
    try {
      const testUrl = `${domain}/play/${id}`;
      const test = await fetch(testUrl, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (test.ok) {
        console.log(`✅ Working domain found: ${domain}`);
        return domain;
      }
    } catch (e) {
      continue;
    }
  }
  
  throw new Error('No working domain found');
}

async function getStreamUrl(videoData: VideoData, referer: string): Promise<string> {
  let streamUrl = videoData.file;
  
  // If it's a .txt file, fetch the actual M3U8 URL
  if (streamUrl && streamUrl.endsWith('.txt')) {
    console.log('📄 Fetching playlist from .txt file...');
    const playlistResponse = await fetchWithRetry(
      streamUrl,
      {
        headers: {
          'X-CSRF-TOKEN': videoData.key,
          'Referer': referer,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }
    );
    streamUrl = await playlistResponse.text();
    streamUrl = streamUrl.trim();
  }
  
  // If HLS is enabled, ensure it's an M3U8 URL
  if (videoData.hls === 1 && !streamUrl.includes('.m3u8')) {
    console.log('⚠️ HLS enabled but URL not M3U8, may need processing');
  }
  
  return streamUrl;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  }
  
  const { id, season, episode } = req.query;
  
  if (!id) {
    return res.status(400).json({ 
      error: 'Missing parameter',
      message: 'id parameter is required. Example: ?id=tt33014583' 
    });
  }
  
  try {
    console.log(`🎬 Processing request for ID: ${id}`);
    
    // Get working domain
    const domain = await getWorkingDomain(id as string);
    console.log(`🏠 Using domain: ${domain}`);
    
    // Fetch the player page
    const playerUrl = `${domain}/play/${id}`;
    console.log(`📡 Fetching: ${playerUrl}`);
    
    const pageResponse = await fetchWithRetry(
      playerUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://allmovieland.link/',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      }
    );
    
    const html = await pageResponse.text();
    console.log(`📄 Page fetched, size: ${html.length} bytes`);
    
    // Extract video data from script
    const videoData = extractVideoData(html);
    if (!videoData || !videoData.file || !videoData.key) {
      console.error('❌ Could not extract video data from page');
      return res.status(404).json({
        error: 'Video data not found',
        message: 'The page structure may have changed or the content is not available',
        htmlPreview: html.substring(0, 500)
      });
    }
    
    console.log('✅ Video data extracted successfully');
    console.log(`📹 Stream file: ${videoData.file.substring(0, 100)}...`);
    console.log(`🏠 Host: ${videoData.host}`);
    console.log(`🔑 Key: ${videoData.key.substring(0, 20)}...`);
    
    // Get the actual stream URL
    const referer = `https://${videoData.host}/`;
    const streamUrl = await getStreamUrl(videoData, referer);
    
    // Validate stream URL
    if (!streamUrl || (!streamUrl.startsWith('http') && !streamUrl.startsWith('/'))) {
      return res.status(404).json({
        error: 'Invalid stream URL',
        message: 'Could not extract a valid stream URL from the response'
      });
    }
    
    // Prepare response
    const response = {
      success: true,
      id: id as string,
      title: `Movie ${id}`,
      sources: [
        {
          name: `Allmovieland [${videoData.translator === '5' ? 'Multi Audio' : 'Original'}]`,
          url: streamUrl,
          type: 'm3u8',
          quality: videoData.hls === 1 ? '1080p' : '720p',
          referer: referer,
          headers: {
            'X-CSRF-TOKEN': videoData.key,
            'Referer': referer,
            'User-Agent': 'Mozilla/5.0'
          }
        }
      ],
      metadata: {
        cuid: videoData.cuid,
        movie: videoData.movie,
        host: videoData.host,
        translator: videoData.translator,
        p2p: videoData.p2p,
        autoplay: videoData.autoplay
      }
    };
    
    // Handle season/episode if provided (for TV shows)
    if (season && episode) {
      response.sources[0].name += ` S${season}E${episode}`;
    }
    
    console.log('✅ Stream URL obtained successfully');
    return res.status(200).json(response);
    
  } catch (error) {
    console.error('💥 Error in allmovieland handler:', error);
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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
