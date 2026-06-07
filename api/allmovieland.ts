import type { VercelRequest, VercelResponse } from '@vercel/node';

interface AllMovielandPlaylist {
  key?: string;
  file?: string;
}

interface AllMovielandServer {
  id: string;
  file: string;
  title: string;
  folder?: Array<{
    episode: number;
    folder?: Array<{
      file: string;
      title: string;
    }>;
  }>;
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
  throw new Error(`Failed to fetch ${url}`);
}

async function getPlayerScript(): Promise<string> {
  const response = await fetchWithRetry(
    'https://allmovieland.link/player.js?v=60%20128',
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  return response.text();
}

function extractHost(script: string): string | null {
  const domainRegex = /const AwsIndStreamDomain.*'(.*)';/;
  const match = domainRegex.exec(script);
  return match?.[1] || null;
}

function parseJson<T>(jsonString: string): T | null {
  try {
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
}

async function getPlaylistData(host: string, id: string, referer: string): Promise<string | null> {
  const response = await fetchWithRetry(
    `${host}/play/${id}`,
    { headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0' } }
  );
  
  const html = await response.text();
  const scriptMatch = /playlist[^}]*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/.exec(html);
  
  if (!scriptMatch) return null;
  return scriptMatch[1];
}

async function getServers(fileUrl: string, host: string, key: string, referer: string): Promise<string> {
  const response = await fetchWithRetry(
    fileUrl,
    {
      headers: {
        'X-CSRF-TOKEN': key,
        Referer: referer,
        'User-Agent': 'Mozilla/5.0'
      }
    }
  );
  
  let text = await response.text();
  return text.replace(/,\s*\[\]/g, '');
}

async function getServerPath(host: string, serverId: string, key: string, referer: string): Promise<string> {
  const response = await fetchWithRetry(
    `${host}/playlist/${serverId}.txt`,
    {
      method: 'POST',
      headers: {
        'X-CSRF-TOKEN': key,
        Referer: referer,
        'User-Agent': 'Mozilla/5.0'
      }
    }
  );
  
  return response.text();
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
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { id, season, episode } = req.query;
  const allmovielandAPI = 'https://allmovieland.link';
  
  if (!id) {
    return res.status(400).json({ error: 'id parameter is required' });
  }
  
  try {
    // Get player script
    const playerScript = await getPlayerScript();
    const host = extractHost(playerScript);
    
    if (!host) {
      return res.status(500).json({ error: 'Could not extract host from player script' });
    }
    
    const referer = `${allmovielandAPI}/`;
    
    // Get playlist data
    const playlistData = await getPlaylistData(host, id as string, referer);
    if (!playlistData) {
      return res.status(404).json({ error: 'Playlist not found' });
    }
    
    const json = parseJson<AllMovielandPlaylist>(`{${playlistData}`);
    if (!json?.key || !json?.file) {
      return res.status(404).json({ error: 'Invalid playlist data' });
    }
    
    // Get servers
    const fixedUrl = json.file.startsWith('http') ? json.file : `${host}${json.file}`;
    const serversData = await getServers(fixedUrl, host, json.key, referer);
    const servers = parseJson<AllMovielandServer[]>(serversData);
    
    if (!servers) {
      return res.status(404).json({ error: 'No servers found' });
    }
    
    let serverList: Array<[string, string]> = [];
    
    if (!season) {
      serverList = servers.map(server => [server.file, server.title]);
    } else {
      const seasonNum = parseInt(season as string, 10);
      const episodeNum = episode ? parseInt(episode as string, 10) : undefined;
      
      const seasonData = servers.find(s => s.id === seasonNum.toString());
      if (seasonData?.folder) {
        if (episodeNum !== undefined) {
          const episodeData = seasonData.folder.find(f => f.episode === episodeNum);
          if (episodeData?.folder) {
            serverList = episodeData.folder.map(f => [f.file, f.title]);
          }
        } else {
          serverList = seasonData.folder.map(f => [f.file, f.title]);
        }
      }
    }
    
    // Fetch all server paths
    const results = await Promise.all(
      serverList.map(async ([server, lang]) => {
        if (!server) return null;
        
        const path = await getServerPath(host, server, json.key, referer);
        
        return {
          name: `Allmovieland [${lang}]`,
          url: path,
          type: 'm3u8',
          quality: '1080',
          referer: referer
        };
      })
    );
    
    const validResults = results.filter(r => r !== null);
    
    return res.status(200).json({
      success: true,
      sources: validResults
    });
    
  } catch (error) {
    console.error('Error in allmovieland handler:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
