"""Search never offers a picture whose provenance is criminal evidence or sexual content, however neutral
its title (Commons hosts evidence photos as public domain under titles like "Neatly made bed in a minimalist
bedroom"). Both directions: the flagged file goes, an ordinary file with the same subject stays."""
import json

from reelengine import assets


def _page(title, desc="", cats="", credit="", artist="Someone"):
    return {"title": f"File:{title}", "index": 1, "imageinfo": [{
        "url": "https://upload.wikimedia.org/x.jpg", "mime": "image/jpeg", "size": 1000, "width": 1600, "height": 1200,
        "descriptionurl": "https://commons.wikimedia.org/wiki/File:x.jpg",
        "extmetadata": {"LicenseShortName": {"value": "Public domain"}, "License": {"value": "pd"},
                        "LicenseUrl": {"value": ""}, "ImageDescription": {"value": desc},
                        "Categories": {"value": cats}, "Credit": {"value": credit}, "Artist": {"value": artist}}}]}


def _titles(monkeypatch, *pages):
    reply = json.dumps({"query": {"pages": list(pages)}}).encode()
    monkeypatch.setattr(assets, "_get", lambda *a, **k: (reply, None))
    return [r["title"] for r in assets._commons("bed", 8)]


def test_evidence_photo_is_dropped_and_an_ordinary_bedroom_stays(monkeypatch):
    ordinary = _page("Bedroom with white linens.jpg", "A tidy hotel bedroom", "Bedrooms in the United States")
    assert _titles(monkeypatch, ordinary) == ["Bedroom with white linens.jpg"]   # the licence gate lets it through
    flagged = [
        _page("EFTA00001765 - Neatly made bed in a minimalist bedroom.jpg"),       # the title alone is enough
        _page("Neatly made bed.jpg", "Part of Epstein Files released by the DOJ"),
        _page("Made bed.jpg", cats="2019 FBI raid on a private island|Bedrooms in the United States"),
        _page("Made bed.jpg", credit="https://www.justice.gov/epstein/doj-disclosures"),
        _page("Made bed.jpg", cats="Media by the Federal Bureau of Investigation"),
        _page("Beach.jpg", cats="Nude beaches"),
    ]
    for p in flagged:
        assert _titles(monkeypatch, p) == [], p["title"]
    assert _titles(monkeypatch, flagged[0], ordinary) == ["Bedroom with white linens.jpg"]


def test_ordinary_words_near_the_list_are_not_caught(monkeypatch):
    for title, desc in [("Evidence-based medicine poster.jpg", "A conference poster"),
                        ("Executive office.jpg", "An office"), ("Sexton beetle.jpg", "A beetle"),
                        ("EFTA countries.png", "Map of the European Free Trade Association")]:
        assert _titles(monkeypatch, _page(title, desc)) == [title], title
