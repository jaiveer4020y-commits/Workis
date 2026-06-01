# api/index.py
from flask import Flask, request, jsonify
import requests
import re
import json
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse
import ssl
from requests.packages.urllib3.exceptions import InsecureRequestWarning

# Disable SSL warnings for testing (remove in production if needed)
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
        # Disable SSL verification for domains with certificate issues
        self.session.verify = False
        self.player_domain = None
    
    def get_player_domain(self):
        """Extract AwsIndStreamDomain from player.js"""
        if self.player_domain:
            return self.player_domain
        
        try:
            response = self.session.get(self.player_js_url, timeout=10)
            # Extract domain using regex - look for the domain pattern
            domain_match = re.search(r"const AwsIndStreamDomain\s*=\s*'([^']+)';", response.text)
            if domain_match:
                self.player_domain = domain_match.group(1).rstrip('/')
                return self.player_domain
            
            # Fallback: look for any domain pattern in the JS
            alt_match = re.search(r"https?://[a-zA-Z0-9.-]+\.(?:com|net|org|site|xyz)/?", response.text)
            if alt_match:
                self.player_domain = alt_match.group(0).rstrip('/')
                return self.player_domain
                
            return None
        except Exception as e:
            print(f"Error fetching player.js: {e}")
            return None
    
    def extract_video_id_from_page(self, page_url):
        """Extract video ID from page URL or content"""
        # Check if URL already contains /play/ID pattern
        play_match = re.search(r'/play/(\d+|tt\d+)', page_url)
        if play_match:
            return play_match.group(1)
        
        # Check if it's a movie/series page
        movie_match = re.search(r'/(?:movie|film|series|cartoon)/(\d+|[a-zA-Z0-9-]+)', page_url)
        if movie_match:
            try:
                # Fetch page and extract video ID
                response = self.session.get(page_url, timeout=10)
                soup = BeautifulSoup(response.text, 'html.parser')
                
                # Look for IndStreamPlayerConfigs
                for script in soup.find_all('script'):
                    if script.string:
                        src_match = re.search(r'src\s*:\s*["\'](\d+|tt\d+)["\']', script.string)
                        if src_match:
                            return src_match.group(1)
                        
                        config_match = re.search(r'IndStreamPlayerConfigs\s*=\s*\{[^}]*"src"\s*:\s*["\'](\d+|tt\d+)["\']', script.string)
                        if config_match:
                            return config_match.group(1)
            except:
                pass
        
        # If everything fails, return the last part of URL as potential ID
        return page_url.rstrip('/').split('/')[-1]
    
    def extract_m3u8_from_player_page(self, video_id):
        """Extract m3u8 directly using player domain and video ID"""
        player_domain = self.get_player_domain()
        if not player_domain:
            return {'error': 'Could not extract player domain from player.js'}
        
        # Try multiple possible URL formats
        player_urls = [
            f"{player_domain}/play/{video_id}",
            f"{player_domain}/play/{video_id}/",
            f"{player_domain}/embed/{video_id}",
            f"{player_domain}/video/{video_id}"
        ]
        
        m3u8_urls = []
        last_error = None
        
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
                    
                    # Pattern 4: Look for playlist URLs
                    playlist_matches = re.findall(r'/(?:playlist|hls|stream)/[^\s"\']+\.m3u8', response.text)
                    for match in playlist_matches:
                        full_url = urljoin(player_domain, match)
                        m3u8_urls.append(full_url)
                    
                    # If we found m3u8 links, break out of the loop
                    if m3u8_urls:
                        break
                        
            except requests.exceptions.SSLError as e:
                last_error = f"SSL Error for {player_url}: {str(e)}"
                continue
            except Exception as e:
                last_error = str(e)
                continue
        
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
                'player_domain': player_domain,
                'video_id': video_id,
                'm3u8_links': unique_urls
            }
        else:
            return {
                'error': 'No m3u8 links found',
                'player_domain': player_domain,
                'video_id': video_id,
                'debug_error': last_error,
                'attempted_urls': player_urls
            }
    
    def extract_from_raw_url(self, raw_url):
        """Extract m3u8 from a raw /play/ URL"""
        # Extract video ID from the URL
        video_id_match = re.search(r'/play/(\d+|tt\d+)', raw_url)
        if video_id_match:
            video_id = video_id_match.group(1)
            return self.extract_m3u8_from_player_page(video_id)
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
            video_id = extractor.extract_video_id_from_page(url)
            result = extractor.extract_m3u8_from_player_page(video_id)
    else:
        return jsonify({'error': 'Either id or url parameter required'}), 400
    
    return jsonify(result)

@app.route('/api/player-domain', methods=['GET'])
def player_domain():
    """Get current player domain"""
    domain = extractor.get_player_domain()
    if domain:
        return jsonify({
            'success': True,
            'player_domain': domain,
            'source': extractor.player_js_url
        })
    return jsonify({'error': 'Could not fetch player domain'}), 500

@app.route('/api/extract-from-example', methods=['GET'])
def extract_from_example():
    """Test with the example URL you provided"""
    example_url = "https://piexe411qok.com//play/tt42730027"
    result = extractor.extract_from_raw_url(example_url)
    return jsonify(result)

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy'})

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        'service': 'AllMovieLand M3U8 Extractor',
        'endpoints': {
            '/api/player-domain': 'GET - Get current player domain from player.js',
            '/api/extract': 'GET/POST - Extract m3u8 (use ?id=VIDEO_ID or ?url=PAGE_URL)',
            '/api/extract-from-example': 'GET - Test with example URL',
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
