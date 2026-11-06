"""The leak check's path rule for agent folders: run with `python -m pytest scripts/leak-check`."""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("leak_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


@pytest.mark.parametrize("path", [
    ".claude/skills/test-audit/SKILL.md",
    ".claude/skills/test-audit/references/notes.md",
])
def test_shared_skills_at_the_root_may_be_committed(path):
    assert not check.never_commit(path)


@pytest.mark.parametrize("path", [
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/projects/session.jsonl",
    ".claude/skills",                                  # a link to elsewhere, not the folder
    ".claude/skillset/SKILL.md",
    "app/.claude/skills/x/SKILL.md",                   # only the root folder is shared
    ".claude/skills/x/.claude/settings.json",
])
def test_other_agent_files_never_are(path):
    assert check.never_commit(path)


@pytest.mark.parametrize("path,shipped", [
    ("app/src/renderer/src/assets/sample/raw.mp4", True),
    ("app/src/renderer/src/assets/sample/cut.mp3", True),
    ("app/src/renderer/src/assets/sample/my-take.mp4", False),      # only the credited sample files
    ("app/src/renderer/src/assets/raw.mp4", False),
])
def test_only_the_credited_sample_media_may_be_committed(path, shipped):
    assert check.never_commit(path) is not shipped


def test_the_trust_list_is_read_as_text_and_only_its_maintainer_line_is_allowed():
    assert check.is_text(".github/VOUCHED.td", b"github:someone\n")
    assert "github:" + check.ALLOW[0].split("/")[0] in check.ALLOW
