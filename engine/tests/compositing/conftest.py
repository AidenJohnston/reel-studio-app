import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))       # engine/
sys.path.insert(0, str(Path(__file__).resolve().parent))           # fixtures


def pytest_configure(config):
    config.addinivalue_line("markers", "real: reads real takes/music in place; skips if absent")
