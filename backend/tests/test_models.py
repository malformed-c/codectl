from __future__ import annotations
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from backend.ansible_bridge import run
from backend.models import (
    AnsibleHandler,
    AnsibleItem,
    AnsibleMeta,
    AnsibleReport,
    AnsibleRequest,
    AnsibleSpec,
    AnsibleTask,
    TaskResult,
)


# ---
# Fixtures
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


# ---
# _parse_ansible_json
# ---

ANSIBLE_JSON_OK = json.dumps(
    {
        "plays": [
            {
                "tasks": [
                    {
                        "task": {"name": "Install git"},
                        "hosts": {
                            "localhost": {
                                "changed": False,
                                "failed": False,
                                "skipped": False,
                                "unreachable": False,
                                "msg": "",
                            }
                        },
                    }
                ]
            }
        ],
        "stats": {"localhost": {"ok": 1, "changed": 0, "failures": 0, "skipped": 0}},
    }
)

ANSIBLE_JSON_CHANGED = json.dumps(
    {
        "plays": [
            {
                "tasks": [
                    {
                        "task": {"name": "Install git"},
                        "hosts": {
                            "localhost": {
                                "changed": True,
                                "failed": False,
                                "skipped": False,
                                "unreachable": False,
                                "msg": "",
                            }
                        },
                    }
                ]
            }
        ],
        "stats": {},
    }
)

ANSIBLE_JSON_FAILED = json.dumps(
    {
        "plays": [
            {
                "tasks": [
                    {
                        "task": {"name": "Install git"},
                        "hosts": {
                            "localhost": {
                                "changed": False,
                                "failed": True,
                                "skipped": False,
                                "unreachable": False,
                                "msg": "No package matching 'gitt'",
                            }
                        },
                    }
                ]
            }
        ],
        "stats": {},
    }
)

# ---
# run() - mocked subprocess
# ---


def _make_proc(stdout: str, stderr: str = "", returncode: int = 0) -> MagicMock:
    proc = MagicMock()
    proc.stdout = stdout
    proc.stderr = stderr
    proc.returncode = returncode

    return proc


@patch("ansible_bridge.subprocess.run")
def test_run_ok(mock_run: MagicMock) -> None:
    mock_run.return_value = _make_proc(stdout=ANSIBLE_JSON_OK)
    item = _make_item(
        tasks=[
            {
                "name": "Install git",
                "module": "ansible.builtin.apt",
                "args": {"name": "git"},
            }
        ]
    )
    report = run([item])

    assert report.ok is True
    assert report.results[0].status == "ok"


@patch("ansible_bridge.subprocess.run")
def test_run_failed_task(mock_run: MagicMock) -> None:
    mock_run.return_value = _make_proc(stdout=ANSIBLE_JSON_FAILED, returncode=2)
    item = _make_item(
        tasks=[
            {
                "name": "Install git",
                "module": "ansible.builtin.apt",
                "args": {"name": "gitt"},
            }
        ]
    )
    report = run([item])

    assert report.ok is False
    assert report.results[0].status == "failed"


@patch("ansible_bridge.subprocess.run")
def test_run_no_output(mock_run: MagicMock) -> None:
    mock_run.return_value = _make_proc(
        stdout="", stderr="ansible-playbook: command not found", returncode=127
    )
    item = _make_item(tasks=[{"name": "T", "module": "m", "args": {}}])
    report = run([item])

    assert report.ok is False
    assert report.error == "ansible-playbook: command not found"


def test_run_empty_items() -> None:
    report = run([])

    assert report.ok is True
    assert report.results == []


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
            ]
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
            ]
        }
    )

    with pytest.raises(ValidationError):
        AnsibleRequest.model_validate_json(raw)
