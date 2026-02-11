from pathlib import Path

from agent import CodeEditAgent


def test_code_edit_agent_apply_logic_patch(tmp_path: Path) -> None:
    target = tmp_path / "sample.py"
    target.write_text(
        "def main():\n    print('hello')\n",
        "utf-8",
    )

    agent = CodeEditAgent(target_file=target)
    updated = agent.apply_logic_patch("main", "print('updated')")

    assert "print('updated')" in updated
    assert target.read_text("utf-8") == "def main():\n    print('updated')\n"
