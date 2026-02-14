import yaml
import tempfile
import os
import shutil
from pathlib import Path
import ansible_runner
from .models import CodePlan

def generate_playbook(plan: CodePlan) -> dict:
    tasks = []

    for item in plan.codePlan:
        for resource in item.spec.resources:
            task = {
                "name": f"Apply codemod to {resource.path}",
                "codeq": {
                    "path": resource.path,
                    "imports": resource.ensure.imports or [],
                    "functions": [
                        {
                            "name": f.name,
                            "state": f.state,
                            "streamID": f.streamID
                        } for f in (resource.ensure.functions or [])
                    ]
                }
            }
            tasks.append(task)

    playbook = [
        {
            "hosts": "localhost",
            "connection": "local",
            "tasks": tasks
        }
    ]
    return playbook

def run_plan(plan: CodePlan, base_dir: str, stream_url: str = None):
    playbook = generate_playbook(plan)

    with tempfile.TemporaryDirectory() as tmpdir:
        playbook_path = os.path.join(tmpdir, "playbook.yml")
        with open(playbook_path, "w") as f:
            yaml.dump(playbook, f)

        # Copy library to tmpdir so Ansible can find it
        library_src = os.path.join(os.path.dirname(__file__), "..", "library")
        library_dst = os.path.join(tmpdir, "library")
        shutil.copytree(library_src, library_dst)

        # We need to make sure the library can import codeq
        # We can set PYTHONPATH
        env = os.environ.copy()
        env["PYTHONPATH"] = f"{env.get('PYTHONPATH', '')}:{os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))}"
        if stream_url:
            env["CODECTL_STREAM_URL"] = stream_url

        r = ansible_runner.run(
            private_data_dir=tmpdir,
            playbook="playbook.yml",
            extravars={"base_dir": base_dir},
            envvars=env
        )

        return r.status, r.rc, r.stats
