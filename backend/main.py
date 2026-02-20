from __future__ import annotations
from pathlib import Path
import sys

from pydantic import ValidationError
import typer

import backend.ansible_bridge as ansible_bridge

from .models import AnsibleReport, AnsibleRequest

app = typer.Typer(help="codectl backend - Ansible bridge.")


# ---
# stdin/stdout runner
# ---


def run_from_stdin() -> None:
    try:
        raw = sys.stdin.read()
        request = AnsibleRequest.model_validate_json(raw)
        report = ansible_bridge.run(request.items)

    except ValidationError as exc:
        report = AnsibleReport(
            ok=False, results=[], error=f"Invalid request schema: {exc}"
        )

    except Exception as exc:
        report = AnsibleReport(ok=False, results=[], error=f"Unexpected error: {exc}")

    sys.stdout.write(report.model_dump_json())
    sys.stdout.flush()


# ---
# CLI
# ---


@app.callback(invoke_without_command=True)
def cli(ctx: typer.Context) -> None:
    """When invoked with no subcommand, behave as the stdin/stdout runner."""
    if ctx.invoked_subcommand is None:
        run_from_stdin()


@app.command("run-plan")
def run_plan(
    plan_file: Path = typer.Argument(..., help="Path to a CodePlan JSON file."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Validate only, do not run."),
) -> None:
    """Run Ansible items from a CodePlan JSON file."""
    try:
        request = AnsibleRequest.model_validate_json(plan_file.read_text("utf-8"))

    except ValidationError as exc:
        typer.echo(f"Validation error:\n{exc}", err=True)
        raise typer.Exit(1)

    except FileNotFoundError:
        typer.echo(f"File not found: {plan_file}", err=True)
        raise typer.Exit(1)

    if dry_run:
        typer.echo(
            f"Valid - {len(request.items)} Ansible item(s). Dry run, not executing."
        )
        return

    report = ansible_bridge.run(request.items)

    icons = {
        "ok": "✓",
        "changed": "~",
        "failed": "✗",
        "skipped": "-",
        "unreachable": "!",
    }

    for r in report.results:
        line = f"  [{icons.get(r.status, '?')}] {r.status:<12} {r.name}"
        if r.message:
            line += f"  ({r.message})"

        typer.echo(line)

    if report.error:
        typer.echo(f"\nError: {report.error}", err=True)

    raise typer.Exit(0 if report.ok else 1)


@app.command("validate")
def validate(
    plan_file: Path = typer.Argument(..., help="Path to a CodePlan JSON file."),
) -> None:
    """Validate a CodePlan JSON file against the Pydantic schema."""
    try:
        request = AnsibleRequest.model_validate_json(plan_file.read_text("utf-8"))
        typer.echo(f"Valid - {len(request.items)} Ansible item(s).")

        for item in request.items:
            typer.echo(
                f"  {item.metadata.description} - {len(item.spec.tasks)} task(s)"
            )

    except ValidationError as exc:
        typer.echo(f"Invalid:\n{exc}", err=True)
        raise typer.Exit(1)

    except FileNotFoundError:
        typer.echo(f"File not found: {plan_file}", err=True)
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
