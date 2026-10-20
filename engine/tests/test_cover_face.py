"""Cover words go by the real face, not a talking hand the full-size detector mistook for one."""
import numpy as np

from reelengine import cover, placement


def _fake_detector(monkeypatch, full, small):
    def detect(bgr):
        d = full if bgr.shape[1] > cover.DETECT_W else small
        return None if d is None else dict(d)
    monkeypatch.setattr(placement, "detect_in_frame", detect)


def test_the_surer_detection_wins_and_is_scaled_back(monkeypatch):
    hand = {"box": [394, 1447, 410, 452], "core": [400, 1500, 300, 300], "score": 0.67}
    s = cover.DETECT_W / 1080
    face = {"box": [421 * s, 855 * s, 181 * s, 256 * s], "core": [440 * s, 900 * s, 140 * s, 180 * s], "score": 0.92}
    _fake_detector(monkeypatch, hand, face)
    d = cover._detect_face(np.zeros((1920, 1080, 3), np.uint8))
    assert d["score"] == 0.92
    assert [round(v) for v in d["box"]] == [421, 855, 181, 256]


def test_full_size_kept_when_it_is_surer_or_the_only_one(monkeypatch):
    big = {"box": [300, 500, 400, 450], "core": None, "score": 0.95}
    _fake_detector(monkeypatch, big, {"box": [1, 1, 1, 1], "core": None, "score": 0.5})
    assert cover._detect_face(np.zeros((1920, 1080, 3), np.uint8))["box"] == [300, 500, 400, 450]
    _fake_detector(monkeypatch, big, None)
    assert cover._detect_face(np.zeros((1920, 1080, 3), np.uint8))["score"] == 0.95
    _fake_detector(monkeypatch, None, None)
    assert cover._detect_face(np.zeros((1920, 1080, 3), np.uint8)) is None
