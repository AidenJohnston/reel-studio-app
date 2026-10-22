import random
import subprocess

import pytest
from PIL import Image
from reelengine import cli
from reelengine.proto import EngineError


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-y', *map(str, args)], check=True, capture_output=True)


def inspect(project, root, command, ref):
    args = cli.build_parser().parse_args([command, '--project', str(project), '--root', str(root), '--asset', str(ref)])
    return args.fn(args)


def test_fails_if_video_contact_sheet_omits_or_repeats_the_early_middle_or_late_frames(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    for i in range(9):
        Image.new('RGB', (96, 54), (20 + i * 25, 0, 0)).save(folder / f'{i}.png')
    ffmpeg('-framerate', '1', '-i', folder / '%d.png', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', folder / 'clip.mp4')
    result = inspect(project, root, 'inspect-video', 'Library/B-roll/clip.mp4')
    assert result['durationSec'] == pytest.approx(9)
    assert (result['width'], result['height']) == (96, 54)
    with Image.open(project / result['previewPath']) as sheet:
        assert sheet.size == (960, 540)
        reds = [sheet.convert('RGB').getpixel((x * 320 + 160, y * 180 + 90))[0] for y in range(3) for x in range(3)]
        assert reds == pytest.approx([20 + i * 25 for i in range(9)], abs=8)


def test_fails_if_audio_preview_loses_duration_loudness_or_waveform(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'SFX'
    folder.mkdir(parents=True)
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', folder / 'tone.wav')
    result = inspect(project, root, 'inspect-audio', 'Library/SFX/tone.wav')
    assert result['durationSec'] == pytest.approx(2)
    assert result['loudnessLufs'] == pytest.approx(-21.1, abs=1)
    with Image.open(project / result['previewPath']) as waveform:
        assert waveform.size == (800, 200)
        assert len(waveform.convert('RGB').getcolors(800 * 200)) > 1


@pytest.mark.parametrize('command', ['inspect-video', 'inspect-audio'])
def test_fails_if_preview_reads_outside_project_or_library(tmp_path, monkeypatch, command):
    monkeypatch.delenv('REELENGINE_EXTRA_READ_DIRS', raising=False)
    project, root = tmp_path / 'project', tmp_path / 'root'
    (project / 'work').mkdir(parents=True)
    outside = tmp_path / 'private.wav'
    outside.write_bytes(b'private')
    (project / 'work' / 'escape.wav').symlink_to(outside)
    for ref in [outside, 'work/../../private.wav', 'work/escape.wav']:
        with pytest.raises(EngineError) as error:
            inspect(project, root, command, ref)
        assert error.value.code == 'UNSAFE_PATH'
    assert not list((project / 'work').rglob('*.png'))


def test_fails_if_a_one_frame_video_cannot_produce_a_complete_contact_sheet(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=96x54:r=30', '-frames:v', '1', folder / 'short.mp4')
    result = inspect(project, root, 'inspect-video', 'Library/B-roll/short.mp4')
    with Image.open(project / result['previewPath']) as sheet:
        for y in range(3):
            for x in range(3):
                assert sheet.convert('RGB').getpixel((x * 320 + 160, y * 180 + 90))[0] > 240


def test_fails_if_longer_audio_sends_contact_sheet_seeks_past_the_video(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=96x54:r=30:d=0.2', '-f', 'lavfi', '-i',
           'sine=frequency=1000:duration=2', '-c:v', 'libx264', '-c:a', 'aac', folder / 'short-video.mp4')
    result = inspect(project, root, 'inspect-video', 'Library/B-roll/short-video.mp4')
    assert result['durationSec'] == pytest.approx(0.2)
    assert (project / result['previewPath']).is_file()


def test_fails_if_a_noisy_contact_sheet_exceeds_the_model_preview_limit(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    noise = random.Random(42)
    for i in range(9):
        Image.frombytes('RGB', (320, 180), noise.randbytes(320 * 180 * 3)).save(folder / f'{i}.png')
    ffmpeg('-framerate', '9', '-i', folder / '%d.png', '-c:v', 'ffv1', folder / 'noise.mkv')
    result = inspect(project, root, 'inspect-video', 'Library/B-roll/noise.mkv')
    assert (project / result['previewPath']).stat().st_size <= 1024 * 1024
