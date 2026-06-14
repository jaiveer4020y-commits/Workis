// api/proxy.js
if (typeof btoa === 'undefined') {
    global.btoa = function(str) {
        return Buffer.from(str).toString('base64');
    };
}

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
        let errorBody = '';
        try { errorBody = await response.text(); } catch(e) {}
        throw new Error(`HTTP ${response.status}: ${response.statusText} – ${errorBody.substring(0, 500)}`);
    }
    return response;
}

async function getTmdbMetadata(type, tmdbId, season, episode) {
    const tmdbProxy = 'https://search-proxy.bingeoutofficial.workers.dev';
    if (type === 'movie') {
        const res = await fetch(`${tmdbProxy}/movie/${tmdbId}`);
        if (!res.ok) throw new Error('TMDB movie fetch failed');
        const data = await res.json();
        let imdbId = null;
        try {
            const imdbRes = await fetch(`${tmdbProxy}/movie/${tmdbId}/external_ids`);
            if (imdbRes.ok) imdbId = (await imdbRes.json()).imdb_id;
        } catch (e) {}
        return {
            title: data.title,
            year: data.release_date ? data.release_date.slice(0,4) : '',
            imdbId: imdbId
        };
    } else {
        const seriesRes = await fetch(`${tmdbProxy}/tv/${tmdbId}`);
        if (!seriesRes.ok) throw new Error('TMDB TV series fetch failed');
        const seriesData = await seriesRes.json();
        let imdbId = null;
        try {
            const imdbRes = await fetch(`${tmdbProxy}/tv/${tmdbId}/external_ids`);
            if (imdbRes.ok) imdbId = (await imdbRes.json()).imdb_id;
        } catch (e) {}
        return {
            title: seriesData.name,
            year: null,
            imdbId: imdbId,
            season: season,
            episode: episode
        };
    }
}

async function getVideoEasyHex(type, tmdbId, season, episode, title, year, imdbId) {
    const params = new URLSearchParams();
    // Use the title exactly as from TMDB (do not uppercase)
    params.append('title', title);
    params.append('mediaType', type === 'tv' ? 'tv' : 'movie');
    if (type === 'movie' && year) params.append('year', year);
    params.append('tmdbId', tmdbId);
    if (type === 'tv') {
        if (season) params.append('seasonId', String(season));
        if (episode) params.append('episodeId', String(episode));
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
    return data.result.sources;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { id, s, e } = req.query;
    if (!id) return res.status(400).json({ status: 'error', message: 'Missing id parameter' });

    try {
        const isTV = (s !== undefined && e !== undefined);
        const type = isTV ? 'tv' : 'movie';
        const season = isTV ? parseInt(s, 10) : null;
        const episode = isTV ? parseInt(e, 10) : null;

        console.log(`[Proxy] Request: type=${type}, id=${id}, s=${season}, e=${episode}`);

        const metadata = await getTmdbMetadata(type, id, season, episode);
        console.log('[Proxy] Metadata:', metadata);

        const hex = await getVideoEasyHex(type, id, season, episode, metadata.title, metadata.year, metadata.imdbId);
        const sources = await decryptHex(hex);
        if (!sources.length) throw new Error('No sources returned');

        const best = sources.find(s => s.quality?.toLowerCase() === 'english') || sources[0];
        return res.status(200).json({ status: 'success', sources, best });
    } catch (error) {
        console.error('[Proxy] Error:', error);
        // Provide a user-friendly message
        let message = error.message;
        if (message.includes('HTTP 500')) {
            message = 'VideoEasy server returned an error – the requested content may not be available.';
        }
        return res.status(500).json({ status: 'error', message });
    }
}
