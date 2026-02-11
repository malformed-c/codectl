from pathlib import Path

import typer

from agent import CodeEditAgent

app = typer.Typer(help="Code editing CLI.")


@app.callback()
def cli() -> None:
    """CLI entrypoint for codectl commands."""


@app.command("patch-logic")
def patch_logic(
    target_file: Path = typer.Argument(..., help="Python file to patch."),
    target: str = typer.Argument(..., help="Function name to patch."),
    logic: str = typer.Argument(..., help="Replacement function logic."),
) -> None:
    """Patch function logic in a file and overwrite it in-place."""
    agent = CodeEditAgent(target_file=target_file)
    updated = agent.apply_logic_patch(target=target, new_logic=logic)
    typer.echo(updated)


if __name__ == "__main__":
    app()
