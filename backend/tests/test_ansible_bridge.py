from __future__ import annotations
import json
from unittest.mock import MagicMock, patch

import pytest

from backend.ansible_bridge import ResultCallback, build_play_dicts, run
from backend.models import (
    AnsibleHandler,
    AnsibleItem,
    AnsibleMeta,
    AnsibleRequest,
    AnsibleSpec,
    AnsibleTask,
    TaskResult,
)


# ---
# Helpers
# ---


def _make_item(
    tasks: list[dict],
    handlers: list[dict] | None = None,
    hosts: str = "localhost",
    description: str = "test item",
    order: int | None = None,
) -> AnsibleItem:
    return AnsibleItem(
        apiVersion="codectl/v1",
        kind="Ansible",
        metadata=AnsibleMeta(description=description, order=order),
        spec=AnsibleSpec(
            hosts=hosts,
            tasks=[AnsibleTask(**t) for t in tasks],
            handlers=[AnsibleHandler(**h) for h in (handlers or [])],
        ),
    )


def _mock_result(
    name: str,
    changed: bool = False,
    failed: bool = False,
    skipped: bool = False,
    unreachable: bool = False,
    msg: str = "",
) -> MagicMock:
    r = MagicMock()
    r._task.get_name.return_value = name
    r._result = {
        "changed": changed,
        "failed": failed,
        "skipped": skipped,
        "unreachable": unreachable,
        "msg": msg,
    }

    return r


# ---
# build_play_dicts
# ---


def test_build_play_dicts_single_item() -> None:
    item = _make_item(
        tasks=[
            {
                "name": "Install git",
                "module": "ansible.builtin.apt",
                "args": {"name": "git", "state": "present"},
            }
        ]
    )
    plays = build_play_dicts([item])

    assert len(plays) == 1

    play = plays[0]

    assert play["hosts"] == "localhost"
    assert play["gather_facts"] is False
    assert len(play["tasks"]) == 1
    assert play["tasks"][0]["name"] == "Install git"
    assert play["tasks"][0]["ansible.builtin.apt"] == {
        "name": "git",
        "state": "present",
    }
    assert "handlers" not in play


def test_build_play_dicts_merges_same_hosts() -> None:
    a = _make_item(tasks=[{"name": "T1", "module": "m", "args": {}}], order=1)
    b = _make_item(tasks=[{"name": "T2", "module": "m", "args": {}}], order=2)
    plays = build_play_dicts([a, b])

    assert len(plays) == 1
    assert len(plays[0]["tasks"]) == 2


def test_build_play_dicts_separate_hosts() -> None:
    a = _make_item(tasks=[{"name": "T1", "module": "m", "args": {}}], hosts="web")
    b = _make_item(tasks=[{"name": "T2", "module": "m", "args": {}}], hosts="db")
    plays = build_play_dicts([a, b])

    assert {p["hosts"] for p in plays} == {"web", "db"}


def test_build_play_dicts_includes_handlers() -> None:
    item = _make_item(
        tasks=[
            {
                "name": "Copy config",
                "module": "ansible.builtin.copy",
                "args": {},
                "notify": "Restart nginx",
            }
        ],
        handlers=[
            {
                "name": "Restart nginx",
                "module": "ansible.builtin.service",
                "args": {"name": "nginx", "state": "restarted"},
            }
        ],
    )
    plays = build_play_dicts([item])

    assert "handlers" in plays[0]
    assert plays[0]["handlers"][0]["name"] == "Restart nginx"


def test_build_play_dicts_task_when() -> None:
    item = _make_item(
        tasks=[
            {
                "name": "Conditional",
                "module": "ansible.builtin.debug",
                "args": {},
                "when": "ansible_os_family == 'Debian'",
            }
        ]
    )
    plays = build_play_dicts([item])

    assert plays[0]["tasks"][0]["when"] == "ansible_os_family == 'Debian'"


# ---
# ResultCallback
# ---


def test_callback_on_ok() -> None:
    cb = ResultCallback()
    cb.v2_runner_on_ok(_mock_result("Install git"))

    assert cb.results[0].status == "ok"


def test_callback_on_ok_changed() -> None:
    cb = ResultCallback()
    cb.v2_runner_on_ok(_mock_result("Install git", changed=True))

    assert cb.results[0].status == "changed"


def test_callback_on_failed() -> None:
    cb = ResultCallback()
    cb.v2_runner_on_failed(
        _mock_result("Install git", msg="No package matching 'gitt'")
    )

    assert cb.results[0].status == "failed"
    assert "gitt" in cb.results[0].message


def test_callback_on_skipped() -> None:
    cb = ResultCallback()
    cb.v2_runner_on_skipped(_mock_result("Conditional task"))

    assert cb.results[0].status == "skipped"


def test_callback_on_unreachable() -> None:
    cb = ResultCallback()
    cb.v2_runner_on_unreachable(_mock_result("Ping", msg="SSH timeout"))

    assert cb.results[0].status == "unreachable"
    assert "SSH timeout" in cb.results[0].message


# ---
# run() - mocked TaskQueueManager
# ---

ANSIBLE_MOCKS = [
    "ansible_bridge.context",
    "ansible_bridge.DataLoader",
    "ansible_bridge.InventoryManager",
    "ansible_bridge.VariableManager",
    "ansible_bridge.Play",
    "ansible_bridge.TaskQueueManager",
]


def _patch_ansible(cb_results: list[TaskResult]):
    """Return a context manager that patches the full Ansible stack."""
    import contextlib

    @contextlib.contextmanager
    def _ctx():
        patches = [patch(m) for m in ANSIBLE_MOCKS]
        mocks = [p.start() for p in patches]
        tqm_mock = mocks[-1].return_value  # TaskQueueManager instance

        # Inject results via the ResultCallback side-effect
        original_run = run

        def fake_tqm_run(play):
            pass  # results injected directly below

        tqm_mock.run.side_effect = fake_tqm_run

        # Monkey-patch ResultCallback to pre-load results
        with patch("ansible_bridge.ResultCallback") as cb_cls:
            cb_instance = MagicMock()
            cb_instance.results = cb_results
            cb_cls.return_value = cb_instance

            yield mocks

        for p in patches:
            p.stop()

    return _ctx()


def test_run_empty_items() -> None:
    report = run([])

    assert report.ok is True
    assert report.results == []


@patch("ansible_bridge.TaskQueueManager")
@patch("ansible_bridge.Play")
@patch("ansible_bridge.VariableManager")
@patch("ansible_bridge.InventoryManager")
@patch("ansible_bridge.DataLoader")
@patch("ansible_bridge.context")
@patch("ansible_bridge.ResultCallback")
def test_run_ok(MockCB, mock_ctx, mock_dl, mock_inv, mock_vm, mock_play, mock_tqm):
    cb = MagicMock()
    cb.results = [TaskResult(name="Install git", status="ok")]
    MockCB.return_value = cb

    item = _make_item(
        tasks=[{"name": "Install git", "module": "ansible.builtin.apt", "args": {}}]
    )
    report = run([item])

    assert report.ok is True
    assert report.results[0].status == "ok"


@patch("ansible_bridge.TaskQueueManager")
@patch("ansible_bridge.Play")
@patch("ansible_bridge.VariableManager")
@patch("ansible_bridge.InventoryManager")
@patch("ansible_bridge.DataLoader")
@patch("ansible_bridge.context")
@patch("ansible_bridge.ResultCallback")
def test_run_failed_task(
    MockCB, mock_ctx, mock_dl, mock_inv, mock_vm, mock_play, mock_tqm
):
    cb = MagicMock()
    cb.results = [TaskResult(name="Install git", status="failed", message="No package")]
    MockCB.return_value = cb

    item = _make_item(
        tasks=[{"name": "Install git", "module": "ansible.builtin.apt", "args": {}}]
    )
    report = run([item])

    assert report.ok is False
    assert report.results[0].status == "failed"


@patch("ansible_bridge.TaskQueueManager")
@patch("ansible_bridge.Play")
@patch("ansible_bridge.VariableManager")
@patch("ansible_bridge.InventoryManager")
@patch("ansible_bridge.DataLoader")
@patch("ansible_bridge.context")
@patch("ansible_bridge.ResultCallback")
def test_run_tqm_exception(
    MockCB, mock_ctx, mock_dl, mock_inv, mock_vm, mock_play, mock_tqm
):
    cb = MagicMock()
    cb.results = []
    MockCB.return_value = cb
    mock_tqm.return_value.run.side_effect = RuntimeError("connection refused")

    item = _make_item(tasks=[{"name": "T", "module": "m", "args": {}}])
    report = run([item])

    assert report.ok is False
    assert "connection refused" in report.error


# ---
# models - AnsibleRequest round-trip
# ---


def test_request_round_trip() -> None:
    raw = json.dumps(
        {
            "items": [
                {
                    "apiVersion": "codectl/v1",
                    "kind": "Ansible",
                    "metadata": {"description": "Install deps", "order": 1},
                    "spec": {
                        "hosts": "localhost",
                        "tasks": [
                            {
                                "name": "Install git",
                                "module": "ansible.builtin.apt",
                                "args": {"name": "git", "state": "present"},
                            }
                        ],
                    },
                }
            ],
        }
    )
    request = AnsibleRequest.model_validate_json(raw)

    assert request.items[0].kind == "Ansible"
    assert request.items[0].spec.tasks[0].module == "ansible.builtin.apt"


def test_request_rejects_wrong_kind() -> None:
    from pydantic import ValidationError

    raw = json.dumps(
        {
            "items": [
                {
                    "apiVersion": "codectl/v1",
                    "kind": "CodeEdit",
                    "metadata": {"description": "oops"},
                    "spec": {"hosts": "localhost", "tasks": []},
                }
            ],
        }
    )

    with pytest.raises(ValidationError):
        AnsibleRequest.model_validate_json(raw)
