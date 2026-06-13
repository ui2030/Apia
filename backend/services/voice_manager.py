"""
services/voice_manager.py — 캐릭터 음성(복제용 참조) 관리.

"학습"이 아니라 제로샷 **복제 준비**다: 업로드된 음성을 검증·저장하고,
seed-vc 모델을 준비시키고, 미리듣기를 만들어 둔다. 이름이 train인 것은
기존 라우터 계약(/voices/train/{job_id}) 호환 때문 — UI 문구는 "음성
복제 준비 중"을 쓴다.

진행률 게이지 계약 (설정 UI가 1초 폴링):
  preparing(5) → validating(10) → loading_model(20~70, 첫 회 체크포인트
  다운로드 포함) → generating_preview(80~95) → done(100) / error

상태는 메모리 dict + 디스크(voice_dir/status.json) 이중 기록. 단일
uvicorn 프로세스 전제(백엔드는 reload/multi-worker 없이 뜬다 — electron
backendLifecycle이 단일 자식으로 spawn). 재시작하면 진행 중이던 job은
유실되고 get_progress가 not_found를 주며, 완료된 음성(config.json 존재)
만 목록에 살아남는다. 미완성 디렉터리는 에러 시 즉시 정리.

공개 id 계약: 디렉터리명은 voice_xxxxxxxx, 외부 노출 id는
custom:voice_xxxxxxxx. prefix strip·검증은 라우터가 하고 이 모듈은 raw
디렉터리명만 받는다 (경로 탈출 방지 validate_voice_dir 제공).
"""
import asyncio
import io
import json
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
VOICES_DIR = DATA_DIR / "voices"
UPLOADS_DIR = DATA_DIR / "uploads"

VOICES_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# 참조 음성 길이 제한 — 너무 짧으면 음색 추출 품질이 나쁘고, 너무 길면
# 업로드/변환만 무거워진다 (제로샷은 1분이면 충분).
MIN_REF_SEC = 5.0
MAX_REF_SEC = 120.0

PREVIEW_TEXT = "안녕하세요! 저는 아피아예요. 이게 제 새 목소리랍니다."

_VOICE_DIR_RE = re.compile(r"^voice_[0-9a-f]{8}$")

# job_id → {"status", "progress", "voice_id", "error"?}
_training_jobs: dict = {}
_active_job_id: str | None = None


def validate_voice_dir(name: str) -> bool:
    """라우터가 custom: prefix를 벗긴 뒤 디렉터리명 검증에 쓴다."""
    return bool(_VOICE_DIR_RE.match(name or ""))


class VoiceManager:

    def list_voices(self) -> list:
        """복제 준비가 끝난(config.json 있는) 음성 목록. raw 디렉터리명 id."""
        voices = []
        for voice_dir in sorted(VOICES_DIR.iterdir()):
            # 구식/외부 명명 디렉터리는 목록에서 제외 — 노출되면 선택은
            # 되는데 preview/DELETE/TTS의 id 검증이 거부하는 모순이 생긴다
            # (Codex MUST-FIX). 새 파이프라인 산출물만 voice_xxxxxxxx.
            if not validate_voice_dir(voice_dir.name):
                continue
            config_path = voice_dir / "config.json"
            if not config_path.exists():
                continue
            try:
                with open(config_path, encoding="utf-8") as f:
                    config = json.load(f)
            except Exception:
                continue
            voices.append({
                "id": voice_dir.name,
                "name": config.get("name", voice_dir.name),
                "created_at": config.get("created_at", ""),
                "has_preview": (voice_dir / "preview.wav").exists(),
            })
        return voices

    async def start_training(self, file, name: str, tts_service=None) -> str:
        """업로드 → 복제 준비 시작 (백그라운드). job_id 반환.

        tts_service는 미리듣기 합성용(Edge) — 라우터가 공유 인스턴스를
        주입한다 (순환 import 회피).
        """
        global _active_job_id
        if _active_job_id and _training_jobs.get(_active_job_id, {}).get("status") not in ("done", "error"):
            raise RuntimeError("이미 진행 중인 음성 준비가 있어요. 끝난 뒤 다시 시도해 주세요.")

        from services import voice_clone_service as clone

        if not clone.is_available():
            raise RuntimeError("이 PC에서는 음성 복제 기능을 사용할 수 없어요 (seed-vc 미설치).")

        job_id = uuid.uuid4().hex[:8]
        voice_id = f"voice_{job_id}"

        upload_path = UPLOADS_DIR / f"{job_id}.wav"
        content = await file.read()
        with open(upload_path, "wb") as f:
            f.write(content)

        _training_jobs[job_id] = {"status": "preparing", "progress": 5, "voice_id": voice_id}
        _active_job_id = job_id

        asyncio.create_task(self._train(job_id, voice_id, name, upload_path, tts_service))
        return job_id

    def _set_progress(self, job_id: str, voice_dir: Path, status: str, progress: int, error: str | None = None):
        job = _training_jobs.setdefault(job_id, {})
        job["status"] = status
        job["progress"] = progress
        if error is not None:
            job["error"] = error
        try:
            voice_dir.mkdir(exist_ok=True)
            with open(voice_dir / "status.json", "w", encoding="utf-8") as f:
                json.dump(job, f, ensure_ascii=False)
        except Exception:
            pass  # 디스크 기록은 best-effort — 폴링은 메모리를 본다

    async def _train(self, job_id: str, voice_id: str, name: str, wav_path: Path, tts_service):
        """복제 준비 파이프라인. 실패 시 미완성 디렉터리 정리."""
        global _active_job_id
        from services import voice_clone_service as clone

        voice_dir = VOICES_DIR / voice_id
        try:
            # ① 업로드 검증·정규화 (렌더러가 22.05k mono WAV로 보내는 게
            # 계약이지만, 백엔드도 디코드+길이를 직접 검증한다)
            self._set_progress(job_id, voice_dir, "validating", 10)
            duration = await asyncio.to_thread(self._validate_reference, wav_path, voice_dir)
            print(f"[Voice] reference ok: {duration:.1f}s")

            # ② 모델 준비 (첫 회 체크포인트 다운로드 — 가장 긴 구간)
            self._set_progress(job_id, voice_dir, "loading_model", 20)
            await clone.ensure_loaded()
            self._set_progress(job_id, voice_dir, "loading_model", 70)

            # ③ 미리듣기 생성 — Edge 인사말을 캐릭터 음색으로 변환.
            # 이 단계가 곧 통합 헬스체크다: 여기서 성공하면 채팅 TTS 경로도
            # 동작한다 (같은 코드 경로).
            self._set_progress(job_id, voice_dir, "generating_preview", 80)
            if tts_service is not None:
                base_audio, base_mime = await tts_service.synthesize_base(PREVIEW_TEXT)
                preview_wav = await clone.convert(base_audio, base_mime, voice_dir / "reference.wav")
                with open(voice_dir / "preview.wav", "wb") as f:
                    f.write(preview_wav)
            self._set_progress(job_id, voice_dir, "generating_preview", 95)

            # ④ 완료 도장 — config.json이 생겨야 목록에 노출된다
            config = {
                "schema_version": 2,
                "engine": "seed-vc",
                "name": name,
                "created_at": datetime.now().isoformat(),
                "voice_id": voice_id,
                "reference_sec": round(duration, 1),
            }
            with open(voice_dir / "config.json", "w", encoding="utf-8") as f:
                json.dump(config, f, ensure_ascii=False, indent=2)

            self._set_progress(job_id, voice_dir, "done", 100)
            print(f"[Voice] 복제 준비 완료: {name} ({voice_id})")
        except Exception as e:
            print(f"[Voice] 복제 준비 실패: {e}")
            self._set_progress(job_id, voice_dir, "error", 0, error=str(e))
            shutil.rmtree(voice_dir, ignore_errors=True)
        finally:
            if _active_job_id == job_id:
                _active_job_id = None
            if wav_path.exists():
                wav_path.unlink(missing_ok=True)

    def _validate_reference(self, wav_path: Path, voice_dir: Path) -> float:
        """업로드 WAV 디코드·길이 검증 후 reference.wav로 저장. 길이(초) 반환."""
        import soundfile as sf

        try:
            data, sr = sf.read(str(wav_path), dtype="float32")
        except Exception as error:
            raise RuntimeError(f"음성 파일을 읽을 수 없어요 (WAV 필요): {error}")

        if getattr(data, "ndim", 1) > 1:
            data = data.mean(axis=1)

        duration = len(data) / float(sr)
        if duration < MIN_REF_SEC:
            raise RuntimeError(f"음성이 너무 짧아요 ({duration:.1f}초). {MIN_REF_SEC:.0f}초 이상 필요해요.")
        if duration > MAX_REF_SEC:
            # 자르지 않고 거부 — 어떤 구간을 쓸지는 사용자가 정하는 게 맞다
            raise RuntimeError(f"음성이 너무 길어요 ({duration:.0f}초). {MAX_REF_SEC:.0f}초 이하로 잘라 주세요.")

        voice_dir.mkdir(exist_ok=True)
        buffer = io.BytesIO()
        sf.write(buffer, data, sr, format="WAV", subtype="PCM_16")
        with open(voice_dir / "reference.wav", "wb") as f:
            f.write(buffer.getvalue())
        return duration

    def get_progress(self, job_id: str) -> dict:
        return _training_jobs.get(job_id, {"status": "not_found", "progress": 0})

    def get_reference_path(self, voice_id: str) -> Path:
        return VOICES_DIR / voice_id / "reference.wav"

    def get_preview_path(self, voice_id: str) -> Path:
        return VOICES_DIR / voice_id / "preview.wav"

    def delete_voice(self, voice_id: str):
        voice_dir = VOICES_DIR / voice_id
        if voice_dir.exists():
            shutil.rmtree(voice_dir)
