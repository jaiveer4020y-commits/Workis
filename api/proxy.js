// api/proxy.js
// Polyfill for btoa in Vercel serverless environment (Node 18+ has it, but safe)
if (typeof btoa === 'undefined') {
    global.btoa = function(str) {
        return Buffer.from(str).toString('base64');
    };
}

// Helper: fetch with proper headers and handle response
async function fetchWithHeaders(url, options = {}) {
    const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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

// Step 1: Get TMDB metadata (title, year, imdbId) using your existing proxy
async function getTmdbMetadata(type, tmdbId, season, episode) {
    const tmdbProxy = 'https://search-proxy.bingeoutofficial.workers.dev';
    if (type === 'movie') {
        const res = await fetch(`${tmdbProxy}/movie/${tmdbId}`);
        if (!res.ok) throw new Error('TMDB movie fetch failed');
        const data = await res.json();
        const imdbRes = await fetch(`${tmdbProxy}/movie/${tmdbId}/external_ids`);
        const imdbData = imdbRes.ok ? await imdbRes.json() : {};
        return {
            title: data.title,
            year: data.release_date ? data.release_date.slice(0,4) : '',
            imdbId: imdbData.imdb_id || null
        };
    } else { // tv
        const seriesRes = await fetch(`${tmdbProxy}/tv/${tmdbId}`);
        if (!seriesRes.ok) throw new Error('TMDB TV series fetch failed');
        const seriesData = await seriesRes.json();
        const imdbRes = await fetch(`${tmdbProxy}/tv/${tmdbId}/external_ids`);
        const imdbData = imdbRes.ok ? await imdbRes.json() : {};
        // Optionally fetch episode title, but not required for VideoEasy
        return {
            title: seriesData.name,
            year: seriesData.first_air_date ? seriesData.first_air_date.slice(0,4) : '',
            imdbId: imdbData.imdb_id || null,
            season,
            episode
        };
    }
}

// Step 2: Call VideoEasy API to get encrypted hex
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Only GET method for now (you can add POST later if needed)
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { id, s, e } = req.query;
    if (!id) {
        return res.status(400).json({ error: 'Missing TMDB id parameter' });
    }

    try {
        const isTV = (s !== undefined && e !== undefined);
        const type = isTV ? 'tv' : 'movie';
        const season = isTV ? parseInt(s, 10) : null;
        const episode = isTV ? parseInt(e, 10) : null;

        // 1. Get metadata
        const meta = await getTmdbMetadata(type, id, season, episode);
        console.log('[Proxy] Metadata:', meta);

        // 2. Get encrypted hex from VideoEasy
        const hex = await getVideoEasyHex(type, id, season, episode, meta.title, meta.year, meta.imdbId);

        // 3. Decrypt
        const sources = await decryptHex(hex);

        // Optionally pick the best source (English first, then first available)
        const bestSource = sources.find(s => s.quality?.toLowerCase() === 'english') || sources[0];

        // Return the full sources array + best URL
        res.status(200).json({
            status: 'success',
            sources: sources,
            best: bestSource
        });
    } catch (error) {
        console.error('[Proxy] Error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
}
