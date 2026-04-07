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
            return "(Whisper 모델이 로드되지 않았어요. pip install openai-whisper 를 실행하세요)"

        return await asyncio.get_event_loop().run_in_executor(
            None, self._do_transcribe, audio_bytes
        )

    def _do_transcribe(self, audio_bytes: bytes) -> str:
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name
        try:
            result = self.model.transcribe(tmp_path, language='ko')
            return result['text'].strip()
        finally:
            os.unlink(tmp_path)
