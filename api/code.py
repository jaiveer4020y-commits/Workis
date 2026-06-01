from http.server import BaseHTTPRequestHandler
import json
import re
import urllib.request
import urllib.parse
import urllib.error
import ssl

ALLMOVIELAND_API = "https://allmovieland.one"

SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE

def fetch(url, method="GET", headers=None, referer=None, data=None):
    req_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
    }
    if headers:
        req_headers.update(headers)
    if referer:
        req_headers["Referer"] = referer
    post_data = data.encode("utf-8") if data else None
    req = urllib.request.Request(url, headers=req_headers, method=method, data=post_data)
    with urllib.request.urlopen(req, context=SSL_CONTEXT) as r:
        return r.read().decode("utf-8")

def fix_url(url, host):
    if not url:
        return url
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return f"{host}{'' if url.startswith('/') else '/'}{url}"

def try_parse_json(text):
    try:
        return json.loads(text)
    except:
        return None

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        id_ = params.get("id", [None])[0]
        season = params.get("season", [None])[0]
        episode = params.get("episode", [None])[0]

        if not id_:
            self._respond(400, {"error": "Missing required parameter: id"})
            return

        try:
            # 1. Get CDN host from player.js
            player_script = fetch(f"{ALLMOVIELAND_API}/player.js?v=60%20128")
            match = re.search(r"const AwsIndStreamDomain\s*=\s*'(https?://[^']+)'", player_script)
            if not match:
                self._respond(500, {"error": "Could not extract stream domain", "js_snippet": player_script[:300]})
                return
            host = match.group(1).rstrip("/")
            referer = f"{ALLMOVIELAND_API}/"

            # 2. Get playlist data from CDN play page (NOT allmovieland.one)
            play_url = f"{host}/play/{id_}"
            player_html = fetch(play_url, referer=referer)

            # Extract playlist JSON from script tag
            json_str = None
            script_match = re.search(r"<script[^>]*>([\s\S]*?playlist[\s\S]*?)</script>", player_html)
            if script_match:
                content = script_match.group(1)
                try:
                    brace_idx = content.index("{")
                    after = content[brace_idx:]
                    raw = after[:after.index(";")].rstrip(")")
                    json_str = "{" + raw.strip()
                except ValueError:
                    pass

            playlist = try_parse_json(json_str or "{}")
            if not playlist or not playlist.get("key") or not playlist.get("file"):
                self._respond(500, {
                    "error": "Could not parse playlist data",
                    "play_url": play_url,
                    "raw": json_str,
                    "html_snippet": player_html[:500]
                })
                return

            headers = {"X-CSRF-TOKEN": playlist["key"], "Referer": referer}

            # 3. Fetch servers list
            server_url = fix_url(playlist["file"], host)
            server_text = re.sub(r",\s*\[\]", "", fetch(server_url, headers=headers, referer=referer))
            servers = try_parse_json(server_text)
            if not servers:
                self._respond(500, {"error": "Could not parse servers list", "raw": server_text[:300]})
                return

            # 4. Select entries by season/episode
            if season is None:
                entries = [{"file": s.get("file"), "title": s.get("title")} for s in servers]
            else:
                season_folder = next((s for s in servers if s.get("id") == str(season)), None)
                ep_folder = None
                if season_folder:
                    ep_folder = next((f for f in season_folder.get("folder", []) if f.get("episode") == str(episode)), None)
                entries = ep_folder.get("folder", []) if ep_folder else []

            # 5. Resolve M3U8 paths
            links = []
            for entry in entries:
                if not entry.get("file"):
                    continue
                path = fetch(
                    f"{host}/playlist/{entry['file']}.txt",
                    method="POST",
                    headers=headers,
                    referer=referer
                )
                links.append({
                    "source": f"Allmovieland [{entry.get('title')}]",
                    "name": f"Allmovieland [{entry.get('title')}]",
                    "url": path.strip(),
                    "type": "M3U8",
                    "referer": referer,
                    "quality": 1080
                })

            self._respond(200, {"links": links})

        except Exception as e:
            self._respond(500, {"error": str(e)})

    def _respond(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
