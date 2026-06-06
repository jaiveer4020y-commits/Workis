from http.server import BaseHTTPRequestHandler
import json
import re
import urllib.request
import urllib.parse
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
           self._respond(400, {"error": "Missing id", "usage": "?id=464&season=1&episode=1"})
           return

       try:
           # Step 1: get host from player.js (same as Kotlin)
           player_script = fetch(f"{ALLMOVIELAND_API}/player.js?v=60%20128")
           match = re.search(r"const AwsIndStreamDomain\s*=\s*'(.*?)';", player_script)
           if not match:
               self._respond(500, {"error": "Could not extract stream domain", "js": player_script[:300]})
               return
           host = match.group(1).rstrip("/")
           referer = f"{ALLMOVIELAND_API}/"

           # Step 2: get play page, find script with playlist (same as Kotlin selectFirst)
           play_html = fetch(f"{host}/play/{id_}", referer=referer)
           script_match = re.search(r"<script[^>]*>((?:(?!</script>)[\s\S])*playlist(?:(?!</script>)[\s\S])*)</script>", play_html)
           if not script_match:
               self._respond(500, {"error": "No playlist script found", "html": play_html[:500]})
               return

           # substringAfter("{") substringBefore(";") substringBefore(")")
           script_content = script_match.group(1)
           res = script_content
           if "{" in res:
               res = res[res.index("{") + 1:]
           if ";" in res:
               res = res[:res.index(";")]
           if ")" in res:
               res = res[:res.index(")")]
           res = res.strip()

           playlist = try_parse_json("{" + res)
           if not playlist or not playlist.get("key") or not playlist.get("file"):
               self._respond(500, {"error": "Could not parse playlist", "raw": res[:300]})
               return

           # Step 3: get servers list
           headers = {"X-CSRF-TOKEN": playlist["key"], "Referer": referer}
           server_url = fix_url(playlist["file"], host)
           server_text = re.sub(r",\s*\[\]", "", fetch(server_url, headers=headers, referer=referer))
           servers = try_parse_json(server_text)
           if not servers:
               self._respond(500, {"error": "Could not parse servers", "raw": server_text[:300]})
               return

           # Step 4: select entries (same logic as Kotlin)
           entries = []
           if season is None:
               # movie: server.map { it.file to it.title }
               entries = [{"file": s.get("file"), "title": s.get("title")} for s in servers]
           else:
               # tv: find season -> find episode -> map folder
               season_obj = next((s for s in servers if s.get("id") == str(season)), None)
               if season_obj:
                   ep_obj = next((f for f in season_obj.get("folder", []) if f.get("episode") == str(episode)), None)
                   if ep_obj:
                       entries = [{"file": f.get("file"), "title": f.get("title")} for f in ep_obj.get("folder", [])]

           # Step 5: post to get m3u8 path (same as Kotlin app.post)
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
