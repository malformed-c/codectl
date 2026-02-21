from __future__ import annotations
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


# ---
# Inbound - AnsibleItem (matches TS AnsibleItem)
# ---


class AnsibleTask(BaseModel):
    name: str
    module: str
    args: dict[str, Any] = Field(default_factory=dict)
    when: str | None = None
    notify: str | None = None

    @field_validator("args")
    @classmethod
    def ensure_args_dict(cls, v: dict[str, Any]) -> dict[str, Any]:
        return v or {}


class AnsibleHandler(BaseModel):
    name: str
    module: str
    args: dict[str, Any] = Field(default_factory=dict)


class AnsibleSpec(BaseModel):
    hosts: str = "localhost"
    tasks: list[AnsibleTask]
    handlers: list[AnsibleHandler] = Field(default_factory=list)


class AnsibleMeta(BaseModel):
    description: str
    order: int | None = None


class AnsibleItem(BaseModel):
    apiVersion: Literal["codectl/v1"]
    kind: Literal["Ansible"]
    metadata: AnsibleMeta
    spec: AnsibleSpec


# ---
# Inbound - request envelope (sent by Bun via stdin)
# ---


class AnsibleRequest(BaseModel):
    """
    What the Bun frontend sends over stdin.
    Items are already filtered to kind=Ansible and sorted by metadata.order.
    """

    items: list[AnsibleItem]


# ---
# Outbound - structured report (sent back to Bun via stdout)
# ---


class TaskResult(BaseModel):
    name: str
    status: Literal["ok", "changed", "failed", "skipped", "unreachable"]
    message: str = ""


class AnsibleReport(BaseModel):
    ok: bool
    results: list[TaskResult]
    error: str | None = None
