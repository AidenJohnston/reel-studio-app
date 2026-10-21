"""check_layout.py against a .DS_Store that Finder wrote for a real build (make-dmg.sh on Reel Studio 0.1.2).

    python3 -m unittest discover -s packaging/dmg
"""
import shutil
import struct
import tempfile
import unittest
from pathlib import Path

import check_layout

FIXTURE = Path(__file__).with_name("test-fixture.DS_Store")
TIFF = b"MM\x00*" + b"\x00" * 16


def iloc(x: int, y: int) -> bytes:
    return struct.pack(">II", x, y) + b"\xff" * 6 + b"\x00\x00"


class CheckLayout(unittest.TestCase):
    def setUp(self):
        self.vol = Path(tempfile.mkdtemp(prefix="rs-layout-"))
        self.addCleanup(shutil.rmtree, self.vol)
        (self.vol / "Reel Studio.app").mkdir()
        (self.vol / "Applications").symlink_to("/Applications")
        (self.vol / ".background").mkdir()
        (self.vol / ".background" / "background.tiff").write_bytes(TIFF)
        self.ds = FIXTURE.read_bytes()

    def check(self) -> list:
        (self.vol / ".DS_Store").write_bytes(self.ds)
        return check_layout.check_volume(self.vol)

    def test_reads_every_record_finder_wrote(self):
        rec = check_layout.read_records(self.ds)
        self.assertEqual(rec[("Reel Studio.app", "Iloc")], iloc(166, 214))
        self.assertEqual(rec[("Applications", "Iloc")], iloc(474, 214))
        self.assertIn((".", "icvp"), rec)
        self.assertIn((".", "bwsp"), rec)

    def test_the_designed_window_passes(self):
        self.assertEqual(self.check(), [])

    def test_a_moved_icon_fails(self):
        self.ds = self.ds.replace(iloc(166, 214), iloc(166, 254))
        self.assertEqual(self.check(), ["Reel Studio.app is at (166, 254), expected (166, 214)"])

    def test_a_missing_background_file_fails(self):
        (self.vol / ".background" / "background.tiff").unlink()
        self.assertEqual(self.check(), [".background/background.tiff is missing or not a TIFF"])

    def test_a_background_picture_pointing_elsewhere_fails(self):
        self.ds = self.ds.replace(b"background.tiff", b"elsewhere1.tiff")
        self.assertEqual(self.check(), ["background picture does not point at .background/background.tiff"])

    def test_no_ds_store_fails(self):
        self.assertEqual(len(check_layout.check_volume(self.vol)), 1)
        self.assertIn("missing", check_layout.check_volume(self.vol)[0])

    def test_not_a_ds_store_is_a_loud_error(self):
        with self.assertRaises(check_layout.LayoutError):
            check_layout.read_records(b"not a ds store")


if __name__ == "__main__":
    unittest.main()
