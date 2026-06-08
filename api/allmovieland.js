// api/allmovieland.js

// ======================== CONFIGURATION ========================
// PRIMARY PROXY (your existing proxy)
const PROXY_URL = 'https://workingg.vercel.app/api/proxy?source=2&url=';

// BACKUP PROXY (using a public CORS proxy as a reliable fallback)
const BACKUP_PROXY_URL = 'https://api.allorigins.win/raw?url=';

// Set to 'true' to use direct fetch (bypasses Vercel CORS, may fail)
const FORCE_DIRECT = false;  
// ==============================================================

/**
 * Fetch any URL via proxy or directly.
 * @param {string} url - The target URL to fetch.
 * @param {Object} options - Fetch options (method, headers, body).
 * @param {boolean} useProxyFirst - Whether to attempt proxy first.
 * @returns {Promise<Response>} - The fetch response.
 */
async function fetchViaProxy(url, options = {}, useProxyFirst = true) {
    // Try direct fetch if forced (won't work in browser)
    if (FORCE_DIRECT) {
        console.log(`[Direct] Fetching ${url}`);
        const response = await fetch(url, options);
        if (response.ok) return response;
        throw new Error(`Direct fetch failed: ${response.status}`);
    }

    // Try primary proxy
    if (useProxyFirst && PROXY_URL) {
        const proxyUrl = PROXY_URL + encodeURIComponent(url);
        console.log(`[Proxy] Trying primary proxy: ${proxyUrl}`);
        try {
            const response = await fetch(proxyUrl, {
                method: options.method || 'GET',
                headers: options.headers || {},
            });
            if (response.ok) return response;
            console.warn(`Primary proxy returned ${response.status}, trying backup...`);
        } catch (err) {
            console.warn(`Primary proxy error: ${err.message}`);
        }
    }

    // Try backup proxy if available
    if (BACKUP_PROXY_URL) {
        const backupUrl = BACKUP_PROXY_URL + encodeURIComponent(url);
        console.log(`[Proxy] Trying backup proxy: ${backupUrl}`);
        const response = await fetch(backupUrl, {
            method: options.method || 'GET',
            headers: options.headers || {},
        });
        if (response.ok) return response;
        throw new Error(`Backup proxy failed: ${response.status}`);
    }

    throw new Error('No proxy available or all proxies failed');
}

/**
 * Fetch and extract the streaming domain from player.js.
 * @returns {Promise<string>} - The current streaming domain.
 */
async function getStreamingDomain() {
    const playerUrl = 'https://allmovieland.link/player.js?v=60%20128';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cache-Control': 'max-age=0'
    };
    const res = await fetchViaProxy(playerUrl, { headers });
    const text = await res.text();

    const patterns = [
        /const\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
        /let\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
        /var\s+AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
        /AwsIndStreamDomain\s*=\s*['"]([^'"]+)['"]/,
        /['"]AwsIndStreamDomain['"]\s*:\s*['"]([^'"]+)['"]/
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            let domain = match[1];
            if (!domain.startsWith('http')) domain = 'https://' + domain;
            return domain;
        }
    }
    throw new Error('Could not extract streaming domain from player.js');
}

/**
 * Extract the p3 object from the movie page HTML.
 * @param {string} html - The HTML content of the movie page.
 * @returns {Object|null} - The p3 object or null.
 */
function extractP3(html) {
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
            } catch (e) { /* ignore */ }
        }
    }
    return null;
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    let { id, season, episode, debug } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id parameter' });
    if (season) season = parseInt(season);
    if (episode) episode = parseInt(episode);

    const debugLog = [];

    try {
        // 1. Get streaming domain
        const domain = await getStreamingDomain();
        debugLog.push(`Streaming domain: ${domain}`);

        // 2. Construct movie/TV page URL
        let pageUrl = `${domain}/play/${id}`;
        if (season && episode) pageUrl += `/s${season}-e${episode}`;
        debugLog.push(`Page URL: ${pageUrl}`);

        // 3. Fetch movie/TV page (via proxy)
        const pageRes = await fetchViaProxy(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://allmovieland.one/'
            }
        });
        const html = await pageRes.text();
        debugLog.push(`Page loaded, ${html.length} bytes`);

        // 4. Extract p3 object
        const p3 = extractP3(html);
        if (!p3) throw new Error('No p3 object found');
        debugLog.push('p3 object extracted');

        // 5. Fetch language list (first .txt file)
        let langUrl = p3.file;
        if (langUrl.startsWith('/playlist')) langUrl = domain + langUrl;
        else if (!langUrl.startsWith('http')) langUrl = domain + '/playlist/' + langUrl;
        debugLog.push(`Language list URL: ${langUrl}`);

        const langRes = await fetchViaProxy(langUrl, {
            headers: {
                'X-CSRF-TOKEN': p3.key,
                'Referer': 'https://allmovieland.link/'
            }
        });
        const languages = await langRes.json();
        debugLog.push(`Languages: ${languages.map(l => l.title).join(', ')}`);

        // 6. For each language, get the actual stream
        const streams = [];
        for (const lang of languages) {
            if (!lang.file || lang.file === '-') continue;
            let streamUrl = lang.file;
            if (streamUrl.startsWith('/playlist')) streamUrl = domain + streamUrl;
            else if (streamUrl.startsWith('~')) streamUrl = domain + '/playlist' + streamUrl;
            else if (!streamUrl.startsWith('http')) streamUrl = domain + '/playlist/' + streamUrl;
            if (!streamUrl.endsWith('.txt')) streamUrl += '.txt';

            const streamRes = await fetchViaProxy(streamUrl, {
                headers: {
                    'X-CSRF-TOKEN': p3.key,
                    'Referer': 'https://allmovieland.one/'
                }
            });
            if (!streamRes.ok) {
                debugLog.push(`${lang.title} stream failed: ${streamRes.status}`);
                continue;
            }
            const content = await streamRes.text();
            const trimmed = content.trim();

            if (trimmed.startsWith('[')) {
                // Nested qualities (different resolutions / audio)
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
                // Direct M3U8 URL
                streams.push({ language: lang.title, url: trimmed });
            } else {
                // Probably the URL itself (without http prefix) – rare
                streams.push({ language: lang.title, url: streamUrl });
            }
        }

        if (streams.length === 0) throw new Error('No streams extracted');

        const response = { success: true, streams };
        if (debug === 'true') response.debug = debugLog;
        return res.status(200).json(response);
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            error: err.message,
            debug: debug === 'true' ? debugLog : undefined
        });
    }
}
