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

Size and SHA-256 of every speech model file at one Hugging Face revision, read from the Hugging Face
API for `Systran/faster-whisper-small.en` at `d1d751a5` and re-hashed from a cached copy and a fresh
download. Both the engine's download and the app's reuse of a cached copy keep only matching files.

## speech-check.wav

faster-whisper's `tests/data/jfk.flac` (11 s of the 1961 inaugural address, public domain) as 16 kHz
mono 16-bit WAV. `python -m reelengine speech-check` times the model on it.

## segment-models.json

PP-HumanSeg (`human_segmentation_pphumanseg_2023mar.onnx`), the person segmentation model of the
OpenCV Model Zoo, from OpenCV's Hugging Face copy of the zoo (`opencv/human_segmentation_pphumanseg`)
at revision `e876e636`. Size and SHA-256 are the ones that revision's index lists for the file.
Apache-2.0, Copyright (c) 2021 PaddlePaddle Authors (THIRD_PARTY.md). Not bundled:
`reelengine.segment` downloads it the first time a version has words behind the speaker and keeps
it only when both match.
