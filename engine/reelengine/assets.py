"""Getting b-roll from the web: keyless image search, image download, media download from a link.

  search_images(query, n)          -> [{url, thumbnail, title, width, height, license, creator, source,
                                        provider, licenseUrl, licenseKind, attributionRequired,
                                        attribution, trademark, kind, mime, score[, color, note]}]
  fetch_image(url, dest)           -> Path of a saved PNG/JPG (webp/gif/avif converted to PNG; a flat
                                      Simple Icons SVG drawn to a transparent PNG by svgraster). When
                                      the url came from a recent search, its licence + credit line is
                                      recorded in <dest>/credits.json under the saved file's name.
  download_media(url, dest, kind)  -> Path (kind: "video" -> mp4, "music"/"audio" -> mp3) via yt-dlp
  logo(slug, dest, png=False)      -> brand mark from Simple Icons: SVG, or a PNG in the brand colour

  search(query, n, copyrighted)    -> {results, plan, website?}: the same results plus the official
                                      website of the app / brand / show named (for a screenshot)
  register_capture(path, url)      -> credit for a website screenshot the app captured itself

Search plans the query offline (logo / work / place / concept / object), asks Wikidata (CC0) which
thing a name means (a show? an app? its own logo file, its website), asks Simple Icons (brand
marks), Wikimedia Commons (MediaWiki API, per-file licence metadata) and Openverse (CC photos) in
parallel, keeps only licences a reel may use (CC0, public domain, CC BY, CC BY-SA), and ranks by
title relevance + licence simplicity + size. Copyrighted posters/stills of shows and films
(Wikipedia lead image, TVmaze) come back ONLY when asked for, and are labelled as copyrighted.
Every request sends a generic app User-Agent: never a personal name or email.

Errors raise EngineError with a plain-English userMessage. CLI (JSON lines on stdout, docs/architecture.md section 4):

  python -m reelengine.assets search "college students on phones" --n 6
  python -m reelengine.assets fetch <image-url> --dest "<project>/work/assets"
  python -m reelengine.assets download <link> --dest "<Reel Studio>/Library/B-roll" --kind video
  python -m reelengine.assets logo github --dest out --png
"""
from __future__ import annotations

import html
import io
import ipaddress
import json
import os
import re
import socket
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .compose_util import EngineError, ffmpeg_bin, log
from .cache import cache_dir

API_UA = "ReelStudio/0.1 (+https://github.com/AidenJohnston/reel-studio-app)"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
OPENVERSE = "https://api.openverse.org/v1/images/"
COMMONS = "https://commons.wikimedia.org/w/api.php"
SIMPLE_ICONS = "https://cdn.simpleicons.org"
MAX_IMAGE_BYTES = 40 * 1024 * 1024

NO_NET = "I couldn't reach the internet. Check your connection and try again."


def slugify(text: str, n: int = 60) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower())
    return re.sub(r"-{2,}", "-", text).strip("-")[:n] or "image"


def _blocked_ip(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%", 1)[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return not a.is_global or a.is_multicast


def check_url(url: str) -> str:
    """Refuse anything but http(s) to a public host. `file:`, `data:`, `ftp:`
    and every loopback / private / link-local / reserved address are refused, on every redirect hop.
    REELENGINE_ALLOW_PRIVATE_FETCH=1 lifts the address rule for the test suite's local servers only."""
    u = urlparse((url or "").strip())
    if u.scheme.lower() not in ("http", "https") or not u.hostname:
        raise EngineError("BAD_URL", f"refused non-http(s) url: {url[:200]!r}",
                          "That isn't a web link to a picture. Copy the picture's address (it starts with https://).")
    if os.environ.get("REELENGINE_ALLOW_PRIVATE_FETCH") == "1":
        return url
    try:
        infos = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme.lower() == "https" else 80),
                                   proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as e:
        raise EngineError("NO_INTERNET", f"{u.hostname}: {e}", NO_NET) from None
    for info in infos:
        if _blocked_ip(info[4][0]):
            raise EngineError("BLOCKED_HOST", f"refused {u.hostname} -> {info[4][0]} (not a public address)",
                              "That link points at this computer or a private network, so I won't download it.")
    return url


class _CheckedRedirects(HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)                    # every hop, not just the first URL
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = build_opener(_CheckedRedirects())


def _get(url: str, accept: str = "*/*", ua: str = API_UA, timeout: int = 30, limit: int = MAX_IMAGE_BYTES,
         deadline: float = 90.0):
    check_url(url)
    # Wikimedia throttles (HTTP 429) clients that pretend to be a browser; it wants an honest app UA.
    if "wikimedia.org" in url or "wikipedia.org" in url or "wikidata.org" in url:
        ua = API_UA
    t_end = time.monotonic() + deadline
    for attempt in range(2):
        req = Request(url, headers={"User-Agent": ua, "Accept": accept})
        try:
            with _OPENER.open(req, timeout=timeout) as resp:
                chunks, got = [], 0
                while True:                      # streamed: never buffers more than `limit` + one chunk
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    got += len(chunk)
                    if got > limit:
                        raise EngineError("TOO_BIG", f"{url} exceeds {limit} bytes", "That file is too big to use.")
                    if time.monotonic() > t_end:
                        raise EngineError("TIMEOUT", f"{url}: slower than {deadline:.0f}s",
                                          "That download was too slow. Try a different picture.")
                    chunks.append(chunk)
                return b"".join(chunks), resp.headers.get("Content-Type", "")
        except HTTPError as e:
            if e.code in (429, 503) and attempt == 0:
                try:
                    wait = float(e.headers.get("Retry-After") or 2)
                except (TypeError, ValueError):
                    wait = 2.0
                time.sleep(min(max(wait, 1.0), 5.0))
                continue
            raise EngineError("HTTP_ERROR", f"HTTP {e.code} for {url}",
                              "That website wouldn't give me the picture. Try a different one.") from None
        except (URLError, TimeoutError, OSError) as e:
            reason = getattr(e, "reason", None)
            if isinstance(reason, EngineError):
                raise reason from None
            raise EngineError("NO_INTERNET", f"{url}: {e}", NO_NET) from None


# --- search ------------------------------------------------------------------------------------

# Three keyless sources, all queried with a generic app User-Agent (API_UA):
#   * Simple Icons  - CC0 brand marks (SVG, rasterised by svgraster on fetch). Some big brands
#                     (Microsoft, Amazon, LinkedIn...) were removed at the owner's
#                     request, so a logo search always also asks Commons.
#   * Wikimedia Commons - the MediaWiki API with per-file licence metadata. Logos there are mostly
#                     "PD-textlogo" (public domain: too simple to copyright) but still TRADEMARKS.
#   * Openverse     - CC photos (mostly Flickr), filtered server-side to licences we accept.
# Accepted licences: CC0, public domain (incl. PDM / PD-textlogo), CC BY, CC BY-SA. Refused: any
# NC (a monetised reel is commercial use) or ND (cropping/compositing is an adaptation), fair use,
# GFDL (needs the full licence text alongside), and anything we can't classify.

SEARCH_TIMEOUT = 15
OPENVERSE_TIMEOUT = 25
SIMPLE_ICONS_RESOLVE = "https://data.jsdelivr.com/v1/packages/npm/simple-icons/resolved?specifier=latest"
SIMPLE_ICONS_DATA = "https://cdn.jsdelivr.net/npm/simple-icons@{v}/data/simple-icons.json"
SIMPLE_ICONS_SVG = "https://cdn.jsdelivr.net/npm/simple-icons@{v}/icons/{slug}.svg"
_SI_TTL = 7 * 86400
OPENVERSE_LICENSES = "cc0,pdm,by,by-sa"
TRADEMARK_NOTE = ("A logo is a trademark: fine to show when talking about the brand, "
                  "but don't imply the brand made or endorses the video.")

_STOP = {"a", "an", "the", "of", "and", "in", "on", "at", "for", "with", "to", "from", "by", "my", "your"}
_LOGO_WORDS = {"logo", "logos", "icon", "icons", "wordmark", "logotype", "emblem", "brand", "symbol", "badge"}
_APP_WORDS = {"app", "apps", "website", "site", "homepage", "webpage", "web"}
# "<title> TV show / anime / movie": the title is a WORK (a show or film), looked up as one.
_WORK_WORDS = {"tv", "show", "shows", "series", "sitcom", "anime", "movie", "movies", "film", "films",
               "cartoon", "miniseries", "season", "episode", "trailer", "drama", "kdrama", "k-drama", "netflix",
               "hbo", "documentary"}
_PHOTO_WORDS = {"photo", "photos", "picture", "pictures", "image", "images", "pic", "pics", "photograph",
                "stock", "png", "jpg", "hd", "high", "resolution", "real"}
_PLACE_WORDS = {"tower", "square", "street", "avenue", "bridge", "park", "campus", "university", "college",
                "city", "downtown", "skyline", "building", "museum", "beach", "mountain", "mountains", "lake",
                "river", "station", "stadium", "church", "cathedral", "temple", "castle", "palace", "airport",
                "harbor", "harbour", "island", "valley", "canyon", "falls", "monument", "statue", "library",
                "plaza", "market", "capitol", "hall", "district", "neighborhood", "village", "town"}
# Category words dropped from "<brand> <category> app" queries so the brand alone is looked up.
_APP_CATEGORY_WORDS = {"dating", "social", "messaging", "chat", "photo", "video", "music", "streaming", "shopping",
                       "banking", "fitness", "food", "delivery", "travel", "news", "game", "gaming", "productivity"}
_CONCEPT_WORDS = {"love", "money", "success", "stress", "anxiety", "time", "freedom", "fear", "hope", "dating",
                  "friendship", "growth", "failure", "wealth", "power", "luck", "focus", "burnout", "productivity",
                  "motivation", "heartbreak", "grief", "joy", "peace", "chaos", "work", "life", "future", "dream",
                  "dreams", "romance", "rejection", "confidence", "ambition", "procrastination", "nostalgia"}
_CONCEPT_SUFFIX = ("ness", "ity", "ism", "ship", "hood", "dom", "tion", "sion", "ment", "ing", "ance", "ence")


def _write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


class _FileLock:
    """Read-modify-write of a shared JSON book (search credits, credits.json) by several engine
    processes at once: the AI runs searches and downloads in parallel, and without a lock one
    writer drops the other's entries. A lock older than 15 s is a crashed writer's and is taken."""

    def __init__(self, path: Path, wait: float = 10.0):
        self.lock = path.with_name(path.name + ".lock")
        self.wait = wait
        self.held = False

    def __enter__(self):
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        while True:
            try:
                os.close(os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                self.held = True
                return self
            except FileExistsError:
                try:
                    if time.time() - self.lock.stat().st_mtime > 15:
                        self.lock.unlink(missing_ok=True)
                        continue
                except OSError:
                    continue
                if time.monotonic() - t0 > self.wait:
                    return self               # never block the edit on a lock: write unlocked
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self.held:
            self.lock.unlink(missing_ok=True)
        return False


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", (text or "").lower())).strip()


def _tokens(text: str) -> list[str]:
    return [t for t in _norm(text).split() if t not in _STOP]


# --- licences ----------------------------------------------------------------------------------

def classify_license(name: str, url: str = "", code: str = "") -> Optional[dict]:
    """-> {kind, tier, attributionRequired} for a licence we accept, else None.
    tier: 0 = CC0 / public domain, 1 = CC BY, 2 = CC BY-SA (lower is easier to use)."""
    s = f" {name} | {code} | {url} ".lower().replace("_", "-")
    if re.search(r"(-|\b)nc(-|\b)|noncommercial|non-commercial|(-|\b)nd(-|\b)|noderiv|no-deriv|fair use|"
                 r"non-free|nonfree|all rights reserved|copyrighted free use provided|gfdl|sampling", s):
        return None
    if "cc0" in s or "publicdomain/zero" in s:
        return {"kind": "cc0", "tier": 0, "attributionRequired": False}
    if "public domain" in s or "publicdomain/mark" in s or re.search(r"(\||\s)(pd|pdm)(\s|\||-)", s) \
            or re.search(r"\bpd-", s):
        return {"kind": "public-domain", "tier": 0, "attributionRequired": False}
    if re.search(r"by-sa|by sa|attribution-share ?alike|attribution share ?alike", s):
        return {"kind": "cc-by-sa", "tier": 2, "attributionRequired": True}
    if re.search(r"\bcc[- ]by\b|licenses/by/|\|\s*by\s*\||\battribution\b", s):
        return {"kind": "cc-by", "tier": 1, "attributionRequired": True}
    return None


def _clean_html(text: str, n: int = 160) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()[:n]


def _attribution(r: dict) -> str:
    """A one-line credit for a post caption (TASL: title, author, source, licence)."""
    if r.get("provider") == "simpleicons":
        return f"{r['title']} via Simple Icons (CC0)"
    if r.get("copyrighted"):
        via = {"wikipedia": "Wikipedia", "tvmaze": "TVmaze"}.get(r.get("provider"), r.get("provider") or "the web")
        return f"{r.get('title')}: {r.get('creator')}, via {via} (copyrighted: used as commentary)"
    via = {"wikimedia": "Wikimedia Commons"}.get(r.get("provider"), r.get("_site") or "Openverse")
    who = r.get("creator") or "unknown author"
    return f"\"{r.get('title') or 'Untitled'}\" by {who}, {r.get('license')}, via {via}"


# --- Simple Icons ------------------------------------------------------------------------------

_SI_INDEX: Optional[dict] = None


def _title_to_slug(title: str) -> str:
    """simple-icons' titleToSlug (sdk.mjs): lower-case, a few symbol/letter swaps, strip
    diacritics, keep [a-z0-9]."""
    import unicodedata
    rep = {"+": "plus", ".": "dot", "&": "and", "đ": "d", "ħ": "h", "ı": "i", "ĸ": "k", "ŀ": "l",
           "ł": "l", "ß": "ss", "ŧ": "t", "ø": "o"}
    t = "".join(rep.get(c, c) for c in (title or "").lower())
    t = unicodedata.normalize("NFD", t)
    return re.sub(r"[^a-z0-9]", "", t)


def _simple_icons() -> dict:
    """{"version", "icons": [...], "by_key": {key: icon}, "by_slug": {slug: icon}} cached on disk
    for a week (a stale copy is used when offline; an empty index when there's none)."""
    global _SI_INDEX
    if _SI_INDEX is not None:
        return _SI_INDEX
    f = cache_dir() / "simple-icons.json"
    data = None
    try:
        if f.exists() and time.time() - f.stat().st_mtime < _SI_TTL:
            data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if data is None:
        try:
            ver = "latest"
            try:
                raw, _ = _get(SIMPLE_ICONS_RESOLVE, accept="application/json", timeout=SEARCH_TIMEOUT, deadline=20)
                ver = json.loads(raw).get("version") or "latest"
            except (EngineError, ValueError):
                pass
            raw, _ = _get(SIMPLE_ICONS_DATA.format(v=ver), accept="application/json", timeout=SEARCH_TIMEOUT,
                          deadline=30, limit=16 * 1024 * 1024)
            icons = json.loads(raw)
            if isinstance(icons, dict):                       # pre-v14 layout {"icons": [...]}
                icons = icons.get("icons") or []
            data = {"version": ver, "icons": [
                {"title": i.get("title", ""), "slug": i.get("slug") or _title_to_slug(i.get("title", "")),
                 "hex": i.get("hex", "000000"), "aliases": i.get("aliases") or {}} for i in icons if i.get("title")]}
            try:
                _write_json(f, data)
            except OSError as e:
                log(f"simple-icons cache not written: {e}")
        except (EngineError, ValueError) as e:
            log(f"simple-icons index unavailable: {getattr(e, 'message', e)}")
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                data = {"version": "latest", "icons": []}
    by_key, by_slug = {}, {}
    for icon in data.get("icons") or []:
        by_slug[icon["slug"]] = icon
        al = icon.get("aliases") or {}
        names = [icon["title"]] + list(al.get("aka") or []) + [d.get("title", "") for d in al.get("dup") or []] \
            + list((al.get("loc") or {}).values())
        for nm in names:
            for k in (_norm(nm), _title_to_slug(nm)):
                if k:
                    by_key.setdefault(k, icon)
    data["by_key"], data["by_slug"] = by_key, by_slug
    _SI_INDEX = data
    return data


def _si_lookup(subject: str) -> Optional[dict]:
    if not subject:
        return None
    idx = _simple_icons()
    return idx["by_key"].get(_norm(subject)) or idx["by_slug"].get(_title_to_slug(subject))


def _si_result(icon: dict) -> dict:
    ver = _simple_icons().get("version") or "latest"
    url = SIMPLE_ICONS_SVG.format(v=ver, slug=icon["slug"])
    return {"url": url, "thumbnail": url, "title": f"{icon['title']} logo", "width": 1024, "height": 1024,
            "license": "CC0 1.0", "creator": "Simple Icons", "source": f"https://simpleicons.org/?q={icon['slug']}",
            "provider": "simpleicons", "licenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
            "licenseKind": "cc0", "_tier": 0, "attributionRequired": False, "trademark": True, "kind": "logo",
            "color": f"#{icon['hex']}", "mime": "image/svg+xml", "_svg": True}


def _simple_icon_color(url: str) -> Optional[str]:
    m = re.search(r"/simple-icons@[^/]+/icons/([a-z0-9]+)\.svg$", urlparse(url).path)
    if not m:
        return None
    icon = _simple_icons()["by_slug"].get(m.group(1))
    return f"#{icon['hex']}" if icon else None


# --- query planning ----------------------------------------------------------------------------

def plan_query(query: str) -> dict:
    """Cheap, offline classification -> {kind, subject, logoIntent, brand, maybeBrand, app}.
    kind: "logo" | "work" (a show / film / anime) | "place" | "concept" | "object". subject = the
    query minus logo/photo/app/work words. app = the query named an app or website."""
    raw = [t for t in re.split(r"\s+", query.strip()) if t]
    low = [_norm(t) for t in raw]
    logo_intent = any(t in _LOGO_WORDS for t in low)
    app = any(t in _APP_WORDS for t in low)
    drop = _LOGO_WORDS | _PHOTO_WORDS | _APP_WORDS | (_APP_CATEGORY_WORDS if app else set())
    keep = [t for t, l in zip(raw, low) if l and l not in drop]
    # "The Office TV show", "Spirited Away movie": a title plus a work word. Only when what's left
    # still reads as a title (capitalised), so "dog show" or "film camera" stay ordinary objects.
    work_keep = [t for t in keep if _norm(t) not in _WORK_WORDS]
    work = (not app and len(work_keep) < len(keep) and bool(work_keep)
            and any(c.isupper() for c in " ".join(work_keep)) and len(_tokens(" ".join(work_keep))) <= 6)
    if work:
        keep = work_keep
    subject = " ".join(keep) or query.strip()
    toks = _tokens(subject)
    if work:
        return {"kind": "work", "subject": subject, "logoIntent": logo_intent, "brand": None,
                "maybeBrand": False, "app": False}
    brand = _si_lookup(subject) if len(toks) <= 4 else None
    proper = any(c.isupper() for c in subject)
    if logo_intent or app or brand:
        kind = "logo" if (logo_intent or app or len(toks) <= 2) else "object"
    elif any(t in _PLACE_WORDS for t in toks):
        kind = "place"
    elif len(toks) <= 2 and not proper and all(t in _CONCEPT_WORDS or t.endswith(_CONCEPT_SUFFIX) for t in toks):
        kind = "concept"
    else:
        kind = "object"
    maybe_brand = kind == "object" and proper and len(toks) <= 3
    return {"kind": kind, "subject": subject, "logoIntent": logo_intent or app, "brand": brand,
            "maybeBrand": maybe_brand, "app": app}


# --- sources -----------------------------------------------------------------------------------

# Never offer a picture whose PROVENANCE is criminal evidence or sexual content, however neutral its
# title. Found 2026-10-17: Commons hosts the DOJ's Epstein-file photos as public domain under titles
# like "EFTA00001765 - Neatly made bed in a minimalist bedroom", and a search for "made bed" picked
# them. Read against the title, description, credit and categories (Commons) or tags (Openverse).
_SENSITIVE = re.compile(
    r"\bepstein\b|\bfbi raid\b|media by the federal bureau of investigation|justice\.gov/epstein|"
    r"\bcrime[ -]scenes?\b|\bautops(?:y|ies)\b|\bcorpses?\b|\bdead bod(?:y|ies)\b|\bmugshots?\b|"
    r"\bnud(?:e|es|ity)\b|\bnaked\b|\bpornograph|\bgenital|\bsexual (?:abuse|act)|\bexecutions?\b|"
    r"\bmassacres?\b", re.I)
_EVIDENCE_TITLE = re.compile(r"^(?:file:)?efta\d{5,}", re.I)


def _sensitive(title: str, *more: str) -> bool:
    return bool(_EVIDENCE_TITLE.match(title.strip()) or _SENSITIVE.search(" ".join((title, *more))))


def _openverse(query: str, n: int) -> list[dict]:
    q = urlencode({"q": query, "page_size": max(1, min(n * 2, 40)), "mature": "false",
                   "license": OPENVERSE_LICENSES})
    # Openverse answers an uncached query in ~12-15 s (measured 2026-10-17), so it gets longer
    data, _ = _get(f"{OPENVERSE}?{q}", accept="application/json", timeout=OPENVERSE_TIMEOUT, deadline=30)
    out = []
    for k, it in enumerate(json.loads(data).get("results") or []):
        url = it.get("url")
        if not url or url.lower().endswith(".svg"):
            continue
        code = (it.get("license") or "").lower()
        ver = it.get("license_version") or ""
        name = {"cc0": "CC0", "pdm": "Public Domain Mark"}.get(code, f"CC {code.upper()}")
        name = f"{name} {ver}".strip()
        lic = classify_license(name, it.get("license_url") or "", code)
        if not lic:
            continue
        tags = [t.get("name", "") for t in (it.get("tags") or []) if isinstance(t, dict)]
        if _sensitive(it.get("title") or "", it.get("creator") or "", " ".join(tags)):
            continue
        out.append({"url": url, "thumbnail": it.get("thumbnail") or url, "title": _clean_html(it.get("title"), 200),
                    "width": it.get("width"), "height": it.get("height"), "license": name,
                    "creator": _clean_html(it.get("creator"), 120), "source": it.get("foreign_landing_url") or url,
                    "provider": "openverse", "licenseUrl": it.get("license_url") or "",
                    "licenseKind": lic["kind"], "_tier": lic["tier"], "attributionRequired": lic["attributionRequired"],
                    "mime": "", "_tags": tags, "_rank": k, "_site": (it.get("source") or "").title()})
    return out


def _commons(query: str, n: int, filetypes: str = "bitmap") -> list[dict]:
    q = urlencode({"action": "query", "format": "json", "formatversion": 2, "generator": "search",
                   "gsrsearch": f"filetype:{filetypes} {query}", "gsrnamespace": 6, "gsrlimit": max(1, min(n * 2, 40)),
                   "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 1280,
                   "iiextmetadatafilter": "LicenseShortName|LicenseUrl|License|Artist|Credit|AttributionRequired|"
                                          "UsageTerms|Copyrighted|Restrictions|NonFree|ObjectName|"
                                          "ImageDescription|Categories"})
    data, _ = _get(f"{COMMONS}?{q}", accept="application/json", timeout=SEARCH_TIMEOUT, deadline=25)
    return _commons_pages(json.loads(data))


def _commons_pages(reply: dict, wikidata: bool = False) -> list[dict]:
    pages = (reply.get("query") or {}).get("pages") or []
    if isinstance(pages, dict):                               # formatversion=1 shape
        pages = list(pages.values())
    out = []
    for p in sorted(pages, key=lambda p: p.get("index", 0)):
        ii = (p.get("imageinfo") or [{}])[0]
        url, mime = ii.get("url"), (ii.get("mime") or "").lower()
        if not url or mime not in ("image/jpeg", "image/png", "image/svg+xml", "image/webp", "image/gif"):
            continue
        meta = {k: (v or {}).get("value", "") if isinstance(v, dict) else "" for k, v in (ii.get("extmetadata") or {}).items()}
        if str(meta.get("NonFree", "")).lower() == "true":
            continue
        name = _clean_html(meta.get("LicenseShortName") or meta.get("UsageTerms"), 80)
        lic = classify_license(name, meta.get("LicenseUrl", ""), meta.get("License", ""))
        if not lic:
            continue
        svg = mime == "image/svg+xml"
        big = (ii.get("size") or 0) > 15 * 1024 * 1024 or (ii.get("width") or 0) > 6000
        use = ii.get("thumburl") if (svg or big or mime in ("image/webp", "image/gif")) and ii.get("thumburl") else url
        attr_req = lic["attributionRequired"] or str(meta.get("AttributionRequired", "")).lower() == "true"
        title = re.sub(r"^File:", "", p.get("title", ""))
        if _sensitive(title, _clean_html(meta.get("ImageDescription"), 2000), str(meta.get("Categories", "")),
                      _clean_html(meta.get("Credit"), 400), _clean_html(meta.get("Artist"), 400)):
            continue
        shot = bool(_SCREENSHOT.search(title.lower()))
        out.append({"url": use, "thumbnail": ii.get("thumburl") or url, "title": title,
                    "width": ii.get("thumbwidth") if use != url else ii.get("width"),
                    "height": ii.get("thumbheight") if use != url else ii.get("height"),
                    "license": name or lic["kind"], "creator": _clean_html(meta.get("Artist") or meta.get("Credit"), 120),
                    "source": ii.get("descriptionurl") or url, "provider": "wikimedia",
                    "licenseUrl": meta.get("LicenseUrl", ""), "licenseKind": lic["kind"], "_tier": lic["tier"],
                    "attributionRequired": attr_req, "mime": mime, "_svg": svg,
                    "trademark": "trademark" in str(meta.get("Restrictions", "")).lower(), "_rank": len(out),
                    **({"kind": "screenshot"} if shot and not svg else {}),
                    **({"_wikidata": True} if wikidata else {})})
    return out


# --- Wikidata: which THING a name means (CC0 data) --------------------------------------------
#
# One wbsearchentities + one wbgetentities call, cached a month in the user cache. Used to tell a
# show/film title from a brand ("Naruto", "Friends"), to pick the right one ("The Office" = the
# American sitcom, the first hit that IS a show), to get that work's own title-logo file on Commons
# (P154 logo image, P18 image: their licences are read from Commons and gated like any other file),
# and an app's official website (P856), which the AI can capture as a screenshot.

WIKIDATA = "https://www.wikidata.org/w/api.php"
_WD_TTL = 30 * 86400
_WORK_DESC = re.compile(r"\b(television|tv|web|streaming|anime|animated|cartoon|drama|comedy|reality|limited)\s+"
                        r"(series|show|program|programme|sitcom|drama|miniseries)\b|\bsitcom\b|\bminiseries\b|"
                        r"\b(film|movie|anime|manga|telenovela|k-?drama|soap opera)\b|\bfilm series\b")
_APP_DESC = re.compile(r"\b(app|application|software|website|web site|web service|online|service|platform|"
                       r"search engine|social (network|media)|chatbot|messenger|marketplace|streaming|"
                       r"company|video game|browser|dating)\b")
_WD_MEM: dict = {}


def _claim_values(ent: dict, prop: str) -> list:
    out = []
    for c in (ent.get("claims") or {}).get(prop) or []:
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value")
        if v is not None and c.get("rank") != "deprecated":
            out.append(v)
    return out


# P31 classes of a show or film, for the full-text fallback (OR-ed): TV series, film, anime TV
# series, animated film, miniseries, animated TV series, web series, anime film, TV programme.
_WORK_CLASSES = "|".join(f"P31={q}" for q in ("Q5398426", "Q11424", "Q63952888", "Q202866", "Q1259759",
                                                "Q117467246", "Q526877", "Q20650540", "Q15416"))


def _wd_picks(ids: list, name: str, want: Optional[str]) -> list[dict]:
    """Entities among ids whose English label or alias IS the name, classified work / app / other
    (want keeps only that kind), in the order given."""
    if not ids:
        return []
    q = urlencode({"action": "wbgetentities", "ids": "|".join(ids[:10]),
                   "props": "claims|descriptions|labels|aliases|sitelinks", "languages": "en|mul", "format": "json"})
    raw, _ = _get(f"{WIKIDATA}?{q}", accept="application/json", timeout=SEARCH_TIMEOUT, deadline=20,
                  limit=8 * 1024 * 1024)
    ents = json.loads(raw).get("entities") or {}
    picks = []
    for i in ids[:10]:
        ent = ents.get(i) or {}
        # many items now keep their name only in the language-neutral "mul" label (e.g. the sitcom Friends)
        labels, aliases = ent.get("labels") or {}, ent.get("aliases") or {}
        label = (labels.get("en") or labels.get("mul") or {}).get("value") or ""
        names = [label] + [a.get("value", "") for lang in ("en", "mul") for a in aliases.get(lang) or []]
        if not any(nm and _norm(nm) == name for nm in names):      # "The Friends" is not "Friends"
            continue
        desc = ((ent.get("descriptions") or {}).get("en") or {}).get("value") or ""
        d = desc.lower()
        kind = "work" if (_WORK_DESC.search(d) and "company" not in d) else "app" if _APP_DESC.search(d) else "other"
        if want and kind != want:
            continue
        links = ent.get("sitelinks") or {}
        picks.append({"id": i, "label": label, "description": desc, "kind": kind, "_links": len(links),
                      "wiki": (links.get("enwiki") or {}).get("title"),
                      "website": next((x for x in _claim_values(ent, "P856") if isinstance(x, str)
                                       and x.lower().startswith(("http://", "https://"))), None),
                      "logo": next((x for x in _claim_values(ent, "P154") if isinstance(x, str)), None),
                      "image": next((x for x in _claim_values(ent, "P18") if isinstance(x, str)), None)})
    return picks


def wikidata_lookup(subject: str, want: Optional[str] = None) -> Optional[dict]:
    """-> {id, label, description, kind ("work" | "app" | "other"), website, logo, image} for the
    entity a name most likely means, or None. Only hits whose label (or an alias) IS the name count;
    want="work" / "app" takes the first such hit of that kind, else the first such hit. Never raises."""
    key = f"{_norm(subject)}|{want or ''}"
    if not _norm(subject):
        return None
    if key in _WD_MEM:
        return _WD_MEM[key]
    f = cache_dir() / "wikidata.json"
    try:
        hit = json.loads(f.read_text(encoding="utf-8")).get(key)
        if hit and time.time() - hit.get("t", 0) < _WD_TTL:
            _WD_MEM[key] = hit.get("v")
            return hit.get("v")
    except (OSError, ValueError, AttributeError):
        pass
    try:
        q = urlencode({"action": "wbsearchentities", "search": subject, "language": "en", "uselang": "en",
                       "type": "item", "limit": 7, "format": "json"})
        raw, _ = _get(f"{WIKIDATA}?{q}", accept="application/json", timeout=SEARCH_TIMEOUT, deadline=15)
        ids = [h["id"] for h in json.loads(raw).get("search") or [] if h.get("id")]
        picks = _wd_picks(ids, _norm(subject), want)
        if want != "app" and not any(x["kind"] in ("work", "app") for x in picks):
            # a title that is also a common word ("Friends"): ask the full-text index for works only
            q = urlencode({"action": "query", "list": "search", "srnamespace": 0, "srlimit": 10, "format": "json",
                           "srsearch": f"{subject} haswbstatement:{_WORK_CLASSES}"})
            raw, _ = _get(f"{WIKIDATA}?{q}", accept="application/json", timeout=SEARCH_TIMEOUT, deadline=15)
            more = [h["title"] for h in (json.loads(raw).get("query") or {}).get("search") or []
                    if re.fullmatch(r"Q\d+", h.get("title") or "") and h["title"] not in ids]
            picks += _wd_picks(more, _norm(subject), want)
        # a show or an app beats a namesake ("Naruto" the anime, not the city or the selfie macaque)
        # a show or an app beats a namesake, and the most-linked one wins ("Friends" = the sitcom)
        known = [x for x in picks if x["kind"] != "other"]
        v = max(known, key=lambda x: x["_links"]) if known else (picks[0] if picks else None)
        if v:
            v = {k: val for k, val in v.items() if not k.startswith("_")}
    except (EngineError, ValueError, KeyError, TypeError, AttributeError) as e:
        log(f"wikidata lookup {subject!r}: {getattr(e, 'message', e)}")
        return None                                        # not cached: asked again next time
    _WD_MEM[key] = v
    try:
        with _FileLock(f):
            try:
                book = json.loads(f.read_text(encoding="utf-8"))
                if not isinstance(book, dict):
                    book = {}
            except (OSError, ValueError):
                book = {}
            book[key] = {"t": time.time(), "v": v}
            if len(book) > 2000:
                book = dict(list(book.items())[-2000:])
            _write_json(f, book)
    except OSError as e:
        log(f"wikidata cache not written: {e}")
    return v


def _commons_files(names: list) -> list[dict]:
    """Named Commons files (Wikidata P154 / P18) through the same licence gate as a search."""
    names = [n for n in names if n]
    if not names:
        return []
    q = urlencode({"action": "query", "format": "json", "formatversion": 2,
                   "titles": "|".join(f"File:{n}" for n in names[:10]),
                   "prop": "imageinfo", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 1280,
                   "iiextmetadatafilter": "LicenseShortName|LicenseUrl|License|Artist|Credit|AttributionRequired|"
                                          "UsageTerms|Copyrighted|Restrictions|NonFree|ObjectName|"
                                          "ImageDescription|Categories"})
    data, _ = _get(f"{COMMONS}?{q}", accept="application/json", timeout=SEARCH_TIMEOUT, deadline=25)
    return _commons_pages(json.loads(data), wikidata=True)


# --- copyrighted artwork: OFF unless asked for -------------------------------------------------
#
# Posters, key art and show stills are copyrighted. Creators commonly show them when talking about a
# show (commentary), but nobody here can clear that, so these sources only run when the caller opts
# in (search --copyrighted, or REELENGINE_ALLOW_COPYRIGHTED=1), and every such result says so:
# licenseKind "copyrighted", copyrighted: true, a credit line naming the owner, and COPYRIGHT_NOTE.
#   * Wikipedia's lead image of the work's article (a poster or title card, hosted there as non-free).
#   * TVmaze (keyless; its DATA is CC BY-SA, the images are the studios'): a show's poster and
#     "background" stills.

WIKIPEDIA_EN = "https://en.wikipedia.org/w/api.php"
TVMAZE = "https://api.tvmaze.com"
COPYRIGHT_NOTE = ("Copyrighted: used as commentary, your responsibility. This picture belongs to its "
                  "owner; it's commonly shown when talking about the work, but nobody has licensed it to you.")


def copyrighted_allowed(flag: Optional[bool] = None) -> bool:
    if flag is not None:
        return bool(flag)
    return os.environ.get("REELENGINE_ALLOW_COPYRIGHTED") == "1"


def _copyrighted(r: dict, owner: str) -> dict:
    return {**r, "license": "Copyrighted (not licensed)", "creator": f"{owner} (c) its owner",
            "licenseUrl": "", "licenseKind": "copyrighted", "_tier": 2, "attributionRequired": True,
            "copyrighted": True, "mime": "", "_work": True}


def _wikipedia_lead(article: str, label: Optional[str] = None) -> list[dict]:
    label = label or article
    q = urlencode({"action": "query", "format": "json", "formatversion": 2, "redirects": 1, "titles": article,
                   "prop": "pageimages", "piprop": "original|name", "pilicense": "any"})
    raw, _ = _get(f"{WIKIPEDIA_EN}?{q}", accept="application/json", timeout=SEARCH_TIMEOUT, deadline=20)
    out = []
    for p in (json.loads(raw).get("query") or {}).get("pages") or []:
        img = p.get("original") or {}
        if not img.get("source") or p.get("missing"):
            continue
        name = p.get("pageimage") or Path(urlparse(img["source"]).path).name
        # the infobox image: a poster for most films, a title card for many shows
        out.append(_copyrighted({"url": img["source"], "thumbnail": img["source"],
                                 "title": f"{label} (Wikipedia lead image)",
                                 "width": img.get("width"), "height": img.get("height"),
                                 "source": f"https://en.wikipedia.org/wiki/File:{quote(name)}",
                                 "provider": "wikipedia", "kind": "artwork", "_rank": 0}, label))
    return out


def _tvmaze(title: str) -> list[dict]:
    raw, _ = _get(f"{TVMAZE}/singlesearch/shows?{urlencode({'q': title})}", accept="application/json",
                  timeout=SEARCH_TIMEOUT, deadline=15)
    show = json.loads(raw) or {}
    if not show.get("id") or _tokens(show.get("name") or "") != _tokens(title):
        return []
    name, page = show.get("name") or title, show.get("url") or "https://www.tvmaze.com"
    out = []
    img = show.get("image") or {}
    if img.get("original"):
        out.append(_copyrighted({"url": img["original"], "thumbnail": img.get("medium") or img["original"],
                                 "title": f"{name} poster", "width": 680, "height": 1000, "source": page,
                                 "provider": "tvmaze", "kind": "poster", "_rank": 0}, name))
    try:
        raw, _ = _get(f"{TVMAZE}/shows/{int(show['id'])}/images", accept="application/json",
                      timeout=SEARCH_TIMEOUT, deadline=15)
        stills = [i for i in json.loads(raw) if isinstance(i, dict) and i.get("type") == "background"]
        for k, im in enumerate(stills[:4]):
            o = (im.get("resolutions") or {}).get("original") or {}
            if o.get("url"):
                out.append(_copyrighted({"url": o["url"], "thumbnail": o["url"], "title": f"{name} still",
                                         "width": o.get("width"), "height": o.get("height"), "source": page,
                                         "provider": "tvmaze", "kind": "still", "_rank": k + 1}, name))
    except (EngineError, ValueError, TypeError):
        pass
    return out


# --- ranking -----------------------------------------------------------------------------------

def _stem(t: str) -> str:
    return t[:-1] if len(t) > 3 and t.endswith("s") else t


def _relevance(subject_toks: list[str], text: str) -> float:
    if not subject_toks:
        return 0.0
    got = {_stem(t) for t in _tokens(text)}
    joined = _norm(text).replace(" ", "")
    hit = 0.0
    for t in subject_toks:
        st = _stem(t)
        if st in got:
            hit += 1
        elif len(st) >= 4 and st in joined:                    # "iphone" in "iphone4s", "starbucks" in "starbuckscoffee"
            hit += 0.7
    return hit / len(subject_toks)


_SCREENSHOT = re.compile(r"\b(screenshot|screen ?shot|screencap|user interface|homepage|home page|web ?site)\b")
_LOGOISH = re.compile(r"\b(logo|logos|wordmark|logotype|icon|emblem|svg)\b")


# words a show's own title-logo file may carry besides its title ("Squid Game 2021 vector logo english")
_WORK_LOGO_EXTRA = frozenset({"vector", "english", "us", "uk", "series", "season", "title", "card", "tv",
                              "film", "movie", "anime", "horizontal", "international", "anglophone", "wordmark"})


def _is_brand_logo(r: dict, toks: list[str], extra: frozenset = frozenset()) -> bool:
    """A file that is just "<subject> logo" (years, versions, "with wordmark" aside): proof the
    subject is a brand, e.g. "Kestrel logo.svg" for "Kestrel", but not "Logo of the Linksys iPhone"."""
    title = re.sub(r"[.](svg|png|jpe?g|gif|webp)$", "", (r.get("title") or "").lower())
    if not _LOGOISH.search(title):
        return False
    rest = [t for t in _tokens(title) if t not in _LOGO_WORDS and not t.isdigit() and t not in extra
            and t not in {"svg", "png", "new", "old", "official", "text", "app"}]
    return bool(toks) and [_stem(t) for t in rest] == [_stem(t) for t in toks]


def _has_phrase(subject: str, title: str) -> bool:
    """The whole title of a work, in order, inside a file title ("the office us logo" has "the office")."""
    a, b = f" {_norm(subject)} ", f" {_norm(re.sub(r'[_]', ' ', title))} "
    return a in b or a.replace(" ", "") in b.replace(" ", "")


def _score(r: dict, plan: dict, toks: list[str]) -> float:
    title = r.get("title") or ""
    rel = 1.0 if (r.get("_wikidata") or r.get("_work")) else _relevance(toks, title)
    if r.get("_tags"):
        rel = max(rel, 0.6 * _relevance(toks, " ".join(r["_tags"])))
    logoish = bool(_LOGOISH.search(title.lower())) or r.get("provider") == "simpleicons"
    w, h = r.get("width") or 0, r.get("height") or 0
    short = min(w, h) if w and h else 0
    s = 3.0 * rel + (0.6, 0.4, 0.2)[r.get("_tier", 2)]
    # precision: "The Tower - Lisbon" beats "Lisbon Tower Shooting Memorial" for "Lisbon tower"
    words = [t for t in _tokens(re.sub(r"[.](svg|png|jpe?g|gif|webp|tiff?)$", "", title.lower()))
             if not t.isdigit() and t not in ("jpg", "jpeg", "png", "svg")]
    if words and toks:
        st = {_stem(t) for t in toks}
        s += 0.6 * sum(1 for w_ in words if _stem(w_) in st) / len(words)
    if r.get("_svg") or r.get("provider") == "simpleicons":
        s += 0.4
    elif short >= 1000:
        s += 0.6
    elif short >= 600:
        s += 0.3
    elif short and short < 400:
        s -= 0.8
    if plan["kind"] == "work":
        # what says "this show" on screen: its poster or a still (only when copyrighted art was asked
        # for), else its own title logo; then the cast, sets and merch photos Commons has
        if r.get("copyrighted"):
            # asked for: a poster or key art says "this show" best
            s += {"poster": 4.0, "artwork": 3.6}.get(r.get("kind"), 3.2)
        elif r.get("_wikidata"):
            # the work's own logo file (Wikidata P154), or its own image (P18)
            s += 2.5 if title == (plan.get("wikidata") or {}).get("logo") else 1.2
        elif _is_brand_logo(r, toks, _WORK_LOGO_EXTRA):
            s += 2.0
        elif not _has_phrase(plan["subject"], title):
            s -= 1.2                                         # "Office at the bank" is not "The Office"
        elif logoish:
            s -= 0.8                                         # "<title> Depot logo": another thing's logo
        if re.search(r"\b(fr|de|es|it|ja|ko|zh|ru|pt|pl|nl|tr|ar|uk)\b", title.lower().rsplit(".", 1)[0]):
            s -= 0.6                                         # "Spirited Away Logo fr.svg": a foreign-language title
    elif plan["kind"] == "logo":
        if r.get("kind") == "screenshot":
            # a free screenshot that names the app beats its other logos (not the exact brand mark)
            s += 2.8 if _has_phrase(plan["subject"], title) else -1.0
        elif r.get("provider") == "simpleicons":
            s += 4.0 if plan.get("brand") else 2.0
        elif logoish:
            s += 1.5
        elif plan["logoIntent"]:
            s -= 1.0
    elif plan.get("maybeBrand") and plan.get("_brandProof") and logoish:
        s += 1.5 if _is_brand_logo(r, toks) else 0.5
    else:                                                    # a photo was asked for
        if logoish or r.get("_svg"):
            s -= 1.0
        if re.search(r"\b(map|diagram|chart|coat of arms|flag|seal|graph|svg)\b", title.lower()):
            s -= 0.7
    if plan["kind"] == "concept" and r.get("provider") == "openverse":
        s += 0.4                                             # Flickr moods beat Commons' literal file names
    elif plan["kind"] == "place" and r.get("provider") == "wikimedia":
        s += 0.3
    if title.lstrip().startswith("#") or title.count("#") >= 3:  # hashtag-spam titles
        s -= 0.6
    s -= 0.03 * (r.get("_rank") or 0)                        # keep the source's own order as a tie-break
    return round(s, 3)


def _finish(r: dict, plan: dict) -> dict:
    r.setdefault("licenseUrl", "")
    r.setdefault("attributionRequired", True)
    r.setdefault("mime", "")
    r["kind"] = r.get("kind") or ("logo" if (_LOGOISH.search((r.get("title") or "").lower()) or r.get("_svg")) else "photo")
    r["trademark"] = bool(r.get("trademark") or r["kind"] == "logo")
    r["attribution"] = _attribution(r)
    if r.get("copyrighted"):
        r["note"] = COPYRIGHT_NOTE
    elif r["trademark"]:
        r["note"] = TRADEMARK_NOTE
    return {k: v for k, v in r.items() if not k.startswith("_")}


def _jobs(plan: dict, n: int, fallback: bool = False) -> list[tuple]:
    subj = plan["subject"]
    if fallback:
        toks = sorted(_tokens(subj), key=len, reverse=True)[:2]
        if not toks or " ".join(toks) == _norm(subj):
            return []
        subj = " ".join(toks)
    k = plan["kind"]
    if k == "work":
        wd = plan.get("wikidata") or {}
        jobs = [(_commons, f"{subj} logo", n, "drawing|bitmap"), (_commons, subj, n, "bitmap"), (_openverse, subj, n)]
        if not fallback and (wd.get("logo") or wd.get("image")):
            jobs.insert(0, (_commons_files, [wd.get("logo"), wd.get("image")]))
        if plan.get("copyrighted") and not fallback:
            # the work's own English article (Wikidata's sitelink): "The Office" alone is a disambiguation page
            jobs += [(_wikipedia_lead, wd.get("wiki") or wd.get("label") or subj, wd.get("label") or subj),
                     (_tvmaze, wd.get("label") or subj)]
        return jobs
    if k == "logo":
        jobs = [(_commons, f"{subj} logo", n, "drawing|bitmap"), (_openverse, f"{subj} logo", n)]
        if not plan["logoIntent"]:
            jobs.append((_openverse, subj, n))                # a bare brand name: its products/stores too
        if (plan.get("app") or (plan.get("wikidata") or {}).get("kind") == "app") and not fallback:
            jobs.append((_commons, f"{subj} screenshot", n, "bitmap"))   # the rare free screenshot of an app
        return jobs
    if k == "place":
        return [(_commons, subj, n, "bitmap"), (_openverse, subj, n)]
    jobs = [(_openverse, subj, n), (_commons, subj, n, "bitmap")]
    if plan.get("maybeBrand"):
        jobs.append((_commons, f"{subj} logo", max(4, n // 2), "drawing|bitmap"))
    return jobs


def _run(jobs: list[tuple]) -> tuple[list[dict], list[EngineError]]:
    from concurrent.futures import ThreadPoolExecutor
    results, errors = [], []
    if not jobs:
        return results, errors
    with ThreadPoolExecutor(max_workers=min(4, len(jobs))) as pool:
        futs = [(j, pool.submit(j[0], *j[1:])) for j in jobs]
        for j, fut in futs:
            try:
                results.extend(fut.result())
            except EngineError as e:
                errors.append(e)
                log(f"image search via {j[0].__name__} {j[1]!r}: {e.message}")
            except (ValueError, KeyError, TypeError) as e:     # a malformed API reply is one source down
                errors.append(EngineError("BAD_REPLY", str(e), "Image search had a hiccup."))
                log(f"image search via {j[0].__name__} {j[1]!r}: bad reply {e}")
    return results, errors


def search_images(query: str, n: int = 6, copyrighted: Optional[bool] = None) -> list[dict]:
    """Up to n images, best first (see search())."""
    return search(query, n, copyrighted)["results"]


def search(query: str, n: int = 6, copyrighted: Optional[bool] = None) -> dict:
    """{"results": [...], "plan": kind, "website"?: {url, name}}. Results are freely licensed
    unless copyrighted art was asked for (copyrighted=True or REELENGINE_ALLOW_COPYRIGHTED=1).
    Each result keeps the original keys (url, thumbnail, title, width, height, license, creator,
    source, provider) and adds licenseUrl, licenseKind (cc0 | public-domain | cc-by | cc-by-sa |
    copyrighted), attributionRequired, attribution (a one-line credit), trademark, copyrighted,
    kind (logo | photo | poster | still), mime, score, color (Simple Icons) and note.
    `website` is the official site of the app/brand/work the query named (Wikidata P856), for
    a screenshot (the app's capture_website): a site's own screen beats its logo."""
    query = (query or "").strip()
    if not query:
        raise EngineError("EMPTY_QUERY", "empty query", "Type what picture you're looking for.")
    plan = plan_query(query)
    plan["copyrighted"] = copyrighted_allowed(copyrighted)
    toks = _tokens(plan["subject"])
    wd = None
    if plan["kind"] == "work" or plan["app"] or (plan["kind"] == "logo" and not plan["logoIntent"]) \
            or plan["maybeBrand"]:
        wd = wikidata_lookup(plan["subject"], "work" if plan["kind"] == "work" else None)
        if wd and wd["kind"] == "work" and plan["kind"] != "work" and not plan["app"] and not plan["logoIntent"]:
            plan.update(kind="work", maybeBrand=False)       # "Naruto", "Friends": a show, not a brand
        plan["wikidata"] = wd
    found: list[dict] = []
    if plan["brand"] and plan["kind"] == "logo":
        found.append(_si_result(plan["brand"]))
    got, errors = _run(_jobs(plan, n))
    found += got
    if len({r["url"] for r in found}) < min(n, 3):
        more, errs = _run(_jobs(plan, n, fallback=True))
        found += more
        errors += errs
    if plan["maybeBrand"]:
        plan["_brandProof"] = any(_is_brand_logo(r, toks) for r in found)
    seen, ranked = set(), []
    for r in sorted(found, key=lambda r: -_score(r, plan, toks)):
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        r["score"] = _score(r, plan, toks)
        ranked.append(_finish(r, plan))
    if not ranked:
        if errors and all(e.code == "NO_INTERNET" for e in errors):
            raise errors[0]
        raise EngineError("NO_RESULTS", f"no images for {query!r}",
                          "I couldn't find pictures for that. Try different words.")
    _remember(ranked[:max(n, 12)])
    out = {"results": ranked[:n], "plan": plan["kind"]}
    if wd and wd.get("website") and (plan["app"] or wd["kind"] in ("app", "work") or plan["kind"] == "logo"):
        out["website"] = {"url": wd["website"], "name": wd.get("label") or plan["subject"]}
    return out


# --- credits: search results -> the asset the AI actually fetched -------------------------------

CREDIT_KEYS = ("title", "creator", "source", "provider", "license", "licenseUrl", "licenseKind",
               "attributionRequired", "attribution", "trademark", "copyrighted", "kind", "note")
_CREDITS_MAX = 500


def _remember(results: list[dict]) -> None:
    """search and fetch are separate engine runs, so recent results' credits live in the user
    cache; fetch_image looks its URL up there and writes the credit beside the saved file."""
    f = cache_dir() / "search-credits.json"
    try:
        with _FileLock(f):
            try:
                book = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                book = {}
            for r in results:
                book.pop(r["url"], None)
                book[r["url"]] = {k: r[k] for k in CREDIT_KEYS if k in r}
            if len(book) > _CREDITS_MAX:
                book = dict(list(book.items())[-_CREDITS_MAX:])
            _write_json(f, book)
    except OSError as e:
        log(f"search credits not cached: {e}")


def credit_for(url: str) -> Optional[dict]:
    try:
        return json.loads((cache_dir() / "search-credits.json").read_text(encoding="utf-8")).get(url)
    except (OSError, ValueError, AttributeError):
        return None


def _write_credit(saved: Path, url: str) -> Optional[dict]:
    """<folder>/credits.json maps each saved file name -> its licence + credit line, so the post
    caption can credit the pictures that need it (attributionRequired)."""
    c = credit_for(url)
    if not c:
        return None
    book_path = saved.parent / "credits.json"
    try:
        with _FileLock(book_path):
            try:
                book = json.loads(book_path.read_text(encoding="utf-8"))
                if not isinstance(book, dict):
                    book = {}
            except (OSError, ValueError):
                book = {}
            book[saved.name] = {**c, "url": url}
            _write_json(book_path, book)
    except OSError as e:
        log(f"credit not written for {saved.name}: {e}")
    return c


SCREENSHOT_NOTE = ("A screenshot of {site}: your own capture, but the page belongs to its owner. "
                   "Show it when you're talking about it (commentary), your responsibility; "
                   "don't imply the site made or endorses the video.")


def site_name(url: str) -> str:
    host = (urlparse(url or "").hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def register_capture(saved: Path, url: str, title: Optional[str] = None) -> dict:
    """Record a website screenshot the app captured (Electron, offscreen) in <folder>/credits.json:
    licenseKind "screenshot", labelled "Screenshot of <site>", never presented as free to reuse."""
    u = urlparse((url or "").strip())
    if u.scheme.lower() not in ("http", "https") or not u.hostname:
        raise EngineError("BAD_URL", f"register-capture: bad url {url!r}", "That isn't a web address.")
    site = site_name(url)
    label = f"Screenshot of {site}"
    c = {"title": _clean_html(title, 120) if title else label, "creator": site, "source": url, "provider": "capture",
         "license": "Screenshot (your own capture)", "licenseUrl": "", "licenseKind": "screenshot",
         "attributionRequired": False, "attribution": label, "trademark": True, "copyrighted": True,
         "kind": "screenshot", "note": SCREENSHOT_NOTE.format(site=site)}
    book_path = saved.parent / "credits.json"
    try:
        with _FileLock(book_path):
            try:
                book = json.loads(book_path.read_text(encoding="utf-8"))
                if not isinstance(book, dict):
                    book = {}
            except (OSError, ValueError):
                book = {}
            book[saved.name] = {**c, "url": url}
            _write_json(book_path, book)
    except OSError as e:
        log(f"credit not written for {saved.name}: {e}")
    return c


# --- fetch -------------------------------------------------------------------------------------

def _looks_html(data: bytes) -> bool:
    head = data[:512].lstrip().lower()
    return head.startswith(b"<!doctype html") or head.startswith(b"<html")


def fetch_image(url: str, dest, name: Optional[str] = None) -> Path:
    """Download an image URL into dest (a folder, or a full file path). Returns the saved path.
    Anything Pillow can open is kept as PNG/JPG (webp, gif, avif, bmp converted to PNG)."""
    from PIL import Image
    dest = Path(dest)
    data, ctype = _get(url, accept="image/*,*/*;q=0.8", ua=BROWSER_UA)
    if _looks_html(data):
        raise EngineError("NOT_AN_IMAGE", f"{url} returned HTML",
                          "That link is a web page, not a picture. Right-click the picture and copy its image address.")
    if b"<svg" in data[:1024].lower():
        # flat path-only SVGs (Simple Icons brand marks) are drawn to a transparent PNG
        from . import svgraster
        try:
            img = svgraster.render(data, size=1024, color=_simple_icon_color(url))
        except (ValueError, ET.ParseError, ArithmeticError) as e:
            raise EngineError("SVG_UNSUPPORTED", f"{url} is SVG ({e})",
                              "That picture is a drawing file I can't use. Try a PNG or JPG.") from None
        fmt = "SVG"
    else:
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
        except Exception as e:
            raise EngineError("NOT_AN_IMAGE", f"{url}: {e}", "I couldn't open that picture. Try a different one.") from None
        fmt = (img.format or "").upper()
    # the name is chosen by the AI: a slug only, never a path
    stem = slugify(name, 40) if name else slugify(Path(urlparse(url).path).stem, 40)
    if dest.suffix.lower() in (".png", ".jpg", ".jpeg"):
        out = dest
    else:
        from .safepath import safe_child
        ext = ".jpg" if fmt == "JPEG" else ".png"
        dest.mkdir(parents=True, exist_ok=True)
        out = safe_child(dest, f"{stem}{ext}", "image")
        k = 2
        while True:
            # claim the name atomically: two downloads in parallel must never pick the same file
            try:
                os.close(os.open(out, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
                break
            except FileExistsError:
                out = safe_child(dest, f"{stem}-{k}{ext}", "image")
                k += 1
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.stem + ".part" + out.suffix)
    try:
        if fmt == "JPEG" and out.suffix.lower() in (".jpg", ".jpeg"):
            tmp.write_bytes(data)
        else:
            if getattr(img, "is_animated", False):
                img.seek(0)
            img = img.convert("RGBA") if img.mode not in ("RGB", "RGBA") else img
            if out.suffix.lower() in (".jpg", ".jpeg"):
                img.convert("RGB").save(tmp, "JPEG", quality=92)
            else:
                img.save(tmp, "PNG")
        tmp.replace(out)
    except BaseException:
        tmp.unlink(missing_ok=True)
        if out.exists() and out.stat().st_size == 0:
            out.unlink(missing_ok=True)       # the claimed name, never filled
        raise
    _write_credit(out, url)
    return out


def logo(slug: str, dest, color: Optional[str] = None, png: bool = False) -> Path:
    """A brand mark from Simple Icons (CC0, keyless): the SVG by default, or with png=True a
    transparent 1024 px PNG in the brand colour (or `color`) that b-roll treatments can use."""
    slug = _title_to_slug(slug) or slugify(slug)
    if png:
        ver = _simple_icons().get("version") or "latest"
        url = SIMPLE_ICONS_SVG.format(v=ver, slug=quote(slug))
        data, _ = _get(url, accept="image/svg+xml", ua=API_UA)
        if b"<svg" not in data[:512].lower():
            raise EngineError("NO_LOGO", f"no logo for {slug}", "I couldn't find that logo. Try searching for a picture of it.")
        from . import svgraster
        try:
            img = svgraster.render(data, size=1024, color=color or _simple_icon_color(url))
        except (ValueError, ET.ParseError, ArithmeticError) as e:
            raise EngineError("NO_LOGO", f"{slug}: {e}", "I couldn't draw that logo. Try searching for a picture of it.") from None
        out = Path(dest) / f"{slugify(slug)}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        img.save(out, "PNG")
        return out
    url = f"{SIMPLE_ICONS}/{quote(slug)}" + (f"/{color.lstrip('#')}" if color else "")
    data, _ = _get(url, accept="image/svg+xml", ua=BROWSER_UA)
    if b"<svg" not in data[:512].lower():
        raise EngineError("NO_LOGO", f"no logo for {slug}", "I couldn't find that logo. Try searching for a picture of it.")
    out = Path(dest) / f"{slugify(slug)}.svg"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    return out


# --- media from a link (yt-dlp) ----------------------------------------------------------------

def _ytdlp_message(err: str) -> tuple[str, str]:
    e = err.lower()
    if "private" in e or "login" in e or "sign in" in e or "cookies" in e:
        return "LOGIN_REQUIRED", "That video is private or needs a login, so I can't download it."
    if "unsupported url" in e or "no video formats" in e:
        return "UNSUPPORTED_LINK", "I can't download from that link. Try a link to the video itself."
    if "unavailable" in e or "removed" in e or "404" in e:
        return "UNAVAILABLE", "That video isn't available anymore."
    if "urlopen" in e or "getaddrinfo" in e or "timed out" in e or "network" in e:
        return "NO_INTERNET", NO_NET
    return "DOWNLOAD_FAILED", "The download didn't work. Try again, or try a different link."


def download_media(url: str, dest, kind: str = "video", name: Optional[str] = None,
                   progress=None, max_height: int = 1920) -> Path:
    """Download a link with yt-dlp. kind "video" -> .mp4 (<= 1080p on the short side, h264/aac
    preferred so every player opens it), "music"/"audio" -> .mp3. Returns the saved file."""
    # the link first: a typo'd link is the user's to fix, not "reinstall"
    if not re.match(r"^https?://", (url or "").strip()):
        raise EngineError("BAD_LINK", f"not a link: {url!r}", "That doesn't look like a link. Copy the whole address and try again.")
    check_url(url)          # no loopback/private hosts (yt-dlp follows its own redirects after this)
    try:
        import yt_dlp  # type: ignore
    except ImportError:
        raise EngineError("NO_YTDLP", "yt-dlp is not installed",
                          "Downloading from links isn't available in this install. Reinstall Reel Studio.") from None
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    stem = slugify(name) if name else "%(title).60B"
    hooks = []
    if progress:
        def hook(d):
            if d.get("status") == "downloading" and (d.get("total_bytes") or d.get("total_bytes_estimate")):
                tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 1
                progress(min(99.0, 100.0 * (d.get("downloaded_bytes") or 0) / tot))
        hooks.append(hook)
    opts = {
        "outtmpl": str(dest / f"{stem}.%(ext)s"), "restrictfilenames": True, "noplaylist": True,
        "quiet": True, "no_warnings": True, "noprogress": True, "progress_hooks": hooks,
        "ffmpeg_location": str(Path(ffmpeg_bin()).parent) if Path(ffmpeg_bin()).is_absolute() else None,
        "http_headers": {"User-Agent": BROWSER_UA}, "socket_timeout": 30, "retries": 3,
    }
    opts = {k: v for k, v in opts.items() if v is not None}
    if os.environ.get("REELENGINE_CACHE_DIR"):
        opts["cachedir"] = str(cache_dir() / "yt-dlp")
    if kind in ("music", "audio"):
        opts.update({"format": "bestaudio/best",
                     "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "0"}]})
        want_ext = ".mp3"
    elif kind == "video":
        opts.update({"format": f"bv*[height<={max_height}][vcodec^=avc1]+ba[acodec^=mp4a]/"
                               f"bv*[height<={max_height}]+ba/b[height<={max_height}]/b",
                     "format_sort": ["res:1080", "vcodec:h264", "acodec:aac"],
                     "merge_output_format": "mp4"})
        want_ext = ".mp4"
    else:
        raise EngineError("BAD_KIND", f"kind {kind!r}", "Choose video or music.")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            fn = Path(ydl.prepare_filename(info))
    except Exception as e:  # yt-dlp raises DownloadError and friends
        code, msg = _ytdlp_message(str(e))
        raise EngineError(code, str(e)[-800:], msg) from None
    out = fn.with_suffix(want_ext)
    if not out.exists():
        cands = sorted(dest.glob(fn.stem + ".*"), key=lambda p: p.stat().st_mtime, reverse=True)
        cands = [c for c in cands if not c.name.endswith((".part", ".ytdl"))]
        if not cands:
            raise EngineError("DOWNLOAD_FAILED", f"no output for {url}", "The download didn't work. Try again.")
        out = cands[0]
    return out


# --- CLI ---------------------------------------------------------------------------------------

def main(argv=None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m reelengine.assets")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search", help="find freely licensed images")
    s.add_argument("query")
    s.add_argument("--n", type=int, default=6)
    f = sub.add_parser("fetch", help="download an image URL")
    f.add_argument("url")
    f.add_argument("--dest", required=True)
    f.add_argument("--name")
    d = sub.add_parser("download", help="download a video or song from a link (yt-dlp)")
    d.add_argument("url")
    d.add_argument("--dest", required=True)
    d.add_argument("--kind", choices=["video", "music", "audio"], default="video")
    d.add_argument("--name")
    lg = sub.add_parser("logo", help="brand mark SVG from Simple Icons")
    lg.add_argument("slug")
    lg.add_argument("--dest", required=True)
    lg.add_argument("--png", action="store_true", help="a transparent PNG in the brand colour")
    args = ap.parse_args(argv)

    def emit(obj):
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()
    try:
        if args.cmd == "search":
            emit({"event": "progress", "stage": "search", "pct": 10, "message": "Looking for pictures"})
            res = {"results": search_images(args.query, args.n)}
        elif args.cmd == "fetch":
            emit({"event": "progress", "stage": "fetch", "pct": 10, "message": "Getting the picture"})
            res = {"path": str(fetch_image(args.url, args.dest, args.name))}
        elif args.cmd == "download":
            emit({"event": "progress", "stage": "download", "pct": 1, "message": "Downloading"})
            res = {"path": str(download_media(
                args.url, args.dest, args.kind, args.name,
                progress=lambda p: emit({"event": "progress", "stage": "download", "pct": round(p, 1),
                                         "message": "Downloading"})))}
        else:
            res = {"path": str(logo(args.slug, args.dest, png=args.png))}
        emit({"event": "done", "result": res})
        return 0
    except EngineError as e:
        emit(e.to_event())
        return 1


if __name__ == "__main__":
    sys.exit(main())
