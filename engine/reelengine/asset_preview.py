"""Local media previews for resolve_asset, using the same path boundary as inspect-image."""
from __future__ import annotations

import io
import json
import math
import re
import uuid
from pathlib import Path

from .compose_util import ffmpeg_bin, ffprobe_bin, run
from .proto import EngineError
from .asset_freeze import INPUT_OPTIONS, kind_of, sha256_of
from .safepath import safe_resolve



def _last_video_packet_at(source: Path, container_duration: float) -> float | None:
    """The latest timestamp of a video packet, read from the last 5 seconds, or the whole file when the
    video ends before them."""
    for interval in (['-read_intervals', f'{max(0.0, container_duration - 5):.3f}%'], []):
        out = run([ffprobe_bin(), '-v', 'error', *INPUT_OPTIONS, '-select_streams', 'v:0', *interval,
                   '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', str(source)], timeout=60, what='probe video end').stdout
        times = [float(t) for t in out.split() if re.fullmatch(r'-?\d+(?:\.\d+)?', t)]
        if times:
            return max(times)
    return None


def _frame_at_or_before(base: list, source: Path, at: float, frame_time: float) -> tuple[float, bytes]:
    """One contact-sheet frame as PNG bytes. A seek past the last video frame writes nothing, so an empty
    result is retried at earlier times."""
    for t in dict.fromkeys(max(0.0, at - back) for back in (0, frame_time, 0.5, 1, 2, at)):
        frame = run([*base, '-ss', str(t), '-i', str(source), '-map', '0:v:0', '-vf',
                     'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
                     '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', '-'],
                    timeout=60, what='contact sheet frame', binary=True)
        if frame.stdout:
            return t, frame.stdout
    raise EngineError('BAD_MEDIA', f'no video frame at or before {at:.3f}s', 'I could not read the pictures in this clip. Choose another file.')


def inspect(project: Path, root: Path | None, asset: str, video: bool, preview_ref: str | None = None) -> dict:
    from PIL import Image, ImageDraw
    source = safe_resolve(project, asset, root=root, what='media')
    if not source.is_file():
        raise EngineError('BAD_MEDIA', 'preview requires a file', 'That file is missing. Choose it again.')
    _ext, mime = kind_of(source, 'video' if video else 'music')
    probe = run([ffprobe_bin(), '-v', 'error', *INPUT_OPTIONS, '-show_format', '-show_streams', '-of', 'json', str(source)],
                timeout=60, what='inspect media')
    data = json.loads(probe.stdout)
    streams = [s for s in data.get('streams', []) if not s.get('disposition', {}).get('attached_pic')]
    stream = next((s for s in streams if s.get('codec_type') == ('video' if video else 'audio')), None)
    container_duration = float(data.get('format', {}).get('duration') or 0)
    duration = float((stream or {}).get('duration') or container_duration)
    if container_duration > 0:
        duration = min(duration, container_duration)
    if not stream or not math.isfinite(duration) or duration <= 0:
        raise EngineError('BAD_MEDIA', 'no finite duration or requested stream', 'This file has no usable video or audio.')
    rate = stream.get('avg_frame_rate', '0/1').split('/')
    fps = float(rate[0]) / max(float(rate[-1]), 1)
    frame_time = 1 / fps if fps > 0 else 0.1
    if video and not stream.get('duration'):
        # Matroska and WebM streams carry no duration, and the container's is its longest stream's, often
        # the audio: the video ends one frame after its last packet
        last_packet = _last_video_packet_at(source, container_duration)
        if last_packet is not None:
            duration = min(duration, last_packet + frame_time)
    extension = 'jpg' if video else 'png'
    if preview_ref is not None and not re.fullmatch(rf'work/thumbs/candidate-[0-9a-f-]+\.{extension}', preview_ref):
        raise EngineError('UNSAFE_PATH', 'invalid candidate preview path', 'The preview path is invalid. Resolve the asset again.')
    preview = safe_resolve(project, preview_ref or f'work/thumbs/candidate-{uuid.uuid4().hex}.{extension}', write=True, what='preview')
    preview.parent.mkdir(parents=True, exist_ok=True)
    result = {'previewPath': str(preview.relative_to(project.resolve())), 'durationSec': duration,
              'sha256': sha256_of(source), 'mime': mime}
    base = [ffmpeg_bin(), '-nostdin', '-v', 'error', '-threads', '1', *INPUT_OPTIONS]
    try:
        if video:
            sheet = Image.new('RGB', (960, 540))
            draw = ImageDraw.Draw(sheet)
            last = max(0, duration - frame_time)
            for i in range(9):
                at, png = _frame_at_or_before(base, source, last * i / 8, frame_time)
                with Image.open(io.BytesIO(png)) as image:
                    sheet.paste(image.convert('RGB'), ((i % 3) * 320, (i // 3) * 180))
                draw.text(((i % 3) * 320 + 5, (i // 3) * 180 + 5), f'{at:.2f}s', fill='white', stroke_width=1, stroke_fill='black')
            # A noisy RGB sheet exceeds the model's 1 MiB preview cap as PNG.
            sheet.save(preview, 'JPEG', quality=80)
            width, height = int(stream['width']), int(stream['height'])
            rotation = next((s.get('rotation', 0) for s in stream.get('side_data_list', []) if 'rotation' in s), 0)
            if abs(int(rotation)) % 180 == 90:
                width, height = height, width
            result.update(width=width, height=height)
        else:
            run([*base, '-y', '-i', str(source), '-filter_complex',
                 'aformat=channel_layouts=mono,showwavespic=s=800x200:colors=white:filter=peak',
                 '-frames:v', '1', '-threads', '1', str(preview)], timeout=120, what='audio waveform')
            measured = run([ffmpeg_bin(), '-nostdin', '-v', 'info', '-threads', '1', *INPUT_OPTIONS,
                            '-i', str(source), '-vn', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'],
                           timeout=120, what='audio loudness')
            values = re.findall(r'I:\s*(-?\d+(?:\.\d+)?) LUFS', measured.stderr)
            if not values:
                raise EngineError('BAD_MEDIA', 'no integrated LUFS', 'I could not measure this audio. Choose another file.')
            result['loudnessLufs'] = float(values[-1])
        return result
    except BaseException:
        preview.unlink(missing_ok=True)
        raise
