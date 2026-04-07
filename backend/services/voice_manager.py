"""
services/voice_manager.py
목소리 모델 관리 + RVC v2 학습
"""
import os
import uuid
import json
import asyncio
import shutil
from pathlib import Path
from datetime import datetime


DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
VOICES_DIR = DATA_DIR / "voices"
UPLOADS_DIR = DATA_DIR / "uploads"

VOICES_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# 학습 진행률 저장 (job_id → progress)
_training_jobs: dict = {}


class VoiceManager:

    def list_voices(self) -> list:
        """저장된 목소리 모델 목록"""
        voices = []
        for voice_dir in sorted(VOICES_DIR.iterdir()):
            config_path = voice_dir / "config.json"
            if config_path.exists():
                with open(config_path) as f:
                    config = json.load(f)
                voices.append({
                    "id": voice_dir.name,
                    "name": config.get("name", voice_dir.name),
                    "created_at": config.get("created_at", ""),
                    "has_preview": (voice_dir / "preview.wav").exists()
                })
        return voices

    async def start_training(self, file, name: str) -> str:
        """WAV 업로드 → 학습 시작 (백그라운드)"""
        job_id = str(uuid.uuid4())[:8]
        voice_id = f"voice_{job_id}"

        # 파일 저장
        upload_path = UPLOADS_DIR / f"{job_id}.wav"
        content = await file.read()
        with open(upload_path, 'wb') as f:
            f.write(content)

        # 진행률 초기화
        _training_jobs[job_id] = {"status": "preparing", "progress": 0, "voice_id": voice_id}

        # 백그라운드 학습 시작
        asyncio.create_task(self._train(job_id, voice_id, name, upload_path))

        return job_id

    async def _train(self, job_id: str, voice_id: str, name: str, wav_path: Path):
        """RVC v2 학습 파이프라인"""
        voice_dir = VOICES_DIR / voice_id
        voice_dir.mkdir(exist_ok=True)

        try:
            _training_jobs[job_id]["status"] = "preprocessing"
            _training_jobs[job_id]["progress"] = 10

            # Phase 1: 전처리 (노이즈 제거, 샘플레이트 통일)
            await self._preprocess_audio(wav_path, voice_dir)
            _training_jobs[job_id]["progress"] = 30

            # Phase 2: RVC 학습 (GPU 가속)
            _training_jobs[job_id]["status"] = "training"
            await self._run_rvc_training(voice_dir, job_id)

            # Phase 3: 미리듣기 샘플 생성
            _training_jobs[job_id]["status"] = "generating_preview"
            _training_jobs[job_id]["progress"] = 90
            await self._generate_preview(voice_dir)

            # 완료
            config = {
                "name": name,
                "created_at": datetime.now().isoformat(),
                "voice_id": voice_id
            }
            with open(voice_dir / "config.json", 'w') as f:
                json.dump(config, f, ensure_ascii=False, indent=2)

            _training_jobs[job_id]["status"] = "done"
            _training_jobs[job_id]["progress"] = 100
            print(f"[Voice] 학습 완료: {name} ({voice_id})")

        except Exception as e:
            _training_jobs[job_id]["status"] = "error"
            _training_jobs[job_id]["error"] = str(e)
            print(f"[Voice] 학습 오류: {e}")

    async def _preprocess_audio(self, wav_path: Path, output_dir: Path):
        """오디오 전처리: 22050Hz 모노 변환, 묵음 제거"""
        import soundfile as sf
        import numpy as np

        data, sr = sf.read(str(wav_path))

        # 모노 변환
        if len(data.shape) > 1:
            data = data.mean(axis=1)

        # 22050Hz 리샘플링 (필요시)
        if sr != 22050:
            try:
                import resampy
                data = resampy.resample(data, sr, 22050)
            except ImportError:
                pass  # 리샘플 없이 진행

        processed_path = output_dir / "processed.wav"
        sf.write(str(processed_path), data, 22050)

    async def _run_rvc_training(self, voice_dir: Path, job_id: str):
        """
        RVC v2 학습 실행
        TODO: 실제 RVC 서브모듈 연동
        현재는 더미 진행률 시뮬레이션
        """
        for i in range(30, 90, 10):
            await asyncio.sleep(2)  # 실제 학습은 10~30분 소요
            _training_jobs[job_id]["progress"] = i

        # 더미 모델 파일 생성 (실제론 RVC가 생성)
        (voice_dir / "model.pth").touch()

    async def _generate_preview(self, voice_dir: Path):
        """미리듣기 샘플 생성 (학습된 모델로 TTS 1회 실행)"""
        import soundfile as sf
        import numpy as np

        # 더미 미리듣기 (실제론 RVC로 변환)
        sample_rate = 22050
        duration = 2.0
        t = np.linspace(0, duration, int(sample_rate * duration))
        # 간단한 톤 (실제론 "안녕하세요" TTS 결과)
        audio = np.sin(2 * np.pi * 440 * t) * 0.3
        sf.write(str(voice_dir / "preview.wav"), audio, sample_rate)

    def get_progress(self, job_id: str) -> dict:
        return _training_jobs.get(job_id, {"status": "not_found", "progress": 0})

    def get_preview_path(self, voice_id: str) -> Path:
        return VOICES_DIR / voice_id / "preview.wav"

    def delete_voice(self, voice_id: str):
        voice_dir = VOICES_DIR / voice_id
        if voice_dir.exists():
            shutil.rmtree(voice_dir)
