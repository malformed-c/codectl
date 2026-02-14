import json
from pathlib import Path
from typing import Dict, List, Union
from .py_codemod import get_file_map

EXCLUDE_DIRS = {".git", "node_modules", ".venv", "__pycache__", "codectl.egg-info"}
INCLUDE_EXTS = {".py", ".ts", ".js"} # We focus on these for now

def generate_repomap(root_path: str) -> Dict[str, Union[str, Dict]]:
    root = Path(root_path)
    repomap_data = {}

    for path in root.rglob("*"):
        if any(part in EXCLUDE_DIRS for part in path.parts):
            continue

        if path.is_file() and path.suffix in INCLUDE_EXTS:
            rel_path = str(path.relative_to(root))

            if path.suffix == ".py":
                file_map = get_file_map(str(path))
            else:
                # Placeholder for TS/JS
                file_map = [f"# {rel_path} (parsing not yet implemented)"]

            if file_map:
                repomap_data[rel_path] = file_map

    # Generate text version
    text_lines = []
    for rel_path, file_map in sorted(repomap_data.items()):
        text_lines.append(f"### {rel_path}")
        text_lines.extend(file_map)
        text_lines.append("") # space between files

    return {
        "json": repomap_data,
        "text": "\n".join(text_lines)
    }
