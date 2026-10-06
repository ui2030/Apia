"""
services/whisper_service.py
Whisper STT - 로컬 음성 인식
"""
import io
import tempfile
import os
import asyncio


class WhisperService:
    def __init__(self):
        self.model = None
        self._load_model()

    def _load_model(self):
        try:
            import whisper
            # small 모델: 한국어 인식 우수, VRAM ~500MB
            # medium 으로 올리면 더 정확하지만 느림
            self.model = whisper.load_model("small")
            print("[Whisper] 모델 로드 완료 (small)")
        except Exception as e:
            print(f"[Whisper] 모델 로드 실패: {e}")
            print("[Whisper] 'pip install openai-whisper' 로 설치하세요")

    async def transcribe(self, audio_bytes: bytes) -> str:
        if self.model is None:
            # 빈 문자열 — 안내문을 전사 결과로 돌려주면 그 문장이 채팅으로 전송된다(거짓 입력).
            print("[STT] whisper model not loaded — pip install openai-whisper")
            return ""

        return await asyncio.get_event_loop().run_in_executor(
            None, self._do_transcribe, audio_bytes
        )

    def _do_transcribe(self, audio_bytes: bytes) -> str:
        # 파일 경로를 넘기면 whisper가 ffmpeg 실행 파일을 부른다 — 사용자 PC엔 ffmpeg가
        # 없어 마이크 전사가 통째로 실패했다(2026-10-07 발견). 마이크 WAV는 PCM이라
        # soundfile로 직접 디코드하고 16kHz 모노 float32 배열을 넘긴다(ffmpeg 불필요).
        import io
        import numpy as np
        import soundfile as sf
        import soxr

        try:
            data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
            if getattr(data, "ndim", 1) > 1:
                data = data.mean(axis=1)
            if sr != 16000:
                data = soxr.resample(data, sr, 16000)
            if len(data) < 1600:  # 0.1초 미만 — 전사할 것이 없다
                return ""
            result = self.model.transcribe(np.ascontiguousarray(data, dtype=np.float32), language='ko')
            return result['text'].strip()
        except Exception as error:  # noqa: BLE001 — 깨진 업로드가 500이 되면 안 된다
            print(f"[STT] transcribe failed: {type(error).__name__}")
            return ""
