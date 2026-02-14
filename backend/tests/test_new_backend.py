import pytest
from fastapi.testclient import TestClient
from main import app
from codeq.models import CodePlan
import os

client = TestClient(app)

def test_repomap():
    response = client.get("/repomap")
    assert response.status_code == 200
    data = response.json()
    assert "json" in data
    assert "text" in data
    assert "main.py" in data["json"]

def test_apply_plan_placeholder(tmp_path):
    # Create a dummy file
    test_file = tmp_path / "dummy.py"
    test_file.write_text("def hello():\n    pass\n")

    plan_data = {
        "codePlan": [
            {
                "apiVersion": "v1",
                "kind": "CodePlan",
                "metadata": {"description": "test update"},
                "spec": {
                    "resources": [
                        {
                            "path": str(test_file),
                            "ensure": {
                                "imports": ["import os"],
                                "functions": [
                                    {"name": "hello", "state": "present", "streamID": "stream123"}
                                ]
                            }
                        }
                    ]
                }
            }
        ]
    }

    # We need to mock the stream endpoint or just let it use the placeholder
    # Since we are running the same app, the Ansible module will call back to this app
    # But wait, Ansible runs in a separate process. It might not be able to call the TestClient's app easily.

    # For unit testing the logic without full Ansible, we can test apply_codemods directly (already did).

    # To test the /apply endpoint, we'd need a real server running or a mock for run_plan.
    pass

def test_stream_store():
    client.post("/stream/test-id", json={"content": "def test(): pass"})
    response = client.get("/stream/test-id")
    assert response.status_code == 200
    assert response.json()["content"] == "def test(): pass"
