"""Platform export covers."""
import subprocess

from reelengine import export_media, tools


def test_a_cover_scrubbed_to_the_very_end_still_gets_a_frame(tmp_path):
    clip = tmp_path / "export.mp4"
    subprocess.run([tools.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=2",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(clip)], check=True)
    out = tmp_path / "cover.jpg"
    export_media.cover(clip, out, 2.0)
    assert out.read_bytes()[:2] == b"\xff\xd8"
