import jsonimport json
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

def handler(request):
    params = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(request.url).query))

    if "search" in params:
        try:
            query = params["search"]
            search_url = f"{ALLMOVIELAND_API}/index.php?do=search&subaction=search&q={urllib.parse.quote(query)}"
            html = fetch(search_url)
            results = []
            for m in re.finditer(r'href="https?://allmovieland\.one/(\d+)-([^"]+)\.html"[^>]*>\s*<img[^>]+alt="([^"]+)"', html):
                results.append({"id": m.group(1), "slug": m.group(2), "title": m.group(3)})
            return Response(json.dumps({"results": results}), headers={"Content-Type": "application/json"})
        except Exception as e:
            return Response(json.dumps({"error": str(e)}), status=500, headers={"Content-Type": "application/json"})

    id_ = params.get("id")
    season = params.get("season")
    episode = params.get("episode")

    if not id_:
        return Response(json.dumps({"error": "Missing id", "usage": "?id=464 or ?search=Breaking+Bad"}),
                        status=400, headers={"Content-Type": "application/json"})

    try:
        player_script = fetch(f"{ALLMOVIELAND_API}/player.js?v=60%20128")
        match = re.search(r"const AwsIndStreamDomain\s*=\s*'(https?://[^']+)'", player_script)
        if not match:
            return Response(json.dumps({"error": "Could not extract stream domain"}),
                            status=500, headers={"Content-Type": "application/json"})
        host = match.group(1).rstrip("/")
        referer = f"{ALLMOVIELAND_API}/"

        play_url = f"{host}/play/{id_}"
        player_html = fetch(play_url, referer=referer)

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
            return Response(json.dumps({"error": "Could not parse playlist", "raw": json_str, "html": player_html[:300]}),
                            status=500, headers={"Content-Type": "application/json"})

        headers = {"X-CSRF-TOKEN": playlist["key"], "Referer": referer}
        server_url = fix_url(playlist["file"], host)
        server_text = re.sub(r",\s*\[\]", "", fetch(server_url, headers=headers, referer=referer))
        servers = try_parse_json(server_text)
        if not servers:
            return Response(json.dumps({"error": "Could not parse servers", "raw": server_text[:300]}),
                            status=500, headers={"Content-Type": "application/json"})

        if season is None:
            entries = [{"file": s.get("file"), "title": s.get("title")} for s in servers]
        else:
            season_folder = next((s for s in servers if s.get("id") == str(season)), None)
            ep_folder = None
            if season_folder:
                ep_folder = next((f for f in season_folder.get("folder", []) if f.get("episode") == str(episode)), None)
            entries = ep_folder.get("folder", []) if ep_folder else []

        links = []
        for entry in entries:
            if not entry.get("file"):
                continue
            path = fetch(f"{host}/playlist/{entry['file']}.txt", method="POST", headers=headers, referer=referer)
            links.append({
                "source": f"Allmovieland [{entry.get('title')}]",
                "name": f"Allmovieland [{entry.get('title')}]",
                "url": path.strip(),
                "type": "M3U8",
                "referer": referer,
                "quality": 1080
            })

        return Response(json.dumps({"links": links}), headers={"Content-Type": "application/json"})

    except Exception as e:
        return Response(json.dumps({"error": str(e)}), status=500, headers={"Content-Type": "application/json"})
