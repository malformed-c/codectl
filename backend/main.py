from fastapi import FastAPI, HTTPException, Request
from codeq.models import CodePlan
from codeq.ansible import run_plan
from codeq.repomap import generate_repomap
import subprocess
import os

app = FastAPI(title="codectl backend")

# In-memory store for stream content for demonstration/testing
# In real scenario, this might call another service
STREAM_STORE = {}

@app.post("/apply")
async def apply_plan(plan: CodePlan, request: Request):
    # base_dir is current working directory or passed in config
    base_dir = os.getcwd()

    # We pass the stream_url to Ansible so it can call us back
    # We can infer it from the request
    stream_url = str(request.base_url).rstrip("/")

    status, rc, stats = run_plan(plan, base_dir, stream_url=stream_url)

    return {
        "status": status,
        "rc": rc,
        "stats": stats
    }

@app.get("/repomap")
async def get_repomap():
    base_dir = os.getcwd()
    return generate_repomap(base_dir)

@app.post("/rollback")
async def rollback():
    try:
        # Simple git rollback
        subprocess.run(["git", "checkout", "."], check=True)
        subprocess.run(["git", "clean", "-fd"], check=True)
        return {"status": "success", "message": "Rolled back changes using git"}
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Rollback failed: {str(e)}")

@app.get("/stream/{stream_id}")
async def get_stream(stream_id: str):
    if stream_id in STREAM_STORE:
        return {"content": STREAM_STORE[stream_id]}

    # Placeholder: In a real scenario, this would trigger model generation
    # For now, we'll return a placeholder if not found
    return {"content": f"# Placeholder content for {stream_id}\ndef dummy():\n    pass"}

@app.post("/stream/{stream_id}")
async def set_stream(stream_id: str, payload: dict):
    # This endpoint allows external services (like the model/frontend) to pre-fill stream content
    STREAM_STORE[stream_id] = payload.get("content", "")
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
