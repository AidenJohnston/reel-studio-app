"""Picture search for SHOWS / FILMS and APPS / WEBSITES: the "work" query plan, Wikidata (which
thing a name means, its own logo file, its official website), copyrighted artwork kept OFF unless
asked for and labelled when on, free app screenshots, and website-capture credits. Every network
call is mocked (see FakeNet in test_assets_search); all names are made up."""
import json

import pytest

from reelengine import assets, cli
from reelengine.compose_util import EngineError
from reelengine.proto import EngineError as CliError

from test_assets_search import FakeNet, cm_page, net  # noqa: F401  (net is a fixture)


def entity(qid, label, desc, website=None, logo=None, image=None, links=10, mul=False):
    claims = {}
    for prop, v in (("P856", website), ("P154", logo), ("P18", image)):
        if v:
            claims[prop] = [{"rank": "normal", "mainsnak": {"datavalue": {"value": v}}}]
    labels = {"mul": {"value": label}} if mul else {"en": {"value": label}}
    return {"id": qid, "labels": labels, "descriptions": {"en": {"value": desc}}, "claims": claims,
            "aliases": {}, "sitelinks": {f"w{i}": {} for i in range(links)}}


class SearchableMul(FakeNet):
    """wbsearchentities only sees English labels, like the real one sees an item by its "mul" name
    only through the full-text index; here every entity is found by its label in either slot."""

    def __call__(self, url, *a, **k):
        for e in self.wikidata.values():
            e["labels"].setdefault("en", e["labels"].get("mul"))
        return super().__call__(url, *a, **k)


@pytest.fixture(autouse=True)
def _no_copyright_env(monkeypatch):
    monkeypatch.delenv("REELENGINE_ALLOW_COPYRIGHTED", raising=False)
    assets._WD_MEM.clear()
    yield
    assets._WD_MEM.clear()


# --- planning ---------------------------------------------------------------------------------

def test_work_words_make_a_work_plan_only_for_a_title(net):
    net(FakeNet())
    p = assets.plan_query("Gleebworth TV show")
    assert p["kind"] == "work" and p["subject"] == "Gleebworth"
    assert assets.plan_query("The Quiet Harbor movie")["subject"] == "The Quiet Harbor"
    assert assets.plan_query("Moonfall Academy anime")["kind"] == "work"
    # not titles: ordinary things with a work word stay photos
    assert assets.plan_query("dog show")["kind"] != "work"
    assert assets.plan_query("film camera")["kind"] != "work"
    assert assets.plan_query("watching a movie")["kind"] != "work"


def test_website_words_are_an_app_plan(net):
    net(FakeNet())
    p = assets.plan_query("Kestrel website")
    assert p["app"] and p["kind"] == "logo" and p["subject"] == "Kestrel"
    assert assets.plan_query("Kestrel app")["app"]
    assert not assets.plan_query("Kestrel")["app"]


# --- Wikidata ---------------------------------------------------------------------------------

def test_wikidata_prefers_a_show_or_app_over_a_namesake_and_the_most_linked(net):
    wd = {"Q1": entity("Q1", "Gleebworth", "city in a made-up country", website="https://city.example"),
          "Q2": entity("Q2", "Gleebworth", "2001 film", links=3),
          "Q3": entity("Q3", "Gleebworth", "American sitcom (1990-2000)", logo="Gleebworth logo.svg", links=90),
          "Q4": entity("Q4", "The Gleebworth", "1994 film", links=200)}       # "The X" is not "X"
    net(FakeNet(wikidata=wd))
    v = assets.wikidata_lookup("Gleebworth")
    assert v["id"] == "Q3" and v["kind"] == "work" and v["logo"] == "Gleebworth logo.svg"
    # a city with a website is NOT an app (the website alone doesn't make it one)
    assert assets.wikidata_lookup("Gleebworth", "app") is None


def test_wikidata_reads_the_language_neutral_label(net):
    net(SearchableMul(wikidata={"Q7": entity("Q7", "Pallbearers", "American sitcom", mul=True)}))
    assert assets.wikidata_lookup("Pallbearers", "work")["id"] == "Q7"


def test_wikidata_answers_are_cached_on_disk(net):
    fake = net(FakeNet(wikidata={"Q3": entity("Q3", "Gleebworth", "anime television series")}))
    assert assets.wikidata_lookup("Gleebworth", "work")["id"] == "Q3"
    asked = len(fake.urls)
    assets._WD_MEM.clear()
    assert assets.wikidata_lookup("Gleebworth", "work")["id"] == "Q3"
    assert len(fake.urls) == asked                         # second answer came from the cache file


def test_wikidata_down_never_stops_the_search(net):
    commons = lambda q: [cm_page(1, "Gleebworth logo.svg", "Public domain", mime="image/svg+xml")]  # noqa: E731
    net(FakeNet(commons=commons, fail=("wikidata.org",)))
    res = assets.search("Gleebworth TV show", 4)
    assert res["results"] and "website" not in res


def test_wikidata_requests_send_the_generic_app_user_agent(monkeypatch):
    seen = {}

    class Stop(Exception):
        pass

    def fake_open(req, timeout=0):
        seen["ua"] = req.get_header("User-agent")
        raise Stop()
    monkeypatch.setattr(assets._OPENER, "open", fake_open)
    monkeypatch.setattr(assets, "check_url", lambda u: u)
    with pytest.raises(Stop):
        assets._get("https://www.wikidata.org/w/api.php?action=wbsearchentities", ua=assets.BROWSER_UA)
    assert seen["ua"] == assets.API_UA and "@" not in seen["ua"]


# --- shows and films --------------------------------------------------------------------------

def show_net(**kw):
    wd = {"Q3": entity("Q3", "Gleebworth", "American sitcom", website="https://gleebworth.example/",
                       logo="Gleebworth US logo.svg")}
    files = {"Gleebworth US logo.svg": cm_page(9, "Gleebworth US logo.svg", "Public domain", mime="image/svg+xml",
                                              restrictions="trademarked")}

    def commons(q):
        return [cm_page(1, "Gleebworth Depot logo (horizontal).svg", "Public domain", mime="image/svg+xml"),
                cm_page(2, "Office at Gleebworth Street.jpg", "CC BY-SA 4.0"),
                cm_page(3, "Gleebworth cast at the premiere.jpg", "CC BY 2.0")]
    return FakeNet(commons=commons, wikidata=wd, files=files, **kw)


def test_bare_title_becomes_a_work_and_its_own_logo_comes_first(net):
    fake = net(show_net())
    res = assets.search("Gleebworth", 4)
    assert res["plan"] == "work"
    top = res["results"][0]
    assert top["title"] == "Gleebworth US logo.svg" and top["licenseKind"] == "public-domain"
    assert top["trademark"] and top["note"] == assets.TRADEMARK_NOTE
    titles = [r["title"] for r in res["results"]]
    assert titles.index("Gleebworth cast at the premiere.jpg") < titles.index("Gleebworth Depot logo (horizontal).svg")
    assert res["website"] == {"url": "https://gleebworth.example/", "name": "Gleebworth"}
    # copyrighted art is OFF by default: neither source is even asked
    assert not any("wikipedia.org" in u or "tvmaze" in u for u in fake.urls)
    assert not any(r.get("copyrighted") for r in res["results"])


def test_copyrighted_art_only_when_asked_and_always_labelled(net, monkeypatch):
    poster = {"source": "https://upload.wikimedia.org/wikipedia/en/1/1a/Poster.jpg", "width": 600, "height": 900}
    show = {"id": 5, "name": "Gleebworth", "url": "https://www.tvmaze.com/shows/5/gleebworth",
            "image": {"medium": "https://static.tvmaze.com/m.jpg", "original": "https://static.tvmaze.com/o.jpg"}}
    fake = net(show_net(wikipedia={"Gleebworth": poster}, tvmaze={"Gleebworth": show}))
    res = assets.search("Gleebworth TV show", 8, copyrighted=True)
    top = res["results"][0]
    assert top["kind"] in ("poster", "artwork") and top["copyrighted"] and top["licenseKind"] == "copyrighted"
    marked = [r for r in res["results"] if r.get("copyrighted")]
    assert {r["provider"] for r in marked} == {"wikipedia", "tvmaze"}
    assert any(r["kind"] == "still" for r in marked)
    for r in marked:
        assert r["note"] == assets.COPYRIGHT_NOTE and "your responsibility" in r["note"]
        assert "copyrighted: used as commentary" in r["attribution"] and "its owner" in r["creator"]
        assert r["attributionRequired"] and r["license"] == "Copyrighted (not licensed)"
    assert any("tvmaze" in u for u in fake.urls)
    # the environment switch does the same; the free results never change licence
    assets._WD_MEM.clear()
    monkeypatch.setenv("REELENGINE_ALLOW_COPYRIGHTED", "1")
    assert any(r.get("copyrighted") for r in assets.search("Gleebworth TV show", 8)["results"])
    assert all(r["licenseKind"] in ("cc0", "public-domain", "cc-by", "cc-by-sa", "copyrighted")
               for r in res["results"])


def test_wikipedia_art_comes_from_the_works_own_article_not_a_disambiguation_page(net):
    fake = show_net(wikipedia={"Gleebworth (American TV series)": {"source": "https://upload.wikimedia.org/wikipedia/en/2/2b/Card.png",
                                                                 "width": 1200, "height": 700}})
    fake.wikidata["Q3"]["sitelinks"]["enwiki"] = {"title": "Gleebworth (American TV series)"}
    net(fake)
    res = assets.search("Gleebworth TV show", 8, copyrighted=True)
    art = [r for r in res["results"] if r["provider"] == "wikipedia"]
    assert len(art) == 1 and art[0]["kind"] == "artwork" and art[0]["title"] == "Gleebworth (Wikipedia lead image)"
    assert any("titles=Gleebworth+%28American+TV+series%29" in u for u in fake.urls)


def test_tvmaze_namesake_is_not_taken(net):
    other = {"id": 6, "name": "Gleebworth Junior", "image": {"original": "https://static.tvmaze.com/x.jpg"}}
    net(show_net(tvmaze={"Gleebworth": other}))
    res = assets.search("Gleebworth TV show", 8, copyrighted=True)
    assert not any(r["provider"] == "tvmaze" for r in res["results"])


def test_foreign_language_logo_ranks_below_the_english_one(net):
    def commons(q):
        return [cm_page(1, "Moonfall Logo fr.svg", "Public domain", mime="image/svg+xml"),
                cm_page(2, "Moonfall english logo.svg", "Public domain", mime="image/svg+xml")]
    net(FakeNet(commons=commons))
    res = assets.search("Moonfall movie", 4)
    assert res["results"][0]["title"] == "Moonfall english logo.svg"


# --- apps and websites ------------------------------------------------------------------------

def test_app_query_returns_its_website_and_a_free_screenshot_over_other_logos(net):
    wd = {"Q9": entity("Q9", "Zorblax", "language-learning app", website="https://zorblax.example")}

    def commons(q):
        if "screenshot" in q:
            return [cm_page(4, "Zorblax app screenshot (2024).png", "Public domain", mime="image/png", w=1170, h=2532)]
        return [cm_page(5, "Zorblax logo 2019.svg", "Public domain", mime="image/svg+xml")]
    fake = net(FakeNet(commons=commons, wikidata=wd))
    res = assets.search("Zorblax app", 6)
    assert res["website"]["url"] == "https://zorblax.example"
    kinds = [(r["provider"], r["kind"]) for r in res["results"]]
    assert kinds[0] == ("simpleicons", "logo")                  # the exact brand mark stays first
    assert kinds[1] == ("wikimedia", "screenshot")              # then the real screen, before other logos
    assert any("screenshot" in u for u in fake.urls)


def test_register_capture_labels_a_screenshot_and_never_calls_it_free(tmp_path):
    f = tmp_path / "zorblax-com.png"
    f.write_bytes(b"png")
    c = assets.register_capture(f, "https://www.zorblax.example/app", None)
    assert c["licenseKind"] == "screenshot" and c["attribution"] == "Screenshot of zorblax.example"
    assert c["copyrighted"] and not c["attributionRequired"] and "your responsibility" in c["note"]
    book = json.loads((tmp_path / "credits.json").read_text(encoding="utf-8"))
    assert book["zorblax-com.png"]["url"] == "https://www.zorblax.example/app"
    with pytest.raises(EngineError):
        assets.register_capture(f, "file:///etc/passwd")


def test_cli_register_capture_stays_inside_work_assets(tmp_path):
    proj = tmp_path / "p"
    (proj / "work" / "assets").mkdir(parents=True)
    from PIL import Image
    Image.new("RGB", (40, 80), "white").save(proj / "work" / "assets" / "site.png")
    p = cli.build_parser()
    r = cli.cmd_register_capture(p.parse_args(["register-capture", "--project", str(proj),
                                               "--asset", "work/assets/site.png", "--url", "https://zorblax.example"]))
    assert r["asset"] == "work/assets/site.png" and r["credit"]["kind"] == "screenshot" and r.get("thumb")
    for bad in ("work/assets/../project.json", "media/take.mp4", "work/assets/sub/x.png"):
        with pytest.raises((EngineError, CliError)):
            cli.cmd_register_capture(p.parse_args(["register-capture", "--project", str(proj),
                                                   "--asset", bad, "--url", "https://zorblax.example"]))
