from pathlib import Path

import pytest

from codeq.main import Codeq


def test_write_file_creates_new_file_when_explicit_path(tmp_path: Path) -> None:
    destination = tmp_path / "generated.py"
    codeq = Codeq.from_source("def run():\n    return 42\n")

    written = codeq.write_file(destination)

    assert written == destination
    assert destination.read_text("utf-8") == "def run():\n    return 42\n"


def test_write_file_refuses_to_overwrite_existing_file(tmp_path: Path) -> None:
    destination = tmp_path / "existing.py"
    destination.write_text("print('old')\n", "utf-8")
    codeq = Codeq.from_source("print('new')\n")

    with pytest.raises(FileExistsError, match="Refusing to overwrite"):
        codeq.write_file(destination)

    assert destination.read_text("utf-8") == "print('old')\n"


def test_overwrite_file_replaces_existing_file(tmp_path: Path) -> None:
    destination = tmp_path / "existing.py"
    destination.write_text("print('old')\n", "utf-8")
    codeq = Codeq.from_source("print('new')\n")

    written = codeq.overwrite_file(destination)

    assert written == destination
    assert destination.read_text("utf-8") == "print('new')\n"


def test_write_file_uses_original_path_for_instances_loaded_from_file(tmp_path: Path) -> None:
    source_file = tmp_path / "module.py"
    source_file.write_text("def greet():\n    return 'hello'\n", "utf-8")

    codeq = Codeq.from_file(source_file)
    codeq.replace("func", "greet", "logic", "return 'updated'")
    codeq.overwrite_file()

    assert source_file.read_text("utf-8") == "def greet():\n    return 'updated'\n"


def test_write_file_requires_destination_when_source_has_no_backing_file() -> None:
    codeq = Codeq.from_source("x = 1\n")

    with pytest.raises(ValueError, match="No destination file is known"):
        codeq.write_file()
