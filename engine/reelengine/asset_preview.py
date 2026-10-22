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
from .safepath import safe_resolve

# Keep the image resolver's 40 MB ceiling for every candidate kind.
MAX_BYTES = 40 * 1024 * 1024
# Refuse playlist demuxers, including a playlist disguised with a media extension.
INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,wav,mp3,flac,ogg,aac']


def inspect(project: Path, root: Path | None, asset: str, video: bool, preview_ref: str | None = None) -> dict:
    from PIL import Image, ImageDraw
    source = safe_resolve(project, asset, root=root, what='media')
    if not source.is_file() or source.stat().st_size > MAX_BYTES:
        raise EngineError('BAD_MEDIA', 'preview requires a file under 40 MB', 'Choose a media file no larger than 40 MB.')
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
    extension = 'jpg' if video else 'png'
    if preview_ref is not None and not re.fullmatch(rf'work/thumbs/candidate-[0-9a-f-]+\.{extension}', preview_ref):
        raise EngineError('UNSAFE_PATH', 'invalid candidate preview path', 'The preview path is invalid. Resolve the asset again.')
    preview = safe_resolve(project, preview_ref or f'work/thumbs/candidate-{uuid.uuid4().hex}.{extension}', write=True, what='preview')
    preview.parent.mkdir(parents=True, exist_ok=True)
    result = {'previewPath': str(preview.relative_to(project.resolve())), 'durationSec': duration}
    base = [ffmpeg_bin(), '-nostdin', '-v', 'error', '-threads', '1', *INPUT_OPTIONS]
    try:
        if video:
            sheet = Image.new('RGB', (960, 540))
            draw = ImageDraw.Draw(sheet)
            rate = stream.get('avg_frame_rate', '0/1').split('/')
            fps = float(rate[0]) / max(float(rate[-1]), 1)
            last = max(0, duration - (1 / fps if fps > 0 else 0.1))
            for i in range(9):
                at = last * i / 8
                frame = run([*base, '-ss', str(at), '-i', str(source), '-map', '0:v:0', '-vf',
                             'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
                             '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', '-'],
                            timeout=60, what='contact sheet frame', binary=True)
                with Image.open(io.BytesIO(frame.stdout)) as image:
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
