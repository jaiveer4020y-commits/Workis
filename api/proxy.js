// api/proxy.js
// Polyfill for btoa in older Node versions (Vercel uses Node 18+ but safe)
if (typeof btoa === 'undefined') {
    global.btoa = function(str) {
        return Buffer.from(str).toString('base64');
    };
}

// Helper: fetch with required headers for VideoEasy
async function fetchWithHeaders(url, options = {}) {
    const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Origin': 'https://player.videasy.to',
        'Referer': 'https://player.videasy.to/'
    };
    const response = await fetch(url, {
        ...options,
        headers: { ...defaultHeaders, ...options.headers }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response;
}

// Step 1: Get TMDB metadata (title, year, imdbId) using your bingeout proxy
async function getTmdbMetadata(type, tmdbId, season, episode) {
    const tmdbProxy = 'https://search-proxy.bingeoutofficial.workers.dev';
    if (type === 'movie') {
        const res = await fetch(`${tmdbProxy}/movie/${tmdbId}`);
        if (!res.ok) throw new Error('TMDB movie fetch failed');
        const data = await res.json();
        // Get IMDb ID
        let imdbId = null;
        try {
            const imdbRes = await fetch(`${tmdbProxy}/movie/${tmdbId}/external_ids`);
            if (imdbRes.ok) {
                const imdbData = await imdbRes.json();
                imdbId = imdbData.imdb_id;
            }
        } catch (e) {}
        return {
            title: data.title,
            year: data.release_date ? data.release_date.slice(0,4) : '',
            imdbId: imdbId
        };
    } else { // tv
        const seriesRes = await fetch(`${tmdbProxy}/tv/${tmdbId}`);
        if (!seriesRes.ok) throw new Error('TMDB TV series fetch failed');
        const seriesData = await seriesRes.json();
        let imdbId = null;
        try {
            const imdbRes = await fetch(`${tmdbProxy}/tv/${tmdbId}/external_ids`);
            if (imdbRes.ok) {
                const imdbData = await imdbRes.json();
                imdbId = imdbData.imdb_id;
            }
        } catch (e) {}
        return {
            title: seriesData.name,
            year: seriesData.first_air_date ? seriesData.first_air_date.slice(0,4) : '',
            imdbId: imdbId,
            season: season,
            episode: episode
        };
    }
}

// Step 2: Get encrypted hex from VideoEasy API
async function getVideoEasyHex(type, tmdbId, season, episode, title, year, imdbId) {
    const params = new URLSearchParams();
    params.append('title', title);
    params.append('mediaType', type === 'tv' ? 'tv' : 'movie');
    if (year) params.append('year', year);
    params.append('tmdbId', tmdbId);
    if (type === 'tv') {
        if (season) params.append('seasonId', season);
        if (episode) params.append('episodeId', episode);
    }
    if (imdbId) params.append('imdbId', imdbId);

    const videasyUrl = `https://api.videasy.to/hdmovie/sources-with-title?${params.toString()}`;
    console.log('[Proxy] VideoEasy URL:', videasyUrl);

    const response = await fetchWithHeaders(videasyUrl);
    const hexText = await response.text();
    if (!hexText || hexText.length < 50) {
        throw new Error('Invalid hex response from VideoEasy');
    }
    return hexText;
}

// Step 3: Decrypt hex via enc-dec.app
async function decryptHex(hexString) {
    const cleanHex = hexString.replace(/\s+/g, '');
    const decryptUrl = 'https://enc-dec.app/api/dec-videasy';
    const response = await fetchWithHeaders(decryptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanHex })
    });
    const data = await response.json();
    if (data.status !== 200 || !data.result || !data.result.sources) {
        throw new Error('Decrypt response invalid');
    }
    return data.result.sources; // array of { quality, url }
}

// Main handler
export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { id, s, e } = req.query;
    if (!id) {
        return res.status(400).json({ status: 'error', message: 'Missing id parameter' });
    }

    try {
        const isTV = (s !== undefined && e !== undefined);
        const type = isTV ? 'tv' : 'movie';
        const season = isTV ? parseInt(s, 10) : null;
        const episode = isTV ? parseInt(e, 10) : null;

        console.log(`[Proxy] Request: type=${type}, id=${id}, s=${season}, e=${episode}`);

        // 1. Get metadata from TMDB
        const metadata = await getTmdbMetadata(type, id, season, episode);
        console.log('[Proxy] Metadata:', metadata);

        // 2. Get encrypted hex from VideoEasy
        const hex = await getVideoEasyHex(type, id, season, episode, metadata.title, metadata.year, metadata.imdbId);

        // 3. Decrypt to get sources
        const sources = await decryptHex(hex);
        if (!sources.length) {
            throw new Error('No sources returned after decryption');
        }

        // 4. Pick best source (prefer English, then first)
        const best = sources.find(s => s.quality?.toLowerCase() === 'english') || sources[0];

        // 5. Return success response
        return res.status(200).json({
            status: 'success',
            sources: sources,
            best: best
        });
    } catch (error) {
        console.error('[Proxy] Error:', error);
        return res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
}
