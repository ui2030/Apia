"""services/cosyvoice_service.py — opt-in CosyVoice3 TTS 엔진(로컬 음성 복제).

기본 TTS 체인(edge→pyttsx3→silent)은 이 모듈을 모른다. 사용자가 설정에서
"CosyVoice"를 고른 요청만 여기로 오고, **어떤 실패든** tts_service가 기본
체인으로 조용히 폴백한다 — /tts는 500을 내지 않는다.

CosyVoice는 backend가 직접 import하지 않는다(torch/matcha 의존이 백엔드와
다르고, import 실패가 FastAPI 프로세스를 통째로 죽인다). 대신 실험 venv의
파이썬으로 workers/cosyvoice_worker.py를 띄워 JSON lines로 대화한다.

수명: 워커는 모델을 VRAM에 물고 살아 있다(콜드 로드 ~19s는 첫 요청만).
유휴 COSYVOICE_IDLE_UNLOAD_MIN분이 지나면 **프로세스 트리째** 죽인다 —
Windows에서 torch 자식이 남아 VRAM을 붙들고 있으면 게임/다른 로컬 모델과
다툰다. 별도 타이머는 두지 않고 local LLM과 같은 기회주의 방식으로 이미
있는 호출(GET /warmup)에 얹는다.

동시성: 워커는 stdin/stdout 한 쌍이라 파이프라이닝이 불가능하다. 요청 전체를
asyncio.Lock으로 single-flight 직렬화하고, 응답의 id가 보낸 id와 다르면
스트림이 어긋난 것으로 보고 실패 처리 + 재스폰한다.
"""
import asyncio
import io
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

from ai_config import (
    COSYVOICE_IDLE_UNLOAD_MIN,
    COSYVOICE_MODEL_DIR,
    COSYVOICE_PROMPT_WAV,
    COSYVOICE_PYTHON,
    COSYVOICE_REPO,
)

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
WORK_DIR = DATA_DIR / "cosyvoice"
# 워커가 쓰는 wav는 여기에만 떨어지고, 읽는 즉시 지운다.
OUT_DIR = WORK_DIR / "out"
WORKER_SCRIPT = Path(__file__).resolve().parent.parent / "workers" / "cosyvoice_worker.py"

# 사용자가 고른 캐릭터 목소리(Electron 설정 UI가 22.05kHz mono WAV로 정규화해
# 여기에 쓴다)와, 없을 때 쓸 edge 자동 생성 참조.
USER_PROMPT_WAV = WORK_DIR / "prompt.wav"
DEFAULT_PROMPT_WAV = WORK_DIR / "default_prompt.wav"
# 공개 repo에 음성 파일을 동봉하지 않기 위해(라이선스) 기본 참조는 첫 사용
# 시점에 로컬에서 만든다. transcript를 아는 문장이라 zero-shot을 쓸 수 있다.
DEFAULT_PROMPT_TEXT = "안녕하세요, 저는 아피아예요. 오늘은 뭐부터 할까요?"

MODEL_LOAD_TIMEOUT_SEC = 180  # 콜드 로드 실측 ~19s + 첫 컴파일 여유
CHUNK_TIMEOUT_SEC = 30  # 청크(문장 묶음) 1개 합성 상한
CHUNK_CHARS = 120  # 이보다 길면 문장 경계로 쪼개 직렬 합성

_proc = None
_lock = asyncio.Lock()
_last_used = 0.0
_sample_rate = 0


# ── 구성 검증 ───────────────────────────────────────────────────────────────

def model_dir() -> Path:
    """모델 폴더 절대경로. 상대경로는 **저장소 루트 기준**으로 푼다 — CosyVoice
    문서/스크립트가 'pretrained_models/...'로 쓰는 관례를 그대로 받되, 백엔드의
    cwd(어디든 될 수 있다)에 딸려가지 않게."""
    raw = Path(COSYVOICE_MODEL_DIR)
    return raw if raw.is_absolute() else Path(COSYVOICE_REPO) / raw


def config_error() -> str | None:
    """엔진을 쓸 수 있는지. None=가능, 문자열=사유(영어 — 콘솔 mojibake 회피)."""
    for name, value in (
        ("APIA_COSYVOICE_PYTHON", COSYVOICE_PYTHON),
        ("APIA_COSYVOICE_REPO", COSYVOICE_REPO),
        ("APIA_COSYVOICE_MODEL_DIR", COSYVOICE_MODEL_DIR),
    ):
        if not value:
            return f"{name} not set"
    for name, path in (
        ("APIA_COSYVOICE_PYTHON", Path(COSYVOICE_PYTHON)),
        ("APIA_COSYVOICE_REPO", Path(COSYVOICE_REPO)),
        ("APIA_COSYVOICE_MODEL_DIR", model_dir()),
    ):
        if not path.exists():
            return f"{name} path missing: {path}"
    if not WORKER_SCRIPT.exists():
        return f"worker script missing: {WORKER_SCRIPT}"
    return None


def is_configured() -> bool:
    return config_error() is None


def resolve_prompt_wav() -> Path | None:
    """쓸 수 있는 참조 음성 경로(사용자 지정 > env > 자동 생성 캐시). 없으면 None."""
    for candidate in (COSYVOICE_PROMPT_WAV, USER_PROMPT_WAV, DEFAULT_PROMPT_WAV):
        if candidate and Path(candidate).exists():
            return Path(candidate)
    return None


def prompt_text_for(prompt_wav: Path) -> str:
    """참조 음성의 전사(sidecar .txt). 있으면 zero-shot, 없으면 cross-lingual.

    사용자가 올린 파일은 전사를 알 수 없으므로 sidecar가 없다 — 그 경우
    cross-lingual로 합성한다(전사 추측보다 안전).
    """
    sidecar = prompt_wav.with_suffix(".txt")
    try:
        return sidecar.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


# ── 워커 수명 ───────────────────────────────────────────────────────────────

async def _spawn():
    """워커 프로세스 생성 + ready 라인 대기. 테스트가 이 함수를 대체한다."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    kwargs = {}
    if sys.platform == "win32" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    # stderr는 파이프가 아니라 파일로 보낸다. CosyVoice/torch는 로그를 쏟아내는데
    # 아무도 안 읽는 파이프가 차면 워커가 write에서 영구 블록된다.
    log_handle = open(WORK_DIR / "worker.log", "w", encoding="utf-8", errors="replace")
    try:
        return await asyncio.create_subprocess_exec(
            COSYVOICE_PYTHON,
            str(WORKER_SCRIPT),
            COSYVOICE_REPO,
            str(model_dir()),
            str(OUT_DIR),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=log_handle,
            cwd=COSYVOICE_REPO,
            env={**os.environ, "PYTHONPATH": COSYVOICE_REPO, "PYTHONUNBUFFERED": "1",
                 "PYTHONIOENCODING": "utf-8"},
            **kwargs,
        )
    finally:
        log_handle.close()


async def _ensure_worker():
    """살아 있는 워커 보장. 실패는 예외 — 호출자(tts_service)가 폴백한다."""
    global _proc, _sample_rate

    if _proc is not None and _proc.returncode is None:
        return
    _proc = None

    error = config_error()
    if error:
        raise RuntimeError(error)

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    proc = await _spawn()
    _proc = proc

    try:
        ready = await asyncio.wait_for(
            proc.stdout.readline(), timeout=MODEL_LOAD_TIMEOUT_SEC
        )
    except (asyncio.TimeoutError, asyncio.CancelledError):
        await kill()
        raise RuntimeError(f"cosyvoice worker load timeout ({MODEL_LOAD_TIMEOUT_SEC}s)")

    payload = _parse_line(ready)
    if payload is None or payload.get("error") or "sample_rate" not in payload:
        detail = (payload or {}).get("error") if payload else "no ready line"
        await kill()
        raise RuntimeError(f"cosyvoice worker start failed: {detail} (see {WORK_DIR / 'worker.log'})")

    _sample_rate = int(payload["sample_rate"])
    print(f"[TTS] cosyvoice worker ready (pid={proc.pid}, sr={_sample_rate})")


def _parse_line(raw) -> dict | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw.decode("utf-8", errors="replace").strip())
    except (ValueError, AttributeError):
        return None
    return payload if isinstance(payload, dict) else None


async def kill() -> None:
    """워커를 **트리째** 죽이고 거둬간다. 재진입/중복 호출 안전.

    experiment venv의 python.exe는 실제 인터프리터를 자식으로 다시 띄우고(venv가
    base 환경을 상속), torch도 자식을 만든다 — 실측 pid 1개 뒤에 2개가 더 있었다.
    부모만 죽이면 그 자식들이 VRAM 4GB를 그대로 붙들고 남는다. 그래서 /T.

    kill 뒤 `wait()`까지 하는 이유: 안 거둬가면 asyncio proactor 파이프 transport가
    GC 시점에 "unclosed transport"를 콘솔에 토한다.
    """
    global _proc
    proc, _proc = _proc, None
    if proc is None:
        return

    pid = getattr(proc, "pid", None)
    if sys.platform == "win32" and pid and proc.returncode is None:
        try:
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as error:
            print(f"[TTS] cosyvoice taskkill failed: {type(error).__name__}: {error}")
    try:
        proc.kill()  # 이미 죽었으면 ProcessLookupError — 그래도 wait()로 거둬가야 한다
    except Exception:
        pass
    try:
        await proc.wait()
    except Exception:
        pass
    # 프로세스를 거둬가도 stdin/stdout **파이프** transport는 열린 채 남는다.
    # 백엔드가 종료 중이면 이벤트 루프가 EOF를 처리할 틈이 없어서, GC가
    # "unclosed transport / I/O operation on closed pipe"를 stderr에 토한다.
    # ponytail: _transport는 비공개지만 파이프를 한 번에 닫는 공개 API가 없다
    # (3.8~3.13 동일). 없어져도 except가 삼킨다.
    for closable in (proc.stdin, getattr(proc, "_transport", None)):
        try:
            closable.close()
        except Exception:
            pass


async def maybe_unload_idle() -> bool:
    """유휴 워커 회수. GET /warmup이 부른다(local LLM과 같은 기회주의 훅).

    in-flight 가드는 `_lock.locked()` 하나로 충분하다 — 합성 요청은 전부 그
    lock 안에서 돌기 때문에, lock이 잡혀 있으면 아직 쓰는 중이다.
    """
    if COSYVOICE_IDLE_UNLOAD_MIN <= 0 or _proc is None or _lock.locked():
        return False
    if time.monotonic() - _last_used < COSYVOICE_IDLE_UNLOAD_MIN * 60:
        return False
    await kill()
    print(f"[TTS] cosyvoice worker released after {COSYVOICE_IDLE_UNLOAD_MIN}min idle")
    return True


# ── 합성 ────────────────────────────────────────────────────────────────────

def split_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """문장 경계로 자르고 limit 이하로 다시 묶는다. 청크당 타임아웃을 위한 분할."""
    text = (text or "").strip()
    if not text:
        return []
    sentences = [s for s in re.findall(r"[^.!?。！？\n]+[.!?。！？]*", text) if s.strip()]
    chunks: list[str] = []
    for sentence in sentences:
        sentence = sentence.strip()
        while len(sentence) > limit:  # 종결부호 없는 장문 — 하드 컷
            chunks.append(sentence[:limit])
            sentence = sentence[limit:]
        if not sentence:
            continue
        if chunks and len(chunks[-1]) + 1 + len(sentence) <= limit:
            chunks[-1] = f"{chunks[-1]} {sentence}"
        else:
            chunks.append(sentence)
    return chunks or [text[:limit]]


async def synthesize(text: str, prompt_wav: Path, prompt_text: str = "") -> tuple[bytes, str]:
    """(wav bytes, "audio/wav"). 실패는 전부 예외 — 호출자가 기본 체인으로 폴백."""
    global _last_used

    chunks = split_text(text)
    if not chunks:
        raise RuntimeError("cosyvoice: empty text")

    async with _lock:
        await _ensure_worker()
        parts = []
        try:
            for chunk in chunks:
                parts.append(await _request(chunk, prompt_wav, prompt_text))
        finally:
            # 실패해도 다음 요청이 "방금 썼다"고 보게 — 유휴 판정은 마지막 시도 기준.
            _last_used = time.monotonic()
    return _join(parts), "audio/wav"


async def _request(text: str, prompt_wav: Path, prompt_text: str) -> bytes:
    req_id = uuid.uuid4().hex[:12]
    line = json.dumps({
        "id": req_id,
        "text": text,
        "prompt_wav": str(prompt_wav),
        "prompt_text": prompt_text or "",
    }, ensure_ascii=False) + "\n"

    _proc.stdin.write(line.encode("utf-8"))
    await _proc.stdin.drain()

    try:
        raw = await asyncio.wait_for(_proc.stdout.readline(), timeout=CHUNK_TIMEOUT_SEC)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        await kill()
        raise RuntimeError(f"cosyvoice chunk timeout ({CHUNK_TIMEOUT_SEC}s)")

    payload = _parse_line(raw)
    if payload is None:
        # stdout 오염(라이브러리 로그가 새어나옴) 또는 워커 사망. 스트림이 어긋난
        # 상태로 다음 요청을 보내면 응답이 계속 밀리므로 재스폰한다.
        await kill()
        raise RuntimeError("cosyvoice: unparseable worker output")
    if payload.get("id") != req_id:
        await kill()
        raise RuntimeError(f"cosyvoice: response id mismatch ({payload.get('id')!r})")
    if payload.get("error"):
        raise RuntimeError(f"cosyvoice: {payload['error']}")

    wav_path = Path(payload.get("wav_path") or "")
    try:
        return wav_path.read_bytes()
    finally:
        wav_path.unlink(missing_ok=True)


def _join(parts: list[bytes]) -> bytes:
    if len(parts) == 1:
        return parts[0]
    import numpy as np
    import soundfile as sf

    decoded = [sf.read(io.BytesIO(part), dtype="float32") for part in parts]
    buffer = io.BytesIO()
    sf.write(
        buffer,
        np.concatenate([data for data, _ in decoded]),
        decoded[0][1],
        format="WAV",
        subtype="PCM_16",
    )
    return buffer.getvalue()
