from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.sandbox_check import check_source
from app.source_normalization import normalize_build123d_source


ARTIFACT_ROOT = Path(os.getenv("ARTIFACT_ROOT", "/data/artifacts"))
WORKER_TOKEN = os.getenv("TEXT_TO_CAD_WORKER_TOKEN", "").strip()
WORKER_TIMEOUT_SECONDS = int(os.getenv("WORKER_TIMEOUT_SECONDS", "120"))
MAX_CONCURRENT_JOBS = max(1, int(os.getenv("MAX_CONCURRENT_JOBS", "2")))
CALLBACK_RETRY_DELAYS_SECONDS = (1.0, 4.0, 10.0)
CALLBACK_REQUEST_TIMEOUT_SECONDS = 30

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("text_to_cad_local")

# Bounds concurrent runner subprocesses; excess jobs wait for a slot.
JOB_SEMAPHORE = threading.Semaphore(MAX_CONCURRENT_JOBS)

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
            export_stl(model, output_dir / "model.stl")
            stl_path = output_dir / "model.stl"
            if not stl_path.exists() or stl_path.stat().st_size == 0:
                raise RuntimeError("STL export did not produce a file")
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


def kill_process_tree(process: subprocess.Popen) -> None:
    """Kill the runner subprocess and any children it spawned."""
    if process.poll() is not None:
        return
    try:
        if os.name == "nt":
            # TerminateProcess only kills the direct child; taskkill /T kills
            # the whole tree.
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                capture_output=True,
                timeout=15,
            )
        else:
            # Runner is started in its own session; kill the process group.
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except Exception:
        pass
    if process.poll() is None:
        try:
            process.kill()
        except Exception:
            pass


def run_build123d(job: JobRequest, job_dir: Path) -> dict[str, Any]:
    cleaned_source = clean_source(job.source)
    check_source(cleaned_source)

    source_path = job_dir / "source.py"
    source_path.write_text(cleaned_source, encoding="utf-8")
    runner_path = job_dir / "runner.py"
    runner_path.write_text(runner_source(), encoding="utf-8")

    popen_kwargs: dict[str, Any] = {}
    if os.name != "nt":
        # Own session so the whole process group can be killed on timeout.
        popen_kwargs["start_new_session"] = True

    process = subprocess.Popen(
        [sys.executable, str(runner_path), str(source_path), str(job_dir)],
        cwd=job_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **popen_kwargs,
    )
    try:
        stdout, stderr = process.communicate(timeout=WORKER_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        kill_process_tree(process)
        try:
            process.communicate(timeout=10)
        except Exception:
            pass
        raise

    if process.returncode != 0:
        raise RuntimeError(
            (stdout + "\n" + stderr).strip()
            or f"build123d exited with {process.returncode}"
        )

    step_path = job_dir / "model.step"
    if not step_path.exists() or step_path.stat().st_size == 0:
        raise RuntimeError("STEP export did not produce a file")
    stl_path = job_dir / "model.stl"
    if not stl_path.exists() or stl_path.stat().st_size == 0:
        raise RuntimeError("STL export did not produce a file")

    return {
        "stdout": stdout,
        "stderr": stderr,
    }


def log_job_end(
    job_id: str, status: str, started_at: float, exc: BaseException | None = None
) -> None:
    duration_seconds = time.monotonic() - started_at
    if exc is None:
        logger.info(
            "job_end jobId=%s status=%s duration_seconds=%.2f",
            job_id,
            status,
            duration_seconds,
        )
    else:
        logger.info(
            "job_end jobId=%s status=%s duration_seconds=%.2f error_class=%s",
            job_id,
            status,
            duration_seconds,
            type(exc).__name__,
        )


def post_callback_with_retries(
    callback_url: str, job_id: str, payload: dict[str, Any]
) -> None:
    body = json.dumps(payload).encode("utf-8")
    attempts = len(CALLBACK_RETRY_DELAYS_SECONDS) + 1
    for attempt in range(1, attempts + 1):
        try:
            callback_request = urllib.request.Request(
                callback_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    # cad-worker-callback authorizes against the shared
                    # worker token, the same one this worker validates.
                    "Authorization": f"Bearer {WORKER_TOKEN}",
                },
                method="POST",
            )
            with urllib.request.urlopen(
                callback_request, timeout=CALLBACK_REQUEST_TIMEOUT_SECONDS
            ):
                pass
            logger.info("callback_delivered jobId=%s attempt=%d", job_id, attempt)
            return
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500:
                # 4xx is terminal: the job row doesn't exist (404), the
                # payload was rejected (400), or auth is misconfigured
                # (401). Retrying cannot succeed. The synchronous HTTP
                # response remains the primary result path.
                logger.info(
                    "callback_skipped jobId=%s http_status=%d", job_id, exc.code
                )
                return
            logger.warning(
                "callback_post_failed jobId=%s attempt=%d/%d http_status=%d",
                job_id,
                attempt,
                attempts,
                exc.code,
            )
            if attempt < attempts:
                time.sleep(CALLBACK_RETRY_DELAYS_SECONDS[attempt - 1])
        except Exception as exc:
            logger.warning(
                "callback_post_failed jobId=%s attempt=%d/%d error_class=%s error=%s",
                job_id,
                attempt,
                attempts,
                type(exc).__name__,
                exc,
            )
            if attempt < attempts:
                time.sleep(CALLBACK_RETRY_DELAYS_SECONDS[attempt - 1])
    logger.error(
        "callback_abandoned jobId=%s url=%s attempts=%d "
        "result not delivered; artifacts remain under %s",
        job_id,
        callback_url,
        attempts,
        ARTIFACT_ROOT / slug(job_id),
    )


def send_callback(job: JobRequest, payload: dict[str, Any]) -> None:
    """Post the job result to the callback URL (if any) without blocking the response."""
    if not job.callbackUrl:
        return
    threading.Thread(
        target=post_callback_with_retries,
        args=(job.callbackUrl, job.jobId, payload),
        name=f"callback-{slug(job.jobId)}",
        daemon=True,
    ).start()


def failure_payload(job: JobRequest, error_message: str) -> dict[str, Any]:
    # Shape expected by the cad-worker-callback edge function (CallbackBody).
    return {
        "jobId": job.jobId,
        "status": "failure",
        "error": error_message,
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

    started_at = time.monotonic()
    logger.info(
        "job_start jobId=%s userId=%s prompt_chars=%d",
        job.jobId,
        (job.userId or "-")[:8],
        len(job.prompt.text),
    )

    job_name = slug(job.jobId)
    job_dir = ARTIFACT_ROOT / job_name
    if job_dir.exists():
        shutil.rmtree(job_dir)
    job_dir.mkdir(parents=True)

    try:
        with JOB_SEMAPHORE:
            run_build123d(job, job_dir)
    except subprocess.TimeoutExpired as exc:
        error_message = f"timeout after {WORKER_TIMEOUT_SECONDS}s"
        log_job_end(job.jobId, "timeout", started_at, exc)
        send_callback(job, failure_payload(job, error_message))
        raise HTTPException(status_code=504, detail=error_message) from exc
    except Exception as exc:
        log_job_end(job.jobId, "error", started_at, exc)
        send_callback(job, failure_payload(job, str(exc)))
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    source_path = job_dir / "source.py"
    if not source_path.exists():
        source_path.write_text(clean_source(job.source), encoding="utf-8")

    base_url = public_base_url(request)
    artifact_url = f"{base_url}/artifacts/{job_name}"
    artifacts: dict[str, str] = {
        "stepPath": f"{artifact_url}/model.step",
        "stlPath": f"{artifact_url}/model.stl",
        "sourcePath": f"{artifact_url}/source.py",
    }

    result = {
        "requestId": job.jobId,
        "status": "success",
        "title": "STEP CAD model",
        "artifacts": artifacts,
    }
    log_job_end(job.jobId, "ok", started_at)
    # Shape expected by the cad-worker-callback edge function (CallbackBody).
    send_callback(
        job,
        {
            "jobId": job.jobId,
            "status": "success",
            "title": "STEP CAD model",
            "artifacts": artifacts,
        },
    )
    return result
