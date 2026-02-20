from __future__ import annotations
import multiprocessing
from typing import Any

from ansible import context
from ansible.executor.task_queue_manager import TaskQueueManager
from ansible.inventory.manager import InventoryManager
from ansible.module_utils.common.collections import ImmutableDict
from ansible.parsing.dataloader import DataLoader
from ansible.playbook.play import Play
from ansible.plugins.callback import CallbackBase
from ansible.vars.manager import VariableManager
from models import AnsibleItem, AnsibleReport, TaskResult


# ---
# Result callback
# ---


class ResultCallback(CallbackBase):
    """Captures per-task results from all v2_runner_on_* hooks."""

    def __init__(self) -> None:
        super().__init__()
        self.results: list[TaskResult] = []

    def v2_runner_on_ok(self, result: Any) -> None:
        changed = result._result.get("changed", False)
        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="changed" if changed else "ok",
                message=result._result.get("msg", ""),
            )
        )

    def v2_runner_on_failed(self, result: Any, ignore_errors: bool = False) -> None:
        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="failed",
                message=result._result.get("msg", str(result._result)),
            )
        )

    def v2_runner_on_skipped(self, result: Any) -> None:
        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="skipped",
                message=result._result.get("msg", ""),
            )
        )

    def v2_runner_on_unreachable(self, result: Any) -> None:
        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="unreachable",
                message=result._result.get("msg", ""),
            )
        )


# ---
# Play dict builder
# ---


def _task_to_dict(task: Any) -> dict[str, Any]:
    d: dict[str, Any] = {
        "name": task.name,
        task.module: task.args if task.args else {},
    }
    if task.when:
        d["when"] = task.when

    if task.notify:
        d["notify"] = task.notify

    return d


def _handler_to_dict(handler: Any) -> dict[str, Any]:
    return {
        "name": handler.name,
        handler.module: handler.args if handler.args else {},
    }


def build_play_dicts(items: list[AnsibleItem]) -> list[dict[str, Any]]:
    """Merge items into play dicts, grouped by hosts, preserving order."""
    plays_by_hosts: dict[str, dict[str, Any]] = {}

    for item in items:
        hosts = item.spec.hosts
        if hosts not in plays_by_hosts:
            plays_by_hosts[hosts] = {
                "name": item.metadata.description,
                "hosts": hosts,
                "gather_facts": False,
                "tasks": [],
                "handlers": [],
            }

        play = plays_by_hosts[hosts]
        play["tasks"].extend(_task_to_dict(t) for t in item.spec.tasks)
        play["handlers"].extend(_handler_to_dict(h) for h in item.spec.handlers)

    # Strip empty handlers (Ansible is unhappy with [])
    plays = []
    for play in plays_by_hosts.values():
        if not play["handlers"]:
            del play["handlers"]

        plays.append(play)

    return plays


# ---
# Runner
# ---


def run(items: list[AnsibleItem]) -> AnsibleReport:
    """Run AnsibleItems in-process via the Ansible Python API."""
    if not items:
        return AnsibleReport(ok=True, results=[])

    sorted_items = sorted(
        items,
        key=lambda i: i.metadata.order if i.metadata.order is not None else 0,
    )

    # Ansible context must be initialised before any API use
    context.CLIARGS = ImmutableDict(
        connection="local",
        module_path=[],
        forks=multiprocessing.cpu_count(),
        become=None,
        become_method=None,
        become_user=None,
        check=False,
        diff=False,
        verbosity=0,
        syntax=None,
        start_at_task=None,
    )

    loader = DataLoader()
    callback = ResultCallback()
    inventory = InventoryManager(loader=loader, sources="localhost,")
    variable_manager = VariableManager(loader=loader, inventory=inventory)

    play_dicts = build_play_dicts(sorted_items)

    tqm: TaskQueueManager | None = None
    try:
        tqm = TaskQueueManager(
            inventory=inventory,
            variable_manager=variable_manager,
            loader=loader,
            passwords={},
            stdout_callback=callback,
        )

        for play_dict in play_dicts:
            play = Play().load(
                play_dict,
                variable_manager=variable_manager,
                loader=loader,
            )
            tqm.run(play)

    except Exception as exc:  # noqa: BLE001
        return AnsibleReport(
            ok=False,
            results=callback.results,
            error=str(exc),
        )

    finally:
        if tqm:
            tqm.cleanup()

        loader.cleanup_all_tmp_files()

    any_failed = any(r.status in ("failed", "unreachable") for r in callback.results)

    return AnsibleReport(
        ok=not any_failed,
        results=callback.results,
    )
