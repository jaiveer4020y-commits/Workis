/**
 * videasy.js – VideoEasy source resolver
 * 
 * Usage:
 *   import { getVideoEasySource } from './videasy.js';
 *   // or with script tag: const { getVideoEasySource } = window.videasy;
 * 
 *   const streamUrl = await getVideoEasySource({
 *       type: 'movie',          // 'movie' or 'tv'
 *       tmdbId: '550',          // TMDB ID
 *       season: 1,              // required for TV
 *       episode: 1,             // required for TV
 *       title: 'Fight Club',    // movie title or TV series name
 *       year: '1999',           // optional (movie only)
 *       imdbId: 'tt0137523'     // optional, but recommended
 *   });
 * 
 *   // Then play streamUrl with your HLS player.
 */

// ==================== CONFIGURATION ====================
// Set your CORS proxy URL (must accept both GET and POST and forward headers)
// Example: "https://your-proxy.workers.dev/?url="
const PROXY_ENABLED = true;                         // set to false only for local testing (CORS disabled)
const PROXY_BASE_URL = "https://workingg.vercel.app/api/proxy?source=2&url="; // ← CHANGE THIS TO YOUR OWN PROXY

// Endpoints (do not change)
const VIDEASY_API = "https://api.videasy.to/hdmovie/sources-with-title";
const DECRYPT_API = "https://enc-dec.app/api/dec-videasy";

// ==================== INTERNAL HELPERS ====================
async function _fetchWithProxy(url, options = {}) {
    const finalUrl = PROXY_ENABLED ? PROXY_BASE_URL + encodeURIComponent(url) : url;
    const response = await fetch(finalUrl, {
        ...options,
        headers: {
            ...options.headers,
            "Origin": "https://player.videasy.to",
            "Referer": "https://player.videasy.to/"
        }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return response;
}

async function _decryptHex(hexString) {
    const cleanHex = hexString.replace(/\s+/g, '');
    const response = await _fetchWithProxy(DECRYPT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleanHex })
    });
    const data = await response.json();
    if (data.status !== 200 || !data.result || !Array.isArray(data.result.sources)) {
        throw new Error("Invalid decrypt response");
    }
    return data.result.sources;
}

// ==================== PUBLIC API ====================
/**
 * Get a playable stream URL from VideoEasy.
 * @param {Object} params
 * @param {string} params.type - 'movie' or 'tv'
 * @param {string|number} params.tmdbId - TMDB ID
 * @param {number} [params.season] - required for TV
 * @param {number} [params.episode] - required for TV
 * @param {string} params.title - movie title or TV series name
 * @param {string} [params.year] - release year (movie only)
 * @param {string} [params.imdbId] - IMDb ID (optional but helps)
 * @returns {Promise<string>} - Direct .m3u8 URL
 */
export async function getVideoEasySource({ type, tmdbId, season, episode, title, year, imdbId }) {
    if (!tmdbId || !title) {
        throw new Error("Missing required parameters: tmdbId and title");
    }
    if (type === 'tv' && (season === undefined || episode === undefined)) {
        throw new Error("For TV type, season and episode are required");
    }

    const params = new URLSearchParams();
    params.append("title", title);
    params.append("mediaType", type === "tv" ? "tv" : "movie");
    if (year) params.append("year", year);
    params.append("tmdbId", tmdbId);
    if (type === "tv") {
        params.append("seasonId", season);
        params.append("episodeId", episode);
    }
    if (imdbId) params.append("imdbId", imdbId);

    const requestUrl = `${VIDEASY_API}?${params.toString()}`;
    console.log("[VideoEasy] Requesting:", requestUrl);

    // Step 1: fetch encrypted hex
    const hexResponse = await _fetchWithProxy(requestUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
    });
    const hexText = await hexResponse.text();
    if (!hexText || hexText.length < 50) {
        throw new Error("Empty or invalid hex response from VideoEasy");
    }

    // Step 2: decrypt to get source list
    const sources = await _decryptHex(hexText);
    if (!sources.length) throw new Error("No sources found in decrypted data");

    // Step 3: pick best quality (English > first)
    const best = sources.find(s => s.quality?.toLowerCase() === "english") ||
                 sources.find(s => s.quality?.toLowerCase() === "original") ||
                 sources[0];
    console.log("[VideoEasy] Selected source:", best.quality, best.url);
    return best.url;
}

// For non‑module usage (script tag)
if (typeof window !== 'undefined') {
    window.videasy = { getVideoEasySource };
}
