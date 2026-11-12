"""tools.filters() reads `ffmpeg -filters` from FFmpeg 7 and FFmpeg 8, whose flag column differs."""
import subprocess

from reelengine import tools

FFMPEG7 = """Filters:
  T.. = Timeline support
  .S. = Slice threading
  ..C = Command support
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 ... abench            A->A       Benchmark part of a filtergraph.
 T.C loudnorm          A->A       EBU R128 loudness normalization
 .S. zscale            V->V       Apply resizing, colorspace and bit depth conversion.
 ... subtitles         V->V       Render text subtitles onto input video using the libass library.
"""

FFMPEG8 = """Filters:
  T.. = Timeline support
  .S. = Slice threading
  A = Audio input/output
  V = Video input/output
  N = Dynamic number and/or type of input/output
  | = Source or sink filter
 TS aap               AA->A      Apply Affine Projection algorithm to first audio stream.
 .. loudnorm          A->A       EBU R128 loudness normalization
 .S zscale            V->V       Apply resizing, colorspace and bit depth conversion.
 .. subtitles         V->V       Render text subtitles onto input video using the libass library.
"""


def _parse(monkeypatch, listing):
    monkeypatch.delitem(tools._CACHE, "filters", raising=False)
    monkeypatch.setattr(tools, "ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(tools, "text_run", lambda *a, **k: subprocess.CompletedProcess(a, 0, listing, ""))
    names = tools.filters()
    tools._CACHE.pop("filters", None)
    return names


def test_ffmpeg7_listing(monkeypatch):
    assert _parse(monkeypatch, FFMPEG7) == {"abench", "loudnorm", "zscale", "subtitles"}


def test_ffmpeg8_listing(monkeypatch):
    assert _parse(monkeypatch, FFMPEG8) == {"aap", "loudnorm", "zscale", "subtitles"}


def test_legend_lines_are_not_filters(monkeypatch):
    names = _parse(monkeypatch, FFMPEG7 + FFMPEG8)
    assert not names & {"=", "Timeline", "Slice", "Command"}
