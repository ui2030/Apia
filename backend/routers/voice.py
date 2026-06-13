"""
routers/voice.py - 목소리 모델 관리.

TTSService / VoiceManager는 lazy로 인스턴스화한다. pyttsx3 init이 OS에 따라 cold
start에서 무시 못할 비용을 내는 사례가 있고, ClaudeService에서 같은 패턴으로
모듈 import-time init을 제거한 결정과 일관성을 맞추기 위해서다.

동시 첫 요청에서 같은 서비스를 두 번 생성하지 않도록 asyncio.Lock으로 보호하고,
init이 동기/블로킹이므로 asyncio.to_thread로 이벤트 루프에서 떼어낸다. warmup
라우터가 prime()을 호출하면 첫 /voices 요청 전에 미리 인스턴스화된다.

`get_tts()`는 tts.py도 import해서 공유한다 — 라우터마다 별도 인스턴스를 만들면
pyttsx3 init이 라우터 수만큼 반복되고, 음성 선택 상태도 라우터 사이에 분기된다.
"""
import asyncio

from fastapi import APIRouter, UploadFile, File, Form, BackgroundTasks
from fastapi.responses import FileResponse

from schemas import VoicesResponse

router = APIRouter()
_tts = None
_vm = None
_tts_lock = asyncio.Lock()
_vm_lock = asyncio.Lock()


async def get_tts():
    global _tts
    if _tts is not None:
        return _tts
    async with _tts_lock:
        if _tts is None:
            from services.tts_service import TTSService

            _tts = await asyncio.to_thread(TTSService)
    return _tts


async def get_vm():
    global _vm
    if _vm is not None:
        return _vm
    async with _vm_lock:
        if _vm is None:
            from services.voice_manager import VoiceManager

            _vm = await asyncio.to_thread(VoiceManager)
    return _vm


async def prime() -> None:
    """warmup 라우터에서 호출. 첫 /voices 요청 전에 TTS/VM을 미리 인스턴스화한다."""
    await get_tts()
    vm = await get_vm()
    # 복제 음성이 하나라도 있으면 모델을 백그라운드로 선로딩 — 사용자가
    # custom 음성을 적용해둔 채 앱을 켰을 때 첫 발화가 폴백되지 않게.
    from services import voice_clone_service as clone

    if vm.list_voices() and clone.is_available() and not clone.is_loaded():
        asyncio.ensure_future(clone.ensure_loaded())


def _clone_available() -> bool:
    from services import voice_clone_service as clone

    return clone.is_available()


def _strip_custom_id(voice_id: str) -> str:
    """공개 id 'custom:voice_xxxx' → raw 디렉터리명. 검증 실패 시 404.

    custom: prefix 계약은 여기(라우터)서 끝낸다 — VoiceManager는 raw
    디렉터리명만 받고, 정규식 검증이 경로 탈출을 막는다.
    """
    from fastapi import HTTPException
    from services.voice_manager import validate_voice_dir

    # 공개 계약은 custom:<dir> 엄격 — raw 디렉터리명 직접 호출도 404.
    if not voice_id.startswith("custom:"):
        raise HTTPException(status_code=404, detail="없는 음성이에요")
    raw = voice_id[len("custom:"):]
    if not validate_voice_dir(raw):
        raise HTTPException(status_code=404, detail="없는 음성이에요")
    return raw


@router.get("", response_model=VoicesResponse)
async def list_voices():
    tts = await get_tts()
    vm = await get_vm()
    custom = [
        {
            "id": f"custom:{v['id']}",
            "name": f"{v['name']} (복제 음성)",
            "source": "custom",
            "has_preview": v.get("has_preview", False),
        }
        for v in vm.list_voices()
    ]
    if _clone_available():
        # 정렬: edge(기본 후보) → custom(명시 적용 대상) → system
        engine_voices = tts.list_voices()
        edge = [v for v in engine_voices if v.get("source") == "edge"]
        rest = [v for v in engine_voices if v.get("source") != "edge"]
        return {
            "voices": edge + custom + rest,
            "unsupported_custom_voices": [],
        }
    # seed-vc 비가용(패키징 exe 등) — custom은 선택 불가 목록으로 강등
    return {
        "voices": tts.list_voices(),
        "unsupported_custom_voices": custom,
    }


@router.post("/upload")
async def upload_voice(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    name: str = Form(...)
):
    """음성 파일 업로드 → 복제 준비 시작 (게이지는 /voices/train/{job_id} 폴링)"""
    from fastapi import HTTPException

    vm = await get_vm()
    tts = await get_tts()
    try:
        job_id = await vm.start_training(file, name, tts_service=tts)
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error))
    return {"job_id": job_id, "message": f"'{name}' 음성 복제 준비를 시작했어요!"}


@router.get("/train/{job_id}")
async def training_progress(job_id: str):
    """학습 진행률 조회"""
    vm = await get_vm()
    return vm.get_progress(job_id)


@router.get("/{voice_id}/preview")
async def preview_voice(voice_id: str):
    """미리듣기 오디오 반환. id는 custom:<dir> 계약."""
    from fastapi import HTTPException

    vm = await get_vm()
    path = vm.get_preview_path(_strip_custom_id(voice_id))
    if path and path.exists():
        return FileResponse(path, media_type="audio/wav")
    raise HTTPException(status_code=404, detail="미리듣기 파일이 없어요")


@router.delete("/{voice_id}")
async def delete_voice(voice_id: str):
    vm = await get_vm()
    vm.delete_voice(_strip_custom_id(voice_id))
    return {"ok": True}
