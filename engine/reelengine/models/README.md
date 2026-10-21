# Vendored models

## face_detection_yunet_2023mar.onnx

YuNet face detector from the OpenCV Model Zoo
(https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet).
Licensed MIT by its authors (Shiqi Yu et al.), redistributed unmodified.
sha256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`, 232,589 bytes.

Used by `reelengine.placement` through `cv2.FaceDetectorYN` (OpenCV >= 4.8). If the file is
missing or the OpenCV build lacks `FaceDetectorYN`, placement falls back to the Haar cascade
bundled with opencv-python 4.x, and if that is missing too, to a default centred face box.

MIT License text: see https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE

## speech-models.json

The exact speech model files Reel Studio downloads, pinned to one Hugging Face revision: each
file's size and SHA-256. `transcribe.download_model` fetches `/resolve/<revision>/<file>` and keeps
a file only if both match; the app (app/src/main/models.ts) reuses a copy already in this
computer's Hugging Face cache only if every file matches. The values were read from the Hugging
Face API for `Systran/faster-whisper-small.en` at revision `d1d751a5`, and re-hashed from both a
copy in a local Hugging Face cache and a fresh download of that revision.

## speech-check.wav

11 seconds of President John F. Kennedy's inaugural address (20 January 1961, "And so, my fellow
Americans, ask not what your country can do for you..."), a work of the US federal government and
in the public domain. Same recording as faster-whisper's `tests/data/jfk.flac`, converted to
16 kHz mono 16-bit WAV with ffmpeg. sha256
`064ae533b488033184aeda697d8128791f2d934a53a11157a617e802797af4a5`, 352,078 bytes.

`python -m reelengine speech-check` transcribes it at a few thread counts to pick the fastest one
for this computer (transcribe.speech_check).
