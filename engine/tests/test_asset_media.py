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


# WebM and MKV streams carry no duration of their own, so the container's (the 2 s audio) is all ffprobe reports
@pytest.mark.parametrize('ext,codecs', [('mp4', ['-c:v', 'libx264', '-c:a', 'aac']),
                                        ('webm', ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'])])
def test_fails_if_longer_audio_sends_contact_sheet_seeks_past_the_video(tmp_path, ext, codecs):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=96x54:r=30:d=0.2', '-f', 'lavfi', '-i',
           'sine=frequency=1000:duration=2', *codecs, folder / f'short-video.{ext}')
    result = inspect(project, root, 'inspect-video', f'Library/B-roll/short-video.{ext}')
    assert result['durationSec'] == pytest.approx(0.2, abs=0.01)
    with Image.open(project / result['previewPath']) as sheet:
        # the last cell is the clip's last frame, not black
        assert sheet.convert('RGB').getpixel((2 * 320 + 160, 2 * 180 + 90))[0] > 200


def test_fails_if_a_contact_sheet_seek_that_writes_nothing_is_not_retried_earlier(tmp_path, monkeypatch):
    from reelengine import asset_preview
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=96x54:r=30:d=2', '-c:v', 'libx264', folder / 'clip.mp4')
    real_run = asset_preview.run
    seeks = []

    def run(cmd, *args, **kw):
        out = real_run(cmd, *args, **kw)
        if '-ss' in cmd:
            at = float(cmd[cmd.index('-ss') + 1])
            seeks.append(at)
            if at > limit:      # as if the video ended here
                out.stdout = b''
        return out
    monkeypatch.setattr(asset_preview, 'run', run)
    limit = 1.0
    inspect(project, root, 'inspect-video', 'Library/B-roll/clip.mp4')
    assert max(seeks) > limit and len(seeks) > 9
    limit = -1.0
    with pytest.raises(EngineError) as e:
        inspect(project, root, 'inspect-video', 'Library/B-roll/clip.mp4')
    assert e.value.code == 'BAD_MEDIA'


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


def freeze(project, root, ref, kind, *extra):
    args = cli.build_parser().parse_args(['freeze-asset', '--project', str(project), '--root', str(root), '--asset', str(ref), '--kind', kind, *extra])
    return args.fn(args)


def test_fails_if_a_clip_over_40_mb_cannot_be_inspected_or_frozen(tmp_path):
    import hashlib
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    (project / 'work').mkdir(parents=True)
    # 32 uncompressed 1280x720 frames: about 44 MB, a real clip the app accepts as an attachment (up to 200 MB)
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=16:d=2', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', folder / 'big.avi')
    clip = folder / 'big.avi'
    assert clip.stat().st_size > 40 * 1024 * 1024
    inspected = inspect(project, root, 'inspect-video', 'Library/B-roll/big.avi')
    sha = hashlib.sha256(clip.read_bytes()).hexdigest()
    assert inspected['sha256'] == sha
    frozen = freeze(project, root, 'Library/B-roll/big.avi', 'video', '--expect-sha256', sha)
    assert frozen['committedPath'] == f'work/assets/frozen/video/{sha}.avi'
    assert (project / frozen['committedPath']).read_bytes() == clip.read_bytes()
    assert not list((project / 'work' / 'assets' / 'frozen').rglob('*.tmp'))


def test_fails_if_a_clip_over_the_attachment_limit_is_frozen(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    (project / 'work').mkdir(parents=True)
    huge = folder / 'huge.mp4'
    with open(huge, 'wb') as f:  # sparse: 201 MB on paper, a few bytes on disk
        f.write(b'\x00\x00\x00\x18ftypisom')
        f.truncate(201 * 1024 * 1024)
    with pytest.raises(EngineError) as error:
        freeze(project, root, 'Library/B-roll/huge.mp4', 'video')
    assert error.value.code == 'TOO_LARGE'
    assert not list((project / 'work').rglob('*.mp4'))


def test_fails_if_freeze_stores_the_same_bytes_twice_keeps_changed_bytes_or_reads_outside(tmp_path, monkeypatch):
    monkeypatch.delenv('REELENGINE_EXTRA_READ_DIRS', raising=False)
    project, root = tmp_path / 'project', tmp_path / 'root'
    (root / 'Library' / 'Images').mkdir(parents=True)
    (project / 'work').mkdir(parents=True)
    Image.new('RGB', (8, 8), 'red').save(root / 'Library' / 'Images' / 'a.png')
    first = freeze(project, root, 'Library/Images/a.png', 'image')
    again = freeze(project, root, 'Library/Images/a.png', 'logo')
    assert again['committedPath'] == first['committedPath'] and first['mime'] == 'image/png'
    hashed = cli.build_parser().parse_args(['hash-asset', '--project', str(project), '--asset', first['committedPath']])
    assert hashed.fn(hashed)['sha256'] == first['sha256']
    with pytest.raises(EngineError) as error:
        freeze(project, root, 'Library/Images/a.png', 'image', '--expect-sha256', '0' * 64)
    assert error.value.code == 'ASSET_CHANGED'
    (root / 'Library' / 'Images' / 'fake.png').write_bytes(b'not a picture')
    with pytest.raises(EngineError) as error:
        freeze(project, root, 'Library/Images/fake.png', 'image')
    assert error.value.code == 'BAD_MEDIA'
    outside = tmp_path / 'private.png'
    Image.new('RGB', (8, 8), 'blue').save(outside)
    with pytest.raises(EngineError) as error:
        freeze(project, root, outside, 'image')
    assert error.value.code == 'UNSAFE_PATH'
    frozen = project / 'work' / 'assets' / 'frozen'
    assert sorted(p.relative_to(frozen).as_posix() for p in frozen.rglob('*')) == ['image', f"image/{first['sha256']}.png"]


def test_fails_if_freeze_takes_a_file_of_another_kind_a_long_song_is_refused_or_a_symlinked_folder_is_followed(tmp_path):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    (root / 'Library' / 'Music').mkdir(parents=True)
    (project / 'work' / 'assets').mkdir(parents=True)
    Image.new('RGB', (8, 8), 'red').save(folder / 'still.webp')
    (folder / 'still.webp').rename(folder / 'still.mp4')       # a RIFF picture named like a clip
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', folder / 'tone.wav')
    for ref, kind in [('Library/B-roll/still.mp4', 'video'), ('Library/B-roll/tone.wav', 'video'), ('Library/B-roll/still.mp4', 'music')]:
        with pytest.raises(EngineError) as error:
            freeze(project, root, ref, kind)
        assert error.value.code == 'BAD_MEDIA', ref
    # about 42 MB: a four-minute stereo WAV, which a Library song often is
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=240', '-ac', '2', root / 'Library' / 'Music' / 'long.wav')
    song = freeze(project, root, 'Library/Music/long.wav', 'music')
    assert song['committedPath'].startswith('work/assets/frozen/music/')
    elsewhere = project / 'work' / 'elsewhere'
    elsewhere.mkdir()
    (project / 'work' / 'assets' / 'frozen' / 'video').symlink_to(elsewhere, target_is_directory=True)
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=96x54:r=30', '-frames:v', '1', folder / 'one.mp4')
    with pytest.raises(EngineError) as error:
        freeze(project, root, 'Library/B-roll/one.mp4', 'video')
    assert error.value.code == 'UNSAFE_PATH'
    assert list(elsewhere.iterdir()) == []


def test_fails_if_freeze_follows_a_symlinked_work_assets_or_calls_a_missing_ffprobe_a_bad_file(tmp_path, monkeypatch):
    project, root = tmp_path / 'project', tmp_path / 'root'
    folder = root / 'Library' / 'B-roll'
    folder.mkdir(parents=True)
    ffmpeg('-f', 'lavfi', '-i', 'color=red:s=96x54:r=30', '-frames:v', '1', folder / 'one.mp4')
    (project / 'work' / 'elsewhere').mkdir(parents=True)
    (project / 'work' / 'assets').symlink_to(project / 'work' / 'elsewhere', target_is_directory=True)
    with pytest.raises(EngineError) as error:
        freeze(project, root, 'Library/B-roll/one.mp4', 'video')
    assert error.value.code == 'UNSAFE_PATH'
    assert list((project / 'work' / 'elsewhere').iterdir()) == []
    (project / 'work' / 'assets').unlink()
    monkeypatch.setenv('REELENGINE_FFPROBE', str(tmp_path / 'no-ffprobe'))
    with pytest.raises(EngineError) as error:
        freeze(project, root, 'Library/B-roll/one.mp4', 'video')
    assert error.value.code == 'NO_FFMPEG'
