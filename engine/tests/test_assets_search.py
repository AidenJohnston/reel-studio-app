"""Picture search: query planning, licence filtering, ranking, Simple Icons logos, SVG drawing and
credits. Every network call is mocked with API-shaped JSON; the one live test needs
REELENGINE_NET_TESTS=1."""
import json
import os
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

from reelengine import assets, svgraster
from reelengine.compose_util import EngineError

ZORBLAX_SVG = (b'<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Zorblax</title>'
              b'<path d="M9.317 9.451c.045.073.123.12.212.12.06 0 .116-.021.158-.057l.015-.012c.39-.325.741-.66 '
              b'1.071-1.017 3.209-3.483 1.335-7.759 1.32-7.799-.09-.21-.03-.459.15-.594.195-.135.435-.12.615.033 '
              b'10.875 10.114 7.995 17.818 7.785 18.337-.87 3.141-4.335 5.414-8.444 5.53-.138.008-.242.008-.363.008'
              b'-4.852 0-8.977-2.989-8.977-6.807v-.06c0-5.297 4.795-10.522 5.009-10.744.136-.149.345-.195.525-.105'
              b'.18.076.297.255.291.451-.043 1.036.167 1.935.631 2.7v.015l.002.001z"/></svg>')

SI_DATA = [
    {"title": "Zorblax", "slug": "zorblax", "hex": "FF6B6B"},
    {"title": "Instagram", "slug": "instagram", "hex": "FF0069"},
    {"title": "McDonald's", "slug": "mcdonalds", "hex": "FBC817"},
    {"title": "Coca-Cola", "slug": "cocacola", "hex": "D00013", "aliases": {"aka": ["Coke"]}},
]


def ov_item(title, lic, ver="2.0", w=1600, h=1200, url=None, tags=()):
    return {"title": title, "url": url or f"https://live.staticflickr.com/1/{abs(hash(title + lic))}.jpg",
            "thumbnail": "https://api.openverse.org/v1/images/x/thumb/", "width": w, "height": h,
            "license": lic, "license_version": ver, "license_url": f"https://creativecommons.org/licenses/{lic}/{ver}/",
            "creator": "someone", "foreign_landing_url": "https://www.flickr.com/photos/x/1", "source": "flickr",
            "tags": [{"name": t} for t in tags]}


def cm_page(i, title, lic, mime="image/jpeg", w=4000, h=3000, restrictions="", nonfree="", license_code="",
            attribution="true", artist='<a href="//commons.wikimedia.org/wiki/User:X">X &amp; Y</a>'):
    ext = {"image/svg+xml": "svg", "image/png": "png"}.get(mime, "jpg")
    url = f"https://upload.wikimedia.org/wikipedia/commons/a/ab/{i}.{ext}"
    meta = {"LicenseShortName": {"value": lic}, "License": {"value": license_code},
            "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0" if "SA" in lic else ""},
            "Artist": {"value": artist}, "AttributionRequired": {"value": attribution},
            "Restrictions": {"value": restrictions}}
    if nonfree:
        meta["NonFree"] = {"value": nonfree}
    return {"title": f"File:{title}", "index": i, "imageinfo": [{
        "url": url, "mime": mime, "width": w, "height": h, "size": 2_000_000,
        "thumburl": f"https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/{i}.{ext}/1280px-{i}.png",
        "thumbwidth": 1280, "thumbheight": int(1280 * h / w),
        "descriptionurl": f"https://commons.wikimedia.org/wiki/File:{i}", "extmetadata": meta}]}


class FakeNet:
    """Routes assets._get by host; records every URL asked for."""

    def __init__(self, openverse=None, commons=None, svg=ZORBLAX_SVG, fail=(), wikidata=None, files=None,
                 wikipedia=None, tvmaze=None):
        self.openverse = openverse or (lambda q: [])
        self.commons = commons or (lambda q: [])
        self.svg, self.fail, self.urls = svg, set(fail), []
        # wikidata: {Qid: entity}; wbsearchentities returns the ids whose label starts with the query
        self.wikidata = wikidata or {}
        self.files = files or {}                 # Commons "File:<name>" -> page (Wikidata P154/P18)
        self.wikipedia = wikipedia or {}         # article title -> {"source", "width", "height"}
        self.tvmaze = tvmaze or {}               # show name -> show JSON

    def __call__(self, url, accept="*/*", ua=None, timeout=30, limit=0, deadline=90.0):
        self.urls.append(url)
        u = urlparse(url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        for host in self.fail:
            if host in u.netloc:
                raise EngineError("NO_INTERNET", f"{url}: down", assets.NO_NET)
        if "data.jsdelivr.com" in u.netloc:
            return json.dumps({"version": "16.35.0"}).encode(), "application/json"
        if u.path.endswith("simple-icons.json"):
            return json.dumps(SI_DATA).encode(), "application/json"
        if u.path.endswith(".svg"):
            return self.svg, "image/svg+xml"
        if "openverse" in u.netloc:
            assert q["license"] == "cc0,pdm,by,by-sa"
            return json.dumps({"results": self.openverse(q["q"])}).encode(), "application/json"
        if "commons.wikimedia" in u.netloc and "titles" in q:
            pages = [self.files[t[5:]] for t in q["titles"].split("|") if t[5:] in self.files]
            return json.dumps({"query": {"pages": pages}}).encode(), "application/json"
        if "commons.wikimedia" in u.netloc:
            return json.dumps({"query": {"pages": self.commons(q["gsrsearch"])}}).encode(), "application/json"
        if "wikidata.org" in u.netloc:
            if q.get("action") == "wbsearchentities":
                hits = [{"id": k} for k, e in self.wikidata.items()
                        if e["labels"]["en"]["value"].lower().startswith(q["search"].lower())]
                return json.dumps({"search": hits}).encode(), "application/json"
            if q.get("action") == "wbgetentities":
                ids = q["ids"].split("|")
                return json.dumps({"entities": {i: self.wikidata[i] for i in ids if i in self.wikidata}}).encode(), ""
            if q.get("list") == "search":
                assert "haswbstatement:P31=" in q["srsearch"]
                return json.dumps({"query": {"search": []}}).encode(), "application/json"
        if "en.wikipedia.org" in u.netloc:
            img = self.wikipedia.get(q["titles"])
            page = {"title": q["titles"], **({"original": img, "pageimage": "Poster.jpg"} if img else {})}
            return json.dumps({"query": {"pages": [page]}}).encode(), "application/json"
        if "api.tvmaze.com" in u.netloc:
            if u.path == "/singlesearch/shows":
                show = self.tvmaze.get(q["q"])
                if not show:
                    raise EngineError("HTTP_ERROR", "HTTP 404", "x")
                return json.dumps(show).encode(), "application/json"
            if u.path.endswith("/images"):
                return json.dumps([{"type": "background", "resolutions": {"original": {
                    "url": "https://static.tvmaze.com/uploads/images/original_untouched/1/2.jpg",
                    "width": 1920, "height": 1080}}}, {"type": "poster"}]).encode(), "application/json"
        raise AssertionError(f"unexpected url {url}")


@pytest.fixture()
def net(monkeypatch, tmp_path):
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(assets, "_SI_INDEX", None)

    def install(fake):
        monkeypatch.setattr(assets, "_get", fake)
        return fake
    yield install
    assets._SI_INDEX = None


# --- licences ---------------------------------------------------------------------------------

@pytest.mark.parametrize("name,url,code,kind", [
    ("CC0", "", "cc0", "cc0"),
    ("CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/", "", "cc0"),
    ("Public domain", "", "pd", "public-domain"),
    ("Public Domain Mark 1.0", "", "pdm", "public-domain"),
    ("PD-textlogo", "", "", "public-domain"),
    ("CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/", "by", "cc-by"),
    ("CC BY 4.0", "", "cc-by-4.0", "cc-by"),
    ("CC BY-SA 3.0", "", "cc-by-sa-3.0", "cc-by-sa"),
    ("Attribution", "", "attribution", "cc-by"),
])
def test_accepted_licences(name, url, code, kind):
    lic = assets.classify_license(name, url, code)
    assert lic and lic["kind"] == kind
    assert lic["attributionRequired"] == (kind in ("cc-by", "cc-by-sa"))


@pytest.mark.parametrize("name,code", [
    ("CC BY-NC 2.0", "by-nc"), ("CC BY-NC-SA 2.0", "by-nc-sa"), ("CC BY-ND 2.0", "by-nd"),
    ("CC BY-NC-ND 4.0", "by-nc-nd"), ("Fair use", ""), ("GFDL", "gfdl"), ("All rights reserved", ""),
    ("", ""), ("OGL 3", ""), ("Sampling Plus 1.0", "sampling+"),
])
def test_refused_licences(name, code):
    assert assets.classify_license(name, "", code) is None


# --- planning ---------------------------------------------------------------------------------

def test_plan_query_kinds(net):
    net(FakeNet())
    assert assets.plan_query("Zorblax")["kind"] == "logo" and assets.plan_query("Zorblax")["brand"]["slug"] == "zorblax"
    assert assets.plan_query("coke logo")["brand"]["slug"] == "cocacola"          # Simple Icons alias
    assert assets.plan_query("McDonalds")["brand"]["slug"] == "mcdonalds"         # titleToSlug match
    p = assets.plan_query("Kestrel app logo")
    assert p["kind"] == "logo" and p["subject"] == "Kestrel" and p["logoIntent"]
    assert assets.plan_query("Lisbon tower")["kind"] == "place"
    assert assets.plan_query("loneliness")["kind"] == "concept"
    assert assets.plan_query("studying")["kind"] == "concept"
    assert assets.plan_query("coffee cup photo") == {"kind": "object", "subject": "coffee cup", "logoIntent": False,
                                                      "brand": None, "maybeBrand": False, "app": False}
    assert assets.plan_query("iPhone")["maybeBrand"]


def test_title_to_slug_matches_simple_icons_rules():
    assert assets._title_to_slug("McDonald's") == "mcdonalds"
    assert assets._title_to_slug("Coca-Cola") == "cocacola"
    assert assets._title_to_slug("Dev.to") == "devdotto"
    assert assets._title_to_slug("C++") == "cplusplus"
    assert assets._title_to_slug("Citroën") == "citroen"


# --- search -----------------------------------------------------------------------------------

BACK_COMPAT = {"url", "thumbnail", "title", "width", "height", "license", "creator", "source", "provider"}
NEW_FIELDS = {"licenseUrl", "licenseKind", "attributionRequired", "attribution", "trademark", "kind", "score"}


def test_brand_search_puts_simple_icons_first(net):
    fake = net(FakeNet(
        openverse=lambda q: [ov_item("zorblax fungus", "by-nc-nd"), ov_item("Zorblax", "by", tags=["app"])],
        commons=lambda q: [cm_page(0, "Zorblax logo (2026).svg", "Public domain", "image/svg+xml", 512, 200,
                                   restrictions="trademarked", license_code="pd", attribution="false")]))
    res = assets.search_images("Zorblax", 6)
    top = res[0]
    assert top["provider"] == "simpleicons" and top["color"] == "#FF6B6B"
    assert top["url"] == "https://cdn.jsdelivr.net/npm/simple-icons@16.35.0/icons/zorblax.svg"
    assert top["licenseKind"] == "cc0" and top["trademark"] and not top["attributionRequired"]
    assert res[1]["title"] == "Zorblax logo (2026).svg" and res[1]["url"].endswith("1280px-0.png")  # SVG -> PNG render
    assert res[1]["trademark"] and res[1]["licenseKind"] == "public-domain"
    assert all("nc" not in r["license"].lower() for r in res)                    # NC dropped client-side too
    for r in res:
        assert BACK_COMPAT | NEW_FIELDS <= set(r) and not any(k.startswith("_") for k in r)
    assert any("commons.wikimedia.org" in u and "Zorblax+logo" in u for u in fake.urls)


def test_commons_licence_metadata_is_read_and_filtered(net):
    net(FakeNet(commons=lambda q: [
        cm_page(0, "Piano fair use.jpg", "Fair use", nonfree="true"),
        cm_page(1, "Piano gfdl.jpg", "GFDL", license_code="gfdl"),
        cm_page(2, "Grand piano.jpg", "CC BY-SA 4.0", license_code="cc-by-sa-4.0"),
        cm_page(3, "Upright piano.jpg", "CC0", license_code="cc0", attribution="false"),
        cm_page(4, "Piano.tif", "CC0", mime="image/tiff"),
    ]))
    res = assets.search_images("piano", 6)
    assert [r["title"] for r in res] == ["Upright piano.jpg", "Grand piano.jpg"]   # CC0 outranks BY-SA
    sa = res[1]
    assert sa["attributionRequired"] and sa["creator"] == "X & Y"
    assert sa["licenseUrl"].startswith("https://creativecommons.org/licenses/by-sa")
    assert sa["attribution"] == '"Grand piano.jpg" by X & Y, CC BY-SA 4.0, via Wikimedia Commons'
    assert not sa["trademark"] and sa["kind"] == "photo"


def test_relevance_beats_api_order(net):
    net(FakeNet(openverse=lambda q: [
        ov_item("#flowers #green #nature #beautiful", "by-sa", tags=["instagram"]),
        ov_item("Coffee", "by", w=300, h=200),
        ov_item("Full coffee cup", "by"),
    ]))
    res = assets.search_images("coffee cup", 3)
    assert res[0]["title"] == "Full coffee cup"
    assert res[-1]["title"].startswith("#flowers")


def test_maybe_brand_needs_proof(net):
    kestrel = [cm_page(0, "Kestrel Valimokatu Oulu.jpg", "CC0", license_code="cc0"),
             cm_page(1, "Kestrel logo.svg", "Public domain", "image/svg+xml", 103, 39, license_code="pd",
                     restrictions="trademarked")]
    net(FakeNet(commons=lambda q: kestrel))
    assert assets.search_images("Kestrel", 4)[0]["title"] == "Kestrel logo.svg"

    phone = [cm_page(0, "Apple iPhone 15.jpg", "CC0", license_code="cc0"),
             cm_page(1, "Logo of the Linksys iPhone.svg", "Public domain", "image/svg+xml", license_code="pd")]
    net(FakeNet(commons=lambda q: phone))
    assert assets.search_images("iPhone", 4)[0]["title"] == "Apple iPhone 15.jpg"


def test_one_source_down_still_returns(net):
    net(FakeNet(commons=lambda q: [cm_page(0, "Times Square at night.jpg", "CC BY 4.0", license_code="cc-by-4.0")],
                fail={"openverse"}))
    res = assets.search_images("Times Square", 3)
    assert res and res[0]["provider"] == "wikimedia"


def test_all_sources_down_is_no_internet(net):
    net(FakeNet(fail={"openverse", "wikimedia", "jsdelivr"}))
    with pytest.raises(EngineError) as e:
        assets.search_images("money", 3)
    assert e.value.code == "NO_INTERNET"


def test_nothing_found(net):
    net(FakeNet())
    with pytest.raises(EngineError) as e:
        assets.search_images("zzqx", 3)
    assert e.value.code == "NO_RESULTS"


def test_simple_icons_index_is_cached(net, tmp_path):
    fake = net(FakeNet())
    assets.plan_query("Zorblax")
    assert (tmp_path / "cache" / "simple-icons.json").exists()
    assets._SI_INDEX = None
    n = len(fake.urls)
    assert assets.plan_query("Instagram")["brand"]["hex"] == "FF0069"
    assert len(fake.urls) == n                                                      # served from disk


# --- svg + fetch + credits --------------------------------------------------------------------

def test_fetch_simple_icon_svg_becomes_brand_coloured_png(net, tmp_path):
    net(FakeNet(commons=lambda q: []))
    res = assets.search_images("Zorblax logo", 3)
    out = assets.fetch_image(res[0]["url"], tmp_path / "assets", name="zorblax")
    assert out.suffix == ".png"
    im = Image.open(out).convert("RGBA")
    assert max(im.size) >= 900
    assert im.getpixel((0, 0))[3] == 0                                              # transparent corner
    r, g, b, a = im.getpixel((im.width // 2, int(im.height * 0.7)))
    assert a == 255 and (r, g, b) == (0xFF, 0x6B, 0x6B)
    credits = json.loads((tmp_path / "assets" / "credits.json").read_text(encoding="utf-8"))
    c = credits["zorblax.png"]
    assert c["provider"] == "simpleicons" and c["trademark"] and c["url"] == res[0]["url"]
    assert assets.credit_for(res[0]["url"])["licenseKind"] == "cc0"


def test_fetch_records_credit_for_attribution_pictures(net, tmp_path, monkeypatch):
    net(FakeNet(commons=lambda q: [cm_page(0, "Grand piano.jpg", "CC BY-SA 4.0", license_code="cc-by-sa-4.0")]))
    hit = assets.search_images("grand piano", 1)[0]
    buf = tmp_path / "p.png"
    Image.new("RGB", (40, 30), "red").save(buf)
    monkeypatch.setattr(assets, "_get", lambda url, **kw: (buf.read_bytes(), "image/png"))
    out = assets.fetch_image(hit["url"], tmp_path / "assets", name="piano")
    c = json.loads((out.parent / "credits.json").read_text(encoding="utf-8"))[out.name]
    assert c["attributionRequired"] and c["attribution"].endswith("CC BY-SA 4.0, via Wikimedia Commons")


def test_fetch_unknown_url_writes_no_credit(net, tmp_path, monkeypatch):
    net(FakeNet())
    buf = tmp_path / "p.png"
    Image.new("RGB", (40, 30), "red").save(buf)
    monkeypatch.setattr(assets, "_get", lambda url, **kw: (buf.read_bytes(), "image/png"))
    out = assets.fetch_image("https://example.com/x.png", tmp_path / "assets")
    assert out.exists() and not (out.parent / "credits.json").exists()


def test_fetch_never_inherits_the_credit_of_a_deleted_file_with_the_same_name(net, tmp_path, monkeypatch):
    net(FakeNet(commons=lambda q: [cm_page(0, "Grand piano.jpg", "CC BY-SA 4.0", license_code="cc-by-sa-4.0")]))
    hit = assets.search_images("grand piano", 1)[0]
    buf = tmp_path / "p.png"
    Image.new("RGB", (40, 30), "red").save(buf)
    monkeypatch.setattr(assets, "_get", lambda url, **kw: (buf.read_bytes(), "image/png"))
    first = assets.fetch_image(hit["url"], tmp_path / "assets", name="piano")
    first.unlink()
    again = assets.fetch_image("https://example.com/piano.png", tmp_path / "assets", name="piano")
    assert again == first
    assert again.name not in json.loads((again.parent / "credits.json").read_text(encoding="utf-8"))


def test_complex_svg_still_refused(net, tmp_path):
    net(FakeNet(svg=b'<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'))
    with pytest.raises(EngineError) as e:
        assets.fetch_image("https://example.com/drawing.svg", tmp_path)
    assert e.value.code == "SVG_UNSUPPORTED"


def test_logo_png(net, tmp_path):
    net(FakeNet())
    out = assets.logo("Zorblax", tmp_path, png=True)
    assert out.name == "zorblax.png" and Image.open(out).mode == "RGBA"


# --- the rasteriser itself --------------------------------------------------------------------

RING = "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM12 6a6 6 0 1 0 0 12a6 6 0 1 0 0-12z"
RING_REVERSED_HOLE = "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM12 6a6 6 0 1 1 0 12a6 6 0 1 1 0-12z"


def _svg(d, rule=None):
    fr = f' fill-rule="{rule}"' if rule else ""
    return f'<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path{fr} d="{d}"/></svg>'.encode()


def test_nonzero_and_evenodd_winding():
    centre = lambda im: im.getpixel((im.width // 2, im.height // 2))[3]
    assert centre(svgraster.render(_svg(RING), 200, margin=0)) == 255          # same direction: filled
    assert centre(svgraster.render(_svg(RING, "evenodd"), 200, margin=0)) == 0  # even-odd: hole
    assert centre(svgraster.render(_svg(RING_REVERSED_HOLE), 200, margin=0)) == 0  # opposite: hole


def test_compact_arc_flags_and_relative_commands():
    subs = svgraster.parse_path("M2 12a10 10 0 0110 10h-1.5v-3.5-.5z", 10)
    end = subs[0][-1]
    assert subs and end == (2.0, 12.0)                                            # closed back to start
    xs = [p[0] for p in subs[0]]
    assert max(xs) == pytest.approx(12.0, abs=1e-6)


def test_fill_mask_square_is_exact():
    m = svgraster.fill_mask([[(10, 10), (30, 10), (30, 20), (10, 20)]], 40, 30)
    assert m.sum() == 20 * 10 and m[15, 10] and not m[15, 30]


@pytest.mark.parametrize("svg", [
    b'<svg viewBox="0 0 24 24"><path transform="scale(2)" d="M0 0h1v1z"/></svg>',
    b'<svg viewBox="0 0 24 24"><circle r="3"/></svg>',
    b'<svg viewBox="0 0 24 24"><path style="fill:red" d="M0 0h1v1z"/></svg>',
    b'<!DOCTYPE svg [<!ENTITY a "b">]><svg viewBox="0 0 24 24"><path d="M0 0h1v1z"/></svg>',
    b'<svg viewBox="0 0 24 24"><path fill="url(#g)" d="M0 0h1v1z"/></svg>',
])
def test_rasteriser_refuses_what_it_cannot_draw(svg):
    with pytest.raises(ValueError):
        svgraster.render(svg, 64)


def test_path_fill_attribute_wins_over_default_colour():
    svg = b'<svg viewBox="0 0 24 24" fill="#00ff00"><path d="M0 0h24v24H0z"/></svg>'
    im = svgraster.render(svg, 32, color="#ff0000", margin=0)
    assert im.getpixel((16, 16)) == (0, 255, 0, 255)


# --- live -------------------------------------------------------------------------------------

@pytest.mark.skipif(os.environ.get("REELENGINE_NET_TESTS") != "1", reason="network tests off")
def test_search_live_logos_and_licences(tmp_path, monkeypatch):
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(assets, "_SI_INDEX", None)
    res = assets.search_images("Zorblax logo", 4)
    assert res[0]["provider"] == "simpleicons"
    assert assets.fetch_image(res[0]["url"], tmp_path).suffix == ".png"
    glimmerpost = assets.search_images("Glimmerpost", 4)                                     # removed from Simple Icons
    assert any("glimmerpost" in r["title"].lower() and r["kind"] == "logo" for r in glimmerpost)
    for r in assets.search_images("Times Square", 6):
        assert r["licenseKind"] in ("cc0", "public-domain", "cc-by", "cc-by-sa")
