"""
routers/warmup.py - 명시적 AI provider 워밍업 엔드포인트.

claude_service의 provider init이 lazy로 바뀐 뒤, 첫 /chat 요청이 init 비용을 전부
떠안게 됐다 (local 모드에서는 HF 모델 다운로드/로딩으로 30s 프론트 타임아웃을 넘길 수도
있음). 프론트가 시작 직후 이 엔드포인트를 한 번 치면 백그라운드에서 provider가 미리
초기화되고, 첫 /chat 호출 시점엔 캐시된 mode가 그대로 재사용된다.

같은 흐름으로 voice.py의 TTSService/VoiceManager, stt.py의 WhisperService도 lazy다 —
pyttsx3 init은 OS에 따라 무겁고 whisper.load_model('small')은 ~500MB라 워밍업 시
함께 prime한다.

POST /warmup : 비동기로 워밍업 시작. 이미 ready면 즉시 ready 반환, 워밍 중이면 warming.
GET  /warmup : 현재 initialized_modes / 활성 mode / warming 여부 조회.
"""
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Request

from routers import stt, voice
from routers.chat import claude
from schemas import WarmupPostResponse, WarmupStatusResponse

router = APIRouter()
_log = logging.getLogger(__name__)
_warm_task: Optional[asyncio.Task] = None
_last_error: Optional[str] = None


def _resolve_target_mode(mode: str) -> str:
    if mode == "auto":
        return claude.select_auto_mode()
    return mode


async def _prime_all_services() -> None:
    # voice/stt.prime()은 독립이고 둘 중 하나가 실패해도 다른 쪽 + 나머지 warmup
    # 흐름은 살아남아야 한다. return_exceptions=True로 sibling 취소를 막고, 실패한
    # prime은 로깅만 한 뒤 흘려보낸다 — 진짜 깨졌다면 첫 사용 시점에 다시 시도된다.
    results = await asyncio.gather(voice.prime(), stt.prime(), return_exceptions=True)
    for name, result in zip(("voice", "stt"), results):
        if isinstance(result, BaseException):
            _log.warning("%s.prime() failed during warmup", name, exc_info=result)


async def _run_warmup(mode: str) -> None:
    # provider init 직렬화는 ClaudeService.ensure_mode가 자체 _init_lock으로 처리한다
    # (chat 핸들러도 같은 lock에 들어와 race가 닫힌다). 라우터에서 추가 lock을 잡으면
    # voice/stt prime이 같이 묶여 contention만 늘기 때문에 여기선 안 잡는다.
    if not claude.is_mode_initialized(mode):
        await claude.ensure_mode(mode)
    await _prime_all_services()


def _on_warm_done(task: asyncio.Task) -> None:
    # asyncio.create_task의 예외는 task.exception()을 읽지 않으면 garbage
    # collection 시점에 "Task exception was never retrieved"로만 노출된다.
    # done callback에서 명시적으로 소비하고 GET /warmup으로 노출한다.
    global _last_error
    if task.cancelled():
        _last_error = "cancelled"
        return
    exc = task.exception()
    if exc is None:
        _last_error = None
        return
    _last_error = f"{type(exc).__name__}: {exc}"
    _log.exception("warmup failed", exc_info=exc)


def _is_warming() -> bool:
    return _warm_task is not None and not _warm_task.done()


@router.post("", response_model=WarmupPostResponse)
async def warmup():
    global _warm_task, _last_error
    target = _resolve_target_mode(claude.default_mode)

    if claude.is_mode_initialized(target) and not _is_warming():
        # claude mode는 준비됨. 나머지 deferred service도 prime 보장 — 멱등이라
        # 첫 호출 후엔 거의 무료. 한쪽이 실패해도 다른 쪽 + 호출자 응답에 영향 없게
        # return_exceptions=True.
        await _prime_all_services()
        return {"status": "ready", "mode": claude.mode}

    if not _is_warming():
        # readiness 체크는 resolved target에 대해 했으니 백그라운드 init도 그 mode에
        # 커밋한다. requested("auto") 그대로 넘기면 readiness 체크와 실제 init이
        # 다른 mode를 가리키는 TOCTOU 갭이 생긴다.
        _last_error = None  # 재시도 진행 중에는 이전 실패를 노출하지 않는다
        _warm_task = asyncio.create_task(_run_warmup(target))
        _warm_task.add_done_callback(_on_warm_done)

    return {"status": "warming", "mode": target}


def _merge_last_error() -> Optional[str]:
    """Stringify the two error sources with provenance prefix. Router-level
    task error (warmup gather/asyncio failures) is preferred when present
    because it represents the most recent in-flight failure; the provider
    init error is the latent state surfaced when no task is in flight."""
    if _last_error is not None:
        return f"[warmup] {_last_error}"
    init_error = claude.get_last_init_error()
    if init_error is not None:
        return f"[init:{init_error['mode']}] {init_error['message']}"
    return None


@router.get("", response_model=WarmupStatusResponse)
async def warmup_status(request: Request):
    auto_target = claude.resolve_auto_target()
    available = claude.list_available_modes()
    # Aggregate invariant assertion — auto_target must be in available_modes
    # when set. If this fires, the service drifted; router-side check fails
    # fast so the contract test catches the regression.
    assert auto_target is None or auto_target in available, (
        f"auto_target={auto_target!r} not in available_modes={available!r}"
    )

    # Step 2-4 services: read live state from app.state so settings UI shows
    # the actually-wired status, not the env var snapshot. `getattr` so old
    # tests that don't run the full lifespan still pass with None payload.
    memory_service = getattr(request.app.state, "memory", None)
    files_service = getattr(request.app.state, "files", None)
    web_service = getattr(request.app.state, "web", None)

    return {
        "initialized_modes": claude.list_initialized_modes(),
        "available_modes": available,
        "auto_target": auto_target,
        "mode": claude.mode,
        "default_mode": claude.default_mode,
        "warming": _is_warming(),
        "last_error": _merge_last_error(),
        "memory_enabled": (
            bool(memory_service.enabled) if memory_service is not None else None
        ),
        "files_enabled": (
            bool(files_service.enabled) if files_service is not None else None
        ),
        "web_enabled": (
            bool(web_service.enabled) if web_service is not None else None
        ),
        "web_provider": (
            web_service.provider if web_service is not None else None
        ),
    }
