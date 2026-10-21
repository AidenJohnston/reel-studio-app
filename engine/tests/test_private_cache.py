import json
import os

from reelengine import assets, cli, tools


def test_cli_seeds_completed_shared_cache_json_and_keeps_updates_private(tmp_path, monkeypatch):
    shared = tmp_path / "shared"
    encoder = tmp_path / "encoder"
    private = tmp_path / "note" / "work" / "cache"
    monkeypatch.setenv("REELENGINE_CACHE_DIR", str(shared))
    monkeypatch.setenv("REELENGINE_CACHE", str(encoder))
    cached = {
        shared / "simple-icons.json": '{"icons": []}',
        shared / "wikidata.json": '{"old": {"v": "entity"}}',
        shared / "search-credits.json": '{"image": {"creator": "A"}}',
        shared / "music-analysis" / ("a" * 32 + ".json"): '{"bpm": 92}',
        encoder / "encoder-probe.json": '{"encoder": "working"}',
        shared / "yt-dlp" / "youtube-sts" / "player.json": '{"yt-dlp_version": "2026.08.19", "data": 123}',
    }
    for file, data in cached.items():
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(data)
        os.utime(file, ns=(1700000000000000000, 1700000000000000000))
    (shared / "music-analysis" / ("b" * 32 + ".json")).write_text('{"unfinished":')
    (shared / "music-analysis" / ("c" * 32 + ".8.part")).write_text('{}')
    (shared / "yt-dlp" / "youtube-sts" / "player.json.9.tmp").write_text('{}')
    private.mkdir(parents=True)
    (private / "search-credits.json").write_text('{"newer": {"creator": "B"}}')

    def command(args):
        assert assets.cache_dir() == private
        assert tools.probe_cache_file() == private / "encoder-probe.json"
        assert json.loads((private / "search-credits.json").read_text()) == {"newer": {"creator": "B"}}
        for source, data in cached.items():
            rel = source.relative_to(encoder if source.parent == encoder else shared)
            target = private / rel
            if rel.name != "search-credits.json":
                assert target.read_text() == data
                assert target.stat().st_mtime_ns == source.stat().st_mtime_ns
            target.write_text('{"private update": true}')
        assert list((private / "music-analysis").iterdir()) == [private / "music-analysis" / ("a" * 32 + ".json")]
        assert list((private / "yt-dlp" / "youtube-sts").iterdir()) == [private / "yt-dlp" / "youtube-sts" / "player.json"]
        return {}

    monkeypatch.setattr(cli, "cmd_probe", command)
    monkeypatch.setattr(cli.proto, "capture_stdout", lambda: None)
    monkeypatch.setattr(cli.proto, "done", lambda value: None)
    assert cli.main(["probe", "unused.mp4", "--cache-dir", str(private)]) == 0
    assert assets.cache_dir() == shared
    assert tools.probe_cache_file() == encoder / "encoder-probe.json"
    for source, data in cached.items():
        assert source.read_text() == data
        assert source.stat().st_mtime_ns == 1700000000000000000
