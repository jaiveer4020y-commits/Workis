# api/index.py
from flask import Flask, request, jsonify
import requests
import re
import json
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse

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
        self.player_domain = None
    
    def get_player_domain(self):
        """Extract AwsIndStreamDomain from player.js"""
        if self.player_domain:
            return self.player_domain
        
        try:
            response = self.session.get(self.player_js_url)
            # Extract domain using regex
            domain_match = re.search(r"const AwsIndStreamDomain\s*=\s*'([^']+)';", response.text)
            if domain_match:
                self.player_domain = domain_match.group(1).rstrip('/')
                return self.player_domain
            return None
        except Exception as e:
            print(f"Error fetching player.js: {e}")
            return None
    
    def extract_m3u8_from_player_page(self, video_id):
        """Extract m3u8 directly using player domain and video ID"""
        player_domain = self.get_player_domain()
        if not player_domain:
            return {'error': 'Could not extract player domain'}
        
        try:
            # Construct the player URL
            player_url = f"{player_domain}/play/{video_id}"
            
            # Get the player page
            response = self.session.get(player_url)
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Look for the JSON data in scripts
            m3u8_urls = []
            
            # Method 1: Look for file URLs in script tags
            for script in soup.find_all('script'):
                if script.string:
                    # Look for .m3u8 URLs
                    m3u8_matches = re.findall(r'https?://[^\s"\']+\.m3u8[^\s"\']*', script.string)
                    m3u8_urls.extend(m3u8_matches)
                    
                    # Look for JSON with file property
                    json_match = re.search(r'\{[^{}]*"file"\s*:\s*"([^"]+\.m3u8[^"]*)"[^{}]*\}', script.string)
                    if json_match:
                        m3u8_urls.append(json_match.group(1))
                    
                    # Look for playlist URLs
                    playlist_match = re.findall(r'/(?:playlist|hls|stream)/[^\s"\']+\.m3u8', script.string)
                    for match in playlist_match:
                        full_url = urljoin(player_domain, match)
                        m3u8_urls.append(full_url)
            
            # Method 2: Look for source tags in video elements
            video_sources = soup.select('video source[src*=".m3u8"]')
            for source in video_sources:
                src = source.get('src')
                if src:
                    if not src.startswith('http'):
                        src = urljoin(player_domain, src)
                    m3u8_urls.append(src)
            
            # Method 3: Check iframe sources
            iframes = soup.find_all('iframe')
            for iframe in iframes:
                src = iframe.get('src')
                if src and '.m3u8' in src:
                    if not src.startswith('http'):
                        src = urljoin(player_domain, src)
                    m3u8_urls.append(src)
            
            # Remove duplicates while preserving order
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
                    'video_id': video_id
                }
                
        except Exception as e:
            return {'error': str(e)}
    
    def extract_m3u8_from_embedded_player(self, page_url):
        """Extract video ID from page and get m3u8"""
        try:
            # Get the page content
            response = self.session.get(page_url)
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Extract video ID from the page
            video_id = None
            
            # Method 1: Look for IndStreamPlayerConfigs
            for script in soup.find_all('script'):
                if script.string:
                    # Look for src in player config
                    src_match = re.search(r'src\s*:\s*["\'](\d+)["\']', script.string)
                    if src_match:
                        video_id = src_match.group(1)
                        break
                    
                    # Look for IndStreamPlayerConfigs
                    config_match = re.search(r'IndStreamPlayerConfigs\s*=\s*\{[^}]*"src"\s*:\s*["\'](\d+)["\']', script.string)
                    if config_match:
                        video_id = config_match.group(1)
                        break
            
            if not video_id:
                # Method 2: Look for /play/ pattern in iframe or links
                player_link = soup.select_one('a[href*="/play/"], iframe[src*="/play/"]')
                if player_link:
                    href = player_link.get('href') or player_link.get('src')
                    play_match = re.search(r'/play/(\d+)', href)
                    if play_match:
                        video_id = play_match.group(1)
            
            if not video_id:
                return {'error': 'Could not extract video ID from page'}
            
            # Get m3u8 using the video ID
            return self.extract_m3u8_from_player_page(video_id)
            
        except Exception as e:
            return {'error': str(e)}

extractor = AllMovieLandM3UExtractor()

@app.route('/api/get-player-domain', methods=['GET'])
def get_player_domain():
    """Get the player domain from player.js"""
    domain = extractor.get_player_domain()
    if domain:
        return jsonify({
            'success': True,
            'player_domain': domain,
            'source': extractor.player_js_url
        })
    else:
        return jsonify({'error': 'Could not fetch player domain'}), 500

@app.route('/api/extract-m3u8', methods=['GET', 'POST'])
def extract_m3u8():
    """Extract m3u8 links using video ID or page URL"""
    if request.method == 'GET':
        video_id = request.args.get('video_id')
        page_url = request.args.get('page_url')
    else:
        data = request.get_json()
        video_id = data.get('video_id') if data else None
        page_url = data.get('page_url') if data else None
    
    if video_id:
        result = extractor.extract_m3u8_from_player_page(video_id)
    elif page_url:
        result = extractor.extract_m3u8_from_embedded_player(page_url)
    else:
        return jsonify({'error': 'Either video_id or page_url parameter is required'}), 400
    
    return jsonify(result)

@app.route('/api/extract-from-id', methods=['GET'])
def extract_from_id():
    """Simplified endpoint - just use video ID"""
    video_id = request.args.get('id')
    if not video_id:
        return jsonify({'error': 'Video ID parameter required (e.g., ?id=12345)'}), 400
    
    result = extractor.extract_m3u8_from_player_page(video_id)
    return jsonify(result)

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy'})

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        'service': 'AllMovieLand M3U8 Extractor',
        'endpoints': {
            '/api/get-player-domain': 'GET - Get player domain from player.js',
            '/api/extract-m3u8': 'GET/POST - Use ?video_id=ID or ?page_url=URL',
            '/api/extract-from-id': 'GET - Use ?id=VIDEO_ID (simplest)',
            '/api/health': 'GET - Health check'
        },
        'example': '/api/extract-from-id?id=12345'
    })

if __name__ == '__main__':
    app.run(debug=True)
