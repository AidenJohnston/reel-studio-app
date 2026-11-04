import subprocess

import pytest

from reelengine import init, probe, project, tools


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "phone.mp4"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i",
                    "testsrc2=size=160x284:rate=60000/1001:duration=2",
                    "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264",
                    "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def test_fails_if_stable_source_rate_is_not_preserved(tmp_path, source):
    directory = tmp_path / "reel"
    init.run(directory, "Phone reel", [source])
    assert project.load(directory)["format"]["fps"] == pytest.approx(60000 / 1001)


def test_fails_if_constant_5994_on_coarse_timebase_becomes_30(tmp_path, source):
    coarse = tmp_path / "coarse.mp4"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(source), "-c", "copy",
                    "-video_track_timescale", "600", str(coarse)], check=True)
    directory = tmp_path / "reel"
    init.run(directory, "Phone reel", [coarse])
    assert project.load(directory)["format"]["fps"] == pytest.approx(60000 / 1001)


def test_fails_if_stable_50fps_source_becomes_30(tmp_path, source):
    fast = tmp_path / "50fps.mp4"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(source), "-vf", "fps=50",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", str(fast)], check=True)
    directory = tmp_path / "reel"
    init.run(directory, "Phone reel", [fast])
    assert project.load(directory)["format"]["fps"] == 50


def test_fails_if_vfr_source_is_not_normalized(tmp_path, source):
    vfr = tmp_path / "variable.mp4"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(source), "-vf",
                    "select='if(lt(t,1),1,not(mod(n,2)))'", "-fps_mode", "vfr",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", str(vfr)], check=True)
    directory = tmp_path / "reel"
    init.run(directory, "Variable phone reel", [vfr])
    saved = project.load(directory)
    video = directory / saved["sources"][0]["path"]
    frames = subprocess.run([tools.ffprobe(), "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0",
                             str(video)], capture_output=True, text=True, check=True).stdout
    times = [float(line.strip().strip(",")) for line in frames.splitlines() if line.strip().strip(",")]
    assert all(abs(b - a - 1 / 30) < 0.00001 for a, b in zip(times, times[1:]))
    assert saved["format"]["fps"] == 30
    assert probe.probe(video, quick=True)["fps"] == 30


def test_fails_if_vfr_starts_after_the_first_sample_window(tmp_path):
    first = tmp_path / "first.mp4"
    second = tmp_path / "second.mp4"
    joined = tmp_path / "late-vfr.mp4"
    for path, rate, duration in ((first, "60", "6"), (second, "30", "4")):
        subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i",
                        f"testsrc2=size=160x284:rate={rate}:duration={duration}", "-f", "lavfi",
                        "-i", f"sine=duration={duration}", "-c:v", "libx264", "-preset", "ultrafast",
                        "-c:a", "aac", "-shortest", str(path)], check=True)
    subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(first), "-i", str(second),
                    "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
                    "-map", "[v]", "-map", "[a]", "-fps_mode", "vfr", "-c:v", "libx264",
                    "-preset", "ultrafast", "-c:a", "aac", str(joined)], check=True)
    directory = tmp_path / "reel"
    init.run(directory, "Late variable reel", [joined])
    assert project.load(directory)["format"]["fps"] == 30


def test_fails_if_exact_595_cfr_is_snapped_to_5994(tmp_path):
    source = tmp_path / "exact-595.mp4"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i",
                    "testsrc2=size=160x284:rate=59.5:duration=2", "-f", "lavfi", "-i",
                    "sine=duration=2", "-c:v", "libx264", "-preset", "ultrafast",
                    "-c:a", "aac", "-shortest", str(source)], check=True)
    directory = tmp_path / "reel"
    init.run(directory, "Exact rate reel", [source])
    assert project.load(directory)["format"]["fps"] == pytest.approx(59.5)


def test_fails_if_mixed_sources_are_not_normalized(tmp_path, source):
    slow = tmp_path / "slow.mp4"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(source), "-vf", "fps=30",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", str(slow)], check=True)
    directory = tmp_path / "reel"
    init.run(directory, "Mixed reel", [source, slow])
    saved = project.load(directory)
    assert saved["format"]["fps"] == 30
    assert [probe.probe(directory / s["path"], quick=True)["fps"] for s in saved["sources"]] == [30, 30]
