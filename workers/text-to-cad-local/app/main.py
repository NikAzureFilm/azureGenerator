from __future__ import annotations

import os
import re
import shutil
import subprocess
import textwrap
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.source_normalization import normalize_build123d_source


ARTIFACT_ROOT = Path(os.getenv("ARTIFACT_ROOT", "/data/artifacts"))
WORKER_TOKEN = os.getenv("TEXT_TO_CAD_WORKER_TOKEN", "").strip()
WORKER_TIMEOUT_SECONDS = int(os.getenv("WORKER_TIMEOUT_SECONDS", "120"))

ARTIFACT_ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="AzureFilm local text-to-CAD worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)
app.mount("/artifacts", StaticFiles(directory=ARTIFACT_ROOT), name="artifacts")


class Prompt(BaseModel):
    text: str = ""
    images: list[str] = Field(default_factory=list)
    model: str | None = None


class JobRequest(BaseModel):
    jobId: str
    userId: str | None = None
    conversationId: str | None = None
    messageId: str | None = None
    prompt: Prompt
    source: str
    artifactPrefix: str | None = None
    callbackUrl: str | None = None


def authorize(authorization: str | None) -> None:
    if not WORKER_TOKEN:
        raise HTTPException(status_code=500, detail="worker token is not configured")
    if authorization != f"Bearer {WORKER_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def public_base_url(request: Request) -> str:
    configured = os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/")
    if configured:
        return configured
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}".rstrip("/")
    return str(request.base_url).rstrip("/")


def clean_source(source: str) -> str:
    source = source.strip()
    fence = re.search(r"```(?:python)?\s*([\s\S]*?)```", source)
    if fence:
        source = fence.group(1).strip()
    source = normalize_build123d_source(source)
    return source


def slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-")
    return value[:80] or uuid.uuid4().hex


def runner_source() -> str:
    return textwrap.dedent(
        """
        import importlib.util
        import json
        import sys
        import traceback
        from pathlib import Path

        from build123d import export_step, export_stl

        source_path = Path(sys.argv[1])
        output_dir = Path(sys.argv[2])
        output_dir.mkdir(parents=True, exist_ok=True)

        try:
            spec = importlib.util.spec_from_file_location("generated_model", source_path)
            if spec is None or spec.loader is None:
                raise RuntimeError("Could not load generated source")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            if not hasattr(module, "gen_step"):
                raise RuntimeError("Generated source must define gen_step()")
            model = module.gen_step()
            if model is None:
                raise RuntimeError("gen_step() returned None")
            export_step(model, output_dir / "model.step")
            try:
                export_stl(model, output_dir / "model.stl")
            except Exception:
                pass
            print(json.dumps({"ok": True}))
        except Exception as exc:
            print(json.dumps({
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }))
            sys.exit(1)
        """
    )


def run_build123d(job: JobRequest, job_dir: Path) -> dict[str, Any]:
    source_path = job_dir / "source.py"
    source_path.write_text(clean_source(job.source), encoding="utf-8")
    runner_path = job_dir / "runner.py"
    runner_path.write_text(runner_source(), encoding="utf-8")

    result = subprocess.run(
        ["python", str(runner_path), str(source_path), str(job_dir)],
        cwd=job_dir,
        capture_output=True,
        text=True,
        timeout=WORKER_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise RuntimeError(
            (result.stdout + "\n" + result.stderr).strip()
            or f"build123d exited with {result.returncode}"
        )

    step_path = job_dir / "model.step"
    if not step_path.exists() or step_path.stat().st_size == 0:
        raise RuntimeError("STEP export did not produce a file")

    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "worker": "text-to-cad-local",
        "artifacts": str(ARTIFACT_ROOT),
    }


@app.post("/")
@app.post("/jobs")
def create_job(
    job: JobRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)

    job_name = slug(job.jobId)
    job_dir = ARTIFACT_ROOT / job_name
    if job_dir.exists():
        shutil.rmtree(job_dir)
    job_dir.mkdir(parents=True)

    try:
        run_build123d(job, job_dir)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=504,
            detail=f"STEP generation timed out after {WORKER_TIMEOUT_SECONDS}s",
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    source_path = job_dir / "source.py"
    if not source_path.exists():
        source_path.write_text(clean_source(job.source), encoding="utf-8")

    base_url = public_base_url(request)
    artifact_url = f"{base_url}/artifacts/{job_name}"
    artifacts: dict[str, str] = {
        "stepPath": f"{artifact_url}/model.step",
        "sourcePath": f"{artifact_url}/source.py",
    }
    if (job_dir / "model.stl").exists():
        artifacts["stlPath"] = f"{artifact_url}/model.stl"

    return {
        "requestId": job.jobId,
        "status": "success",
        "title": "STEP CAD model",
        "artifacts": artifacts,
    }
