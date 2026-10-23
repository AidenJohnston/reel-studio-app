"""freeze-asset and hash-asset. The AI package never reads media (CONTRIBUTING), so the engine hashes
and copies the bytes of every picture, clip or song the AI freezes into work/assets/frozen/."""
from __future__ import annotations

import hashlib
import os
import shutil
import sys
import uuid
from pathlib import Path

from .proto import EngineError
from .safepath import safe_resolve

MB = 1024 * 1024
STILL_KINDS = ('image', 'logo', 'icon', 'website_screenshot')
# Video matches the app's attachment limit (app/src/shared/attachments.ts CLIP_MAX_BYTES), so a clip
# the app accepts can always be frozen. Songs get the same limit: a Library song is frozen when it is
# chosen, main had no size limit for it, and a five-minute WAV is about 50 MB. The engine streams and
# clones, so the size costs no memory. Pictures keep the resolver's 40 MB.
LIMITS = {**{k: 40 * MB for k in STILL_KINDS}, 'video': 200 * MB, 'music': 200 * MB}
# Refuse playlist demuxers, including a playlist disguised with a media extension.
INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi,wav,mp3,flac,ogg,aac']
IMAGE_FORMATS = {'PNG': ('png', 'image/png'), 'JPEG': ('jpg', 'image/jpeg'), 'GIF': ('gif', 'image/gif'), 'WEBP': ('webp', 'image/webp')}
VIDEO_MIME = {'mp4': 'video/mp4', 'mov': 'video/quicktime', 'm4v': 'video/mp4', 'webm': 'video/webm',
              'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo'}
AUDIO_MIME = {'wav': 'audio/wav', 'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'aac': 'audio/aac', 'flac': 'audio/flac',
              'ogg': 'audio/ogg', 'opus': 'audio/ogg'}


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(MB), b''):
            h.update(chunk)
    return h.hexdigest()


def _container(head: bytes) -> bool:
    return (head[4:8] in (b'ftyp', b'wide', b'free', b'mdat', b'moov', b'skip', b'pnot') or head.startswith((b'RIFF', b'OggS', b'fLaC', b'ID3'))
            or head.startswith(b'\x1a\x45\xdf\xa3') or (len(head) > 1 and head[0] == 0xff and head[1] & 0xe0 == 0xe0))


def kind_of(path: Path, kind: str) -> tuple[str, str]:
    """(extension, mime) of a file that really is `kind`, else BAD_MEDIA."""
    if kind not in LIMITS:
        raise EngineError('BAD_ARGS', f'unknown asset kind {kind}', 'That kind of asset is not supported.')
    size = path.stat().st_size
    if size > LIMITS[kind]:
        raise EngineError('TOO_LARGE', f'{path.name} is {size} bytes', f'Choose a file no larger than {LIMITS[kind] // MB} MB.')
    if kind in STILL_KINDS:
        from PIL import Image
        try:
            with Image.open(path) as im:
                fmt = im.format
        except Exception:  # noqa: BLE001 -- any decode failure means "not a picture we take"
            fmt = None
        if fmt not in IMAGE_FORMATS:
            raise EngineError('BAD_MEDIA', f'{path.name}: {fmt}', 'That file is not an image. Choose a PNG, JPEG, GIF or WebP.')
        return IMAGE_FORMATS[fmt]
    ext = path.suffix.lower().lstrip('.')
    table = VIDEO_MIME if kind == 'video' else AUDIO_MIME
    with open(path, 'rb') as f:
        head = f.read(16)
    if ext not in table or not _container(head) or not _has_stream(path, 'video' if kind == 'video' else 'audio'):
        raise EngineError('BAD_MEDIA', f'{path.name} is not {kind}', 'That file is not the requested media kind.')
    return ext, table[ext]


def _has_stream(path: Path, codec_type: str) -> bool:
    """ffprobe finds a real stream of this type (a cover picture in a song is not a video)."""
    import json
    import subprocess
    from .compose_util import ffprobe_bin
    try:
        out = subprocess.run([ffprobe_bin(), '-v', 'error', *INPUT_OPTIONS, '-show_streams', '-of', 'json', str(path)],
                             capture_output=True, text=True, timeout=60, check=True, stdin=subprocess.DEVNULL).stdout
        streams = json.loads(out).get('streams', [])
    except (OSError, subprocess.SubprocessError, ValueError):
        return False
    return any(s.get('codec_type') == codec_type and not s.get('disposition', {}).get('attached_pic') for s in streams)


def _clone_or_copy(src: Path, dst: Path) -> None:
    """A copy-on-write clone where the filesystem has one (APFS clonefile, Linux FICLONE), so a frozen
    copy costs no extra disk; a plain copy elsewhere."""
    if sys.platform == 'darwin':
        import ctypes
        libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        if libc.clonefile(os.fsencode(src), os.fsencode(dst), 0) == 0:
            return
    elif sys.platform.startswith('linux'):
        import fcntl
        try:
            with open(src, 'rb') as s, open(dst, 'wb') as d:
                fcntl.ioctl(d.fileno(), 0x40049409, s.fileno())  # FICLONE
            return
        except OSError:
            dst.unlink(missing_ok=True)
    shutil.copyfile(src, dst)


def _frozen_with(frozen: Path, sha: str) -> Path | None:
    """An intact frozen file with these bytes under any kind folder (real folders only, never a symlink)."""
    if not frozen.is_dir() or frozen.is_symlink():
        return None
    for folder in frozen.iterdir():
        if not folder.is_dir() or folder.is_symlink():
            continue
        for f in folder.glob(f'{sha}.*'):
            if f.is_file() and not f.is_symlink() and sha256_of(f) == sha:
                return f
    return None


def freeze(project: Path, root: Path | None, asset: str, kind: str, expect: str | None = None) -> dict:
    """Copy `asset` to work/assets/frozen/<kind>/<sha256>.<ext>, or reuse a frozen file with the same bytes."""
    src = safe_resolve(project, asset, root=root, what='media')
    if not src.is_file():
        raise EngineError('NOT_FOUND', f'{asset} is not a file', 'That file is missing. Choose it again.')
    ext, mime = kind_of(src, kind)
    # committedPath must be work/assets/frozen/<kind>/...: a symlinked folder would resolve somewhere else
    for folder in (project / 'work' / 'assets' / 'frozen', project / 'work' / 'assets' / 'frozen' / kind):
        if folder.is_symlink():
            raise EngineError('UNSAFE_PATH', f'{folder} is a symlink', 'The project folder looks changed. Open it again.')
    frozen = safe_resolve(project, 'work/assets/frozen', write=True, what='frozen asset')
    frozen.mkdir(parents=True, exist_ok=True)
    tmp = frozen / f'.{uuid.uuid4().hex}.tmp'
    try:
        _clone_or_copy(src, tmp)
        # hash the copy, not the source: the bytes frozen are exactly the bytes hashed
        sha = sha256_of(tmp)
        if tmp.stat().st_size > LIMITS[kind]:
            raise EngineError('TOO_LARGE', f'{asset} grew while copying', f'Choose a file no larger than {LIMITS[kind] // MB} MB.')
        if expect and sha != expect:
            raise EngineError('ASSET_CHANGED', f'{asset}: {sha} != {expect}', 'The asset changed after its preview. Resolve it again.')
        dest = _frozen_with(frozen, sha)
        if dest is None:
            dest = safe_resolve(project, f'work/assets/frozen/{kind}/{sha}.{ext}', write=True, what='frozen asset')
            dest.parent.mkdir(exist_ok=True)
            try:
                os.replace(tmp, dest)
            except PermissionError:
                # Windows refuses to replace a file another reader holds open: keep it if it has these bytes
                if not (dest.is_file() and sha256_of(dest) == sha):
                    raise
    finally:
        tmp.unlink(missing_ok=True)
    return {'committedPath': dest.relative_to(project.resolve()).as_posix(), 'sha256': sha, 'mime': mime,
            'size': dest.stat().st_size}


def hash_file(project: Path, root: Path | None, asset: str) -> dict:
    path = safe_resolve(project, asset, root=root, what='media')
    if not path.is_file():
        raise EngineError('NOT_FOUND', f'{asset} is not a file', 'That file is missing. Choose it again.')
    return {'sha256': sha256_of(path), 'size': path.stat().st_size}
