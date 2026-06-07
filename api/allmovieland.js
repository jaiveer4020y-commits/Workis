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
  
  // Get the movie ID from query parameters
  const { id } = req.query;
  
  // Validate required parameters
  if (!id) {
    return res.status(400).json({ 
      error: 'Missing parameter',
      message: 'id parameter is required. Example: ?id=tt33014583'
    });
  }
  
  try {
    console.log(`🎬 Processing request for ID: ${id}`);
    
    // Fetch the player page directly (domain is known)
    const playerUrl = `https://gemma416okl.com/play/${id}`;
    console.log(`📡 Fetching: ${playerUrl}`);
    
    const response = await fetch(playerUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://allmovieland.link/'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    console.log(`📄 Page fetched, size: ${html.length} bytes`);
    
    // Extract video data from script
    let videoData = null;
    let match = html.match(/let p3 = (\{[^;]+\});/);
    
    if (!match) {
      match = html.match(/var p3 = (\{[^;]+\});/);
    }
    
    if (!match) {
      match = html.match(/window\.p3 = (\{[^;]+\});/);
    }
    
    if (match) {
      try {
        videoData = JSON.parse(match[1]);
        console.log('✅ Video data extracted successfully');
      } catch (e) {
        console.error('Failed to parse video data:', e.message);
      }
    }
    
    if (!videoData || !videoData.file) {
      return res.status(404).json({
        error: 'Video data not found',
        message: 'Could not extract stream information from the page',
        htmlPreview: html.substring(0, 300)
      });
    }
    
    console.log(`📹 Stream file: ${videoData.file.substring(0, 100)}...`);
    
    // Get the actual stream URL if it's a .txt file
    let streamUrl = videoData.file;
    
    if (streamUrl && streamUrl.endsWith('.txt')) {
      console.log('📄 Fetching playlist from .txt file...');
      const playlistResponse = await fetch(streamUrl, {
        headers: {
          'X-CSRF-TOKEN': videoData.key,
          'Referer': `https://${videoData.host || 'keymi417exx.com'}/`,
          'User-Agent': 'Mozilla/5.0'
        }
      });
      
      if (playlistResponse.ok) {
        streamUrl = await playlistResponse.text();
        streamUrl = streamUrl.trim();
        console.log('✅ Playlist fetched successfully');
      }
    }
    
    // Return the stream URL
    return res.status(200).json({
      success: true,
      id: id,
      streamUrl: streamUrl,
      type: 'm3u8',
      quality: '1080p',
      headers: {
        'X-CSRF-TOKEN': videoData.key,
        'Referer': `https://${videoData.host}/`
      }
    });
    
  } catch (error) {
    console.error('💥 Error:', error.message);
    
    return res.status(500).json({
      error: 'Failed to fetch stream',
      details: error.message,
      id: id
    });
  }
}
