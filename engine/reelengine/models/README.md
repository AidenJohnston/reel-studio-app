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
