# api/index.py
from flask import Flask, request, jsonify
import requests
import re
import json
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import ssl
from requests.packages.urllib3.exceptions import InsecureRequestWarning

requests.packages.urllib3.disable_warnings(InsecureRequestWarning)

app = Flask(__name__)

class AllMovieLandM3UExtractor:
    def __init__(self):
        self.main_url = "https://allmovieland.you"
        self.player_js_url = f"{self.main_url}/player.js?v=60%20128"
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Referer': self.main_url
        })
        self.session.verify = False
        self.player_domain = None
    
    def extract_domain_from_url(self, url):
        """Extract domain from the provided URL"""
        parsed = urlparse(url)
        return f"{parsed.scheme}://{parsed.netloc}"
    
    def get_player_domain(self, fallback_domain=None):
        """Extract AwsIndStreamDomain from player.js, with fallback"""
        if self.player_domain:
            return self.player_domain
        
        try:
            response = self.session.get(self.player_js_url, timeout=10)
            # Extract domain using regex
            domain_match = re.search(r"const AwsIndStreamDomain\s*=\s*'([^']+)';", response.text)
            if domain_match:
                self.player_domain = domain_match.group(1).rstrip('/')
                
                # Test if the domain is working
                test_url = f"{self.player_domain}/play/test"
                try:
                    test_response = self.session.get(test_url, timeout=5, verify=False)
                    if test_response.status_code == 404:  # 404 means domain is alive but no content
                        return self.player_domain
                except:
                    # Domain failed, use fallback
                    if fallback_domain:
                        print(f"Domain {self.player_domain} failed, using fallback {fallback_domain}")
                        self.player_domain = fallback_domain
                    return self.player_domain
                
                return self.player_domain
            
            # Fallback: look for any domain pattern in the JS
            alt_match = re.search(r"https?://[a-zA-Z0-9.-]+\.(?:com|net|org|site|xyz)/?", response.text)
            if alt_match:
                self.player_domain = alt_match.group(0).rstrip('/')
                return self.player_domain
                
            return fallback_domain
        except Exception as e:
            print(f"Error fetching player.js: {e}")
            return fallback_domain
    
    def extract_m3u8_from_player_page(self, video_id, base_domain=None):
        """Extract m3u8 directly using player domain and video ID"""
        
        # Try multiple domain sources in order of priority:
        # 1. Domain extracted from the URL (most reliable)
        # 2. Domain from player.js
        domains_to_try = []
        
        if base_domain:
            domains_to_try.append(base_domain)
        
        js_domain = self.get_player_domain()
        if js_domain and js_domain != base_domain:
            domains_to_try.append(js_domain)
        
        # Also try the raw video ID as a domain (some players use ID as subdomain)
        if video_id.startswith('tt'):
            domains_to_try.append(f"https://{video_id}.com")
        
        m3u8_urls = []
        last_error = None
        
        for player_domain in domains_to_try:
            if not player_domain:
                continue
                
            player_domain = player_domain.rstrip('/')
            
            # Try multiple possible URL formats
            player_urls = [
                f"{player_domain}/play/{video_id}",
                f"{player_domain}/play/{video_id}/",
                f"{player_domain}/embed/{video_id}",
                f"{player_domain}/video/{video_id}",
                f"{player_domain}/hls/{video_id}.m3u8",
                f"{player_domain}/stream/{video_id}.m3u8"
            ]
            
            for player_url in player_urls:
                try:
                    print(f"Trying: {player_url}")
                    response = self.session.get(player_url, timeout=10, verify=False)
                    
                    if response.status_code == 200:
                        # Look for m3u8 in response
                        # Pattern 1: Direct .m3u8 URLs
                        m3u8_matches = re.findall(r'https?://[^\s"\']+\.m3u8[^\s"\']*', response.text)
                        m3u8_urls.extend(m3u8_matches)
                        
                        # Pattern 2: Relative .m3u8 paths
                        rel_matches = re.findall(r'["\'](/[^\s"\']+\.m3u8[^\s"\']*)["\']', response.text)
                        for match in rel_matches:
                            full_url = urljoin(player_domain, match)
                            m3u8_urls.append(full_url)
                        
                        # Pattern 3: Look for source tags if HTML
                        if '<video' in response.text or '<source' in response.text:
                            soup = BeautifulSoup(response.text, 'html.parser')
                            sources = soup.find_all('source', src=re.compile(r'\.m3u8'))
                            for source in sources:
                                src = source.get('src')
                                if src:
                                    if not src.startswith('http'):
                                        src = urljoin(player_domain, src)
                                    m3u8_urls.append(src)
                        
                        # Pattern 4: Look for file property in JSON
                        json_match = re.search(r'\{[^{}]*"file"\s*:\s*"([^"]+\.m3u8[^"]*)"[^{}]*\}', response.text)
                        if json_match:
                            file_url = json_match.group(1)
                            if not file_url.startswith('http'):
                                file_url = urljoin(player_domain, file_url)
                            m3u8_urls.append(file_url)
                        
                        # If we found m3u8 links, break out
                        if m3u8_urls:
                            break
                            
                except requests.exceptions.SSLError as e:
                    last_error = f"SSL Error for {player_url}: {str(e)}"
                    continue
                except Exception as e:
                    last_error = str(e)
                    continue
            
            if m3u8_urls:
                break
        
        # Remove duplicates
        unique_urls = []
        seen = set()
        for url in m3u8_urls:
            if url not in seen:
                seen.add(url)
                unique_urls.append(url)
        
        if unique_urls:
            return {
                'success': True,
                'player_domain': domains_to_try[0] if domains_to_try else None,
                'video_id': video_id,
                'm3u8_links': unique_urls
            }
        else:
            return {
                'error': 'No m3u8 links found',
                'domains_tried': domains_to_try,
                'video_id': video_id,
                'debug_error': last_error
            }
    
    def extract_from_raw_url(self, raw_url):
        """Extract m3u8 from a raw /play/ URL"""
        # Extract domain from the URL itself
        domain = self.extract_domain_from_url(raw_url)
        
        # Extract video ID from the URL
        video_id_match = re.search(r'/play/(\d+|tt\d+)', raw_url)
        if video_id_match:
            video_id = video_id_match.group(1)
            return self.extract_m3u8_from_player_page(video_id, base_domain=domain)
        else:
            return {'error': 'Invalid URL format. Expected /play/ID pattern'}

extractor = AllMovieLandM3UExtractor()

@app.route('/api/extract', methods=['GET', 'POST'])
def extract():
    """Extract m3u8 from video ID or URL"""
    if request.method == 'GET':
        video_id = request.args.get('id')
        url = request.args.get('url')
    else:
        data = request.get_json()
        video_id = data.get('id') if data else None
        url = data.get('url') if data else None
    
    if video_id:
        result = extractor.extract_m3u8_from_player_page(video_id)
    elif url:
        # Check if URL is a direct /play/ URL or a page URL
        if '/play/' in url:
            result = extractor.extract_from_raw_url(url)
        else:
            # Extract video ID from page URL
            domain = extractor.extract_domain_from_url(url)
            video_id_match = re.search(r'/(\d+|tt\d+)', url)
            if video_id_match:
                video_id = video_id_match.group(1)
                result = extractor.extract_m3u8_from_player_page(video_id, base_domain=domain)
            else:
                result = {'error': 'Could not extract video ID from URL'}
    else:
        return jsonify({'error': 'Either id or url parameter required'}), 400
    
    return jsonify(result)

@app.route('/api/extract-from-example', methods=['GET'])
def extract_from_example():
    """Test with the example URL you provided"""
    example_url = "https://piexe411qok.com//play/tt42730027"
    result = extractor.extract_from_raw_url(example_url)
    return jsonify(result)

@app.route('/api/player-domain', methods=['GET'])
def player_domain():
    """Get current player domain from player.js"""
    domain = extractor.get_player_domain()
    if domain:
        return jsonify({
            'success': True,
            'player_domain': domain,
            'source': extractor.player_js_url,
            'note': 'This domain may be outdated. Use /api/extract with a URL for best results.'
        })
    return jsonify({'error': 'Could not fetch player domain'}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy'})

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        'service': 'AllMovieLand M3U8 Extractor',
        'note': 'player.js may return outdated domains. For best results, provide the full video URL.',
        'endpoints': {
            '/api/extract': 'GET/POST - Extract m3u8 (use ?id=VIDEO_ID or ?url=PAGE_URL)',
            '/api/extract-from-example': 'GET - Test with example URL',
            '/api/player-domain': 'GET - Get current player domain from player.js (may be outdated)',
            '/api/health': 'GET - Health check'
        },
        'examples': [
            '/api/extract?id=tt42730027',
            '/api/extract?url=https://piexe411qok.com//play/tt42730027',
            '/api/extract?url=https://allmovieland.you/movie/12345'
        ]
    })

if __name__ == '__main__':
    app.run(debug=True)
