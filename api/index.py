# api/index.py
import sys
import traceback

try:
    from flask import Flask, request, jsonify
    import requests
    import re
    import json
    from urllib.parse import urlparse
except ImportError as e:
    # Fallback for missing dependencies
    print(f"Import error: {e}")
    # Create a basic app without dependencies
    app = Flask(__name__)
    
    @app.route('/')
    def error_page():
        return jsonify({'error': 'Missing dependencies', 'details': str(e)}), 500
    
    @app.route('/api/health')
    def health():
        return jsonify({'status': 'error', 'message': 'Dependencies not installed'})
    
    @app.route('/api/extract')
    def extract_error():
        return jsonify({'error': 'Dependencies not installed properly'}), 500
    
    # Run the app
    if __name__ == '__main__':
        app.run()
else:
    app = Flask(__name__)

class AllMovieLandM3UExtractor:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        })
    
    def extract_m3u8_from_url(self, play_url):
        try:
            # Clean URL
            play_url = play_url.replace('//play/', '/play/')
            
            # Extract video ID
            video_id_match = re.search(r'/play/(tt?\d+)', play_url)
            video_id = video_id_match.group(1) if video_id_match else None
            
            # Fetch player page
            response = self.session.get(play_url, timeout=15)
            html = response.text
            
            # Find player data - method 1
            player_data = None
            patterns = [
                r'let\s+p3\s*=\s*({.*?});',
                r'var\s+p3\s*=\s*({.*?});',
                r'p3\s*=\s*({.*?});',
                r'const\s+p3\s*=\s*({.*?});'
            ]
            
            for pattern in patterns:
                match = re.search(pattern, html, re.DOTALL)
                if match:
                    try:
                        json_str = match.group(1)
                        # Clean up JSON
                        json_str = re.sub(r'(\w+):', r'"\1":', json_str)
                        json_str = json_str.replace("'", '"')
                        json_str = json_str.replace('\\/', '/')
                        player_data = json.loads(json_str)
                        if 'file' in player_data:
                            break
                    except:
                        continue
            
            if not player_data or 'file' not in player_data:
                return {
                    'success': False,
                    'error': 'Could not extract player data',
                    'video_id': video_id
                }
            
            file_url = player_data['file']
            referrer = player_data.get('referrer', urlparse(play_url).netloc)
            
            # Fetch the file
            file_response = self.session.get(
                file_url,
                headers={'Referer': f"https://{referrer}"},
                timeout=15
            )
            
            content = file_response.text
            
            # Extract m3u8 URLs
            m3u8_pattern = r'https?://[^\s"\']+\.m3u8[^\s"\']*'
            m3u8_links = re.findall(m3u8_pattern, content)
            
            # If no m3u8 found, try parsing as playlist
            if not m3u8_links and '#EXTM3U' in content:
                lines = content.strip().split('\n')
                for line in lines:
                    line = line.strip()
                    if line and not line.startswith('#') and 'http' in line:
                        m3u8_links.append(line)
            
            m3u8_links = list(dict.fromkeys(m3u8_links))
            
            if m3u8_links:
                return {
                    'success': True,
                    'video_id': video_id,
                    'm3u8_links': m3u8_links,
                    'source_url': play_url
                }
            else:
                return {
                    'success': False,
                    'error': 'No m3u8 links found',
                    'video_id': video_id,
                    'content_preview': content[:200]
                }
                
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'traceback': traceback.format_exc()
            }

extractor = AllMovieLandM3UExtractor()

@app.route('/api/extract', methods=['GET', 'POST'])
def extract():
    try:
        if request.method == 'GET':
            url = request.args.get('url')
        else:
            data = request.get_json(silent=True)
            url = data.get('url') if data else request.form.get('url')
        
        if not url:
            return jsonify({'error': 'url parameter required'}), 400
        
        result = extractor.extract_m3u8_from_url(url)
        return jsonify(result)
        
    except Exception as e:
        return jsonify({
            'error': 'Internal server error',
            'details': str(e),
            'traceback': traceback.format_exc()
        }), 500

@app.route('/api/extract-from-example', methods=['GET'])
def extract_from_example():
    try:
        example_url = "https://piexe411qok.com/play/tt42730027"
        result = extractor.extract_m3u8_from_url(example_url)
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'python_version': sys.version,
        'dependencies_loaded': True
    })

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        'service': 'AllMovieLand M3U8 Extractor',
        'endpoints': {
            '/api/extract': 'GET/POST - use ?url=PLAY_URL',
            '/api/extract-from-example': 'GET - test endpoint',
            '/api/health': 'GET - health check'
        },
        'example': '/api/extract?url=https://piexe411qok.com/play/tt42730027'
    })

# For local development
if __name__ == '__main__':
    app.run(debug=True, port=5000)
