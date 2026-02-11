from pathlib import Path

from typer.testing import CliRunner

from main import app


runner = CliRunner()


def test_patch_logic_command_updates_target_file(tmp_path: Path) -> None:
    target = tmp_path / "sample.py"
    target.write_text("def main():\n    print('hello')\n", "utf-8")

    result = runner.invoke(
        app,
        [
            "patch-logic",
            str(target),
            "main",
            "print('updated from cli')",
        ],
    )

    assert result.exit_code == 0
    assert "print('updated from cli')" in result.stdout
    assert target.read_text("utf-8") == "def main():\n    print('updated from cli')\n"
