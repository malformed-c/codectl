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
from ansible.plugins.loader import init_plugin_loader
from ansible.vars.manager import VariableManager

from models import AnsibleItem, AnsibleReport, TaskResult

init_plugin_loader([])

# ---
# Result callback
# ---


class ResultCallback(CallbackBase):
    """Captures per-task results from all v2_runner_on_* hooks."""

    def __init__(self, variable_manager: VariableManager):
        super().__init__()
        self.variable_manager = variable_manager
        self.results = []
        self.summary = {}

    def v2_runner_on_ok(self, result):

        host = result._host
        data = result._result

        # Store facts
        if "ansible_facts" in data:
            self.variable_manager.set_host_facts(host, data["ansible_facts"])

        # Store register
        if result._task.register:
            self.variable_manager.set_host_variable(host, result._task.register, data)

        changed = data.get("changed", False)

        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="changed" if changed else "ok",
                message=data.get("msg", ""),
            )
        )

    def v2_runner_on_failed(self, result, ignore_errors=False):

        host = result._host
        data = result._result

        if result._task.register:
            self.variable_manager.set_host_variable(host, result._task.register, data)

        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="failed",
                message=data.get("msg", str(data)),
            )
        )

    def v2_runner_on_skipped(self, result):

        host = result._host
        data = result._result

        if result._task.register:
            self.variable_manager.set_host_variable(host, result._task.register, data)

        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="skipped",
                message=data.get("msg", ""),
            )
        )

    def v2_runner_on_unreachable(self, result):

        host = result._host
        data = result._result

        if result._task.register:
            self.variable_manager.set_host_variable(host, result._task.register, data)

        self.results.append(
            TaskResult(
                name=result._task.get_name(),
                status="unreachable",
                message=data.get("msg", ""),
            )
        )

    def v2_runner_item_on_ok(self, result):

        host = result._host
        data = result._result

        if result._task.register:
            current = self.variable_manager.get_vars(host=host).get(
                result._task.register, {"results": []}
            )

            current["results"].append(data)

            self.variable_manager.set_host_variable(
                host, result._task.register, current
            )

    def v2_playbook_on_stats(self, stats):
        """
        Called at the end of the playbook run.
        Collects per-host statistics and overall summary.
        """
        summary = {
            "ok": {},
            "changed": {},
            "failed": {},
            "skipped": {},
            "unreachable": {},
        }

        for host in stats.processed:
            summary["ok"][host] = stats.ok.get(host, 0)
            summary["changed"][host] = stats.changed.get(host, 0)
            summary["failed"][host] = stats.failures.get(host, 0)
            summary["skipped"][host] = stats.skipped.get(host, 0)
            summary["unreachable"][host] = stats.dark.get(host, 0)

        # Store in callback for later retrieval
        self.summary = summary

        for category, hosts in summary.items():
            print(f"{category}:")
            for host, count in hosts.items():
                print(f"  {host}: {count}")


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
        gather_facts=False,
    )

    loader = DataLoader()
    inventory = InventoryManager(loader=loader, sources="localhost,")
    variable_manager = VariableManager(loader=loader, inventory=inventory)
    callback = ResultCallback(variable_manager)

    play_dicts = build_play_dicts(sorted_items)

    tqm: TaskQueueManager | None = None
    try:

        class _TQM(TaskQueueManager):
            """TQM subclass that loads a pre-built callback instead of a named plugin."""

            def load_callbacks(self) -> None:
                if self._callback_plugins:
                    return
                callback._init_callback_methods()
                callback.set_options()
                self._callback_plugins = [callback]

        tqm = _TQM(
            inventory=inventory,
            variable_manager=variable_manager,
            loader=loader,
            passwords={},
        )

        for play_dict in play_dicts:
            play = Play().load(
                play_dict,
                variable_manager=variable_manager,
                loader=loader,
            )
            tqm.run(play)

    except Exception as exc:
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
