# api/index.py
from flask import Flask, request, jsonify
import requests
import re
import json
from urllib.parse import urlparse

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
        """Extract m3u8 from a /play/ URL"""
        # Clean URL
        play_url = play_url.replace('//play/', '/play/')
        
        # Extract video ID from URL
        video_id_match = re.search(r'/play/(tt?\d+)', play_url)
        video_id = video_id_match.group(1) if video_id_match else None
        
        try:
            # Fetch the player page
            print(f"Fetching: {play_url}")
            response = self.session.get(play_url, timeout=15)
            html = response.text
            
            # Try multiple patterns to find player data
            player_data = None
            
            # Pattern 1: let p3 = {...};
            p3_match = re.search(r'let\s+p3\s*=\s*({.*?});', html, re.DOTALL)
            if p3_match:
                try:
                    json_str = p3_match.group(1)
                    # Fix common JSON issues
                    json_str = re.sub(r'(\w+):', r'"\1":', json_str)  # Add quotes to keys
                    json_str = json_str.replace("'", '"')  # Replace single quotes
                    json_str = json_str.replace('\\/', '/')
                    player_data = json.loads(json_str)
                    print("Found player data with pattern 1")
                except:
                    pass
            
            # Pattern 2: var p3 = {...};
            if not player_data:
                p3_match = re.search(r'var\s+p3\s*=\s*({.*?});', html, re.DOTALL)
                if p3_match:
                    try:
                        json_str = p3_match.group(1)
                        json_str = re.sub(r'(\w+):', r'"\1":', json_str)
                        json_str = json_str.replace("'", '"')
                        json_str = json_str.replace('\\/', '/')
                        player_data = json.loads(json_str)
                        print("Found player data with pattern 2")
                    except:
                        pass
            
            # Pattern 3: Look for any object with "file" property
            if not player_data:
                file_match = re.search(r'\{[^{}]*"file"\s*:\s*"[^"]+"[^{}]*\}', html)
                if file_match:
                    try:
                        json_str = file_match.group(0)
                        player_data = json.loads(json_str)
                        print("Found player data with pattern 3")
                    except:
                        pass
            
            # Pattern 4: Look for p3 = {...} without var/let
            if not player_data:
                p3_match = re.search(r'p3\s*=\s*({.*?});', html, re.DOTALL)
                if p3_match:
                    try:
                        json_str = p3_match.group(1)
                        json_str = re.sub(r'(\w+):', r'"\1":', json_str)
                        json_str = json_str.replace("'", '"')
                        json_str = json_str.replace('\\/', '/')
                        player_data = json.loads(json_str)
                        print("Found player data with pattern 4")
                    except:
                        pass
            
            if not player_data or 'file' not in player_data:
                # Debug: Save the HTML for inspection
                with open('debug.html', 'w') as f:
                    f.write(html)
                
                return {
                    'error': 'Could not find player data',
                    'video_id': video_id,
                    'debug': 'HTML saved to debug.html',
                    'html_preview': html[:1000]  # Send first 1000 chars for debugging
                }
            
            file_url = player_data['file']
            referrer = player_data.get('referrer', urlparse(play_url).netloc)
            
            print(f"File URL: {file_url}")
            print(f"Referrer: {referrer}")
            
            # Fetch the .txt file with correct referrer
            file_response = self.session.get(
                file_url,
                headers={'Referer': f"https://{referrer}"},
                timeout=15
            )
            
            content = file_response.text
            print(f"File content length: {len(content)}")
            
            # Extract m3u8 URLs from the content
            m3u8_links = []
            
            # Look for m3u8 URLs
            m3u8_pattern = r'https?://[^\s"\']+\.m3u8[^\s"\']*'
            m3u8_links = re.findall(m3u8_pattern, content)
            
            # If content is a m3u8 playlist, parse it line by line
            if '#EXTM3U' in content and not m3u8_links:
                lines = content.strip().split('\n')
                for line in lines:
                    line = line.strip()
                    if line and not line.startswith('#') and not line.startswith('//'):
                        if 'http' in line:
                            m3u8_links.append(line)
                        elif line.endswith('.m3u8') or line.endswith('.ts'):
                            # Relative URL
                            base_url = file_url.rsplit('/', 1)[0]
                            m3u8_links.append(f"{base_url}/{line}")
            
            # Remove duplicates
            m3u8_links = list(dict.fromkeys(m3u8_links))
            
            if m3u8_links:
                return {
                    'success': True,
                    'video_id': video_id,
                    'source_url': play_url,
                    'file_url': file_url,
                    'm3u8_links': m3u8_links
                }
            else:
                return {
                    'error': 'No m3u8 links found in response',
                    'video_id': video_id,
                    'source_url': play_url,
                    'file_url': file_url,
                    'content_preview': content[:500] if content else 'Empty response'
                }
                
        except requests.exceptions.RequestException as e:
            return {'error': f'Request failed: {str(e)}', 'video_id': video_id}
        except json.JSONDecodeError as e:
            return {'error': f'JSON parse error: {str(e)}', 'video_id': video_id}
        except Exception as e:
            return {'error': f'Unexpected error: {str(e)}', 'video_id': video_id}

extractor = AllMovieLandM3UExtractor()

@app.route('/api/extract', methods=['GET', 'POST'])
def extract():
    """Extract m3u8 from URL"""
    if request.method == 'GET':
        url = request.args.get('url')
    else:
        data = request.get_json()
        url = data.get('url') if data else None
    
    if not url:
        return jsonify({'error': 'url parameter required'}), 400
    
    result = extractor.extract_m3u8_from_url(url)
    return jsonify(result)

@app.route('/api/extract-from-example', methods=['GET'])
def extract_from_example():
    """Test with the example URL"""
    example_url = "https://piexe411qok.com/play/tt42730027"
    result = extractor.extract_m3u8_from_url(example_url)
    return jsonify(result)

@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy'})

@app.route('/', methods=['GET'])
def index():
    return jsonify({
        'service': 'AllMovieLand M3U8 Extractor',
        'description': 'Extracts m3u8 links from AllMovieLand play URLs',
        'endpoints': {
            '/api/extract': 'GET/POST - Extract m3u8 (use ?url=PLAY_URL)',
            '/api/extract-from-example': 'GET - Test with example URL',
            '/api/health': 'GET - Health check'
        },
        'example': '/api/extract?url=https://piexe411qok.com/play/tt42730027'
    })

if __name__ == '__main__':
    app.run(debug=True)
