from dataclasses import dataclass
from pathlib import Path

from codeq.main import CodeKind, CodePart, Codeq


@dataclass(slots=True)
class CodeEditAgent:
    """Small starter agent focused on deterministic code edits."""

    target_file: Path

    def apply_logic_patch(self, target: str, new_logic: str) -> str:
        """Replace function logic and persist to disk.

        Returns the updated function node text.
        """
        codeq = Codeq.from_file(self.target_file)
        codeq.replace(CodeKind.FUNC, target, CodePart.LOGIC, new_logic)
        codeq.overwrite_file(self.target_file)
        updated = codeq.retrieve(CodeKind.FUNC, target, CodePart.NODE)

        if updated is None:
            raise ValueError(f"Unable to retrieve function after patch: {target}")

        return updated
