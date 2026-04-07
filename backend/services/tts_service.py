"""
services/tts_service.py
TTS 서비스 - 단계별 구현
Phase 1: pyttsx3 (설치 간단, 즉시 동작)
Phase 3: RVC v2 커스텀 보이스로 교체 예정
"""
import io
import asyncio
import soundfile as sf
import numpy as np


class TTSService:
    def __init__(self):
        self.engine_type = "none"
        self._init_engine()

    def _init_engine(self):
        # 1순위: pyttsx3 (오프라인, 설치 쉬움)
        try:
            import pyttsx3
            self._pyttsx3 = pyttsx3.init()
            self._pyttsx3.setProperty('rate', 180)
            # 한국어 음성 찾기
            voices = self._pyttsx3.getProperty('voices')
            for v in voices:
                if 'korean' in v.name.lower() or 'ko' in v.id.lower():
                    self._pyttsx3.setProperty('voice', v.id)
                    break
            self.engine_type = "pyttsx3"
            print("[TTS] pyttsx3 초기화 완료")
            return
        except Exception as e:
            print(f"[TTS] pyttsx3 실패: {e}")

        # 2순위: 무음 반환 (TTS 없어도 채팅은 동작)
        self.engine_type = "silent"
        print("[TTS] 무음 모드 (TTS 엔진 없음)")

    async def synthesize(self, text: str, voice_id: str = None) -> bytes:
        """
        텍스트 → WAV bytes 반환
        voice_id가 있으면 RVC 모델 적용 (Phase 3)
        """
        if self.engine_type == "pyttsx3":
            return await asyncio.get_event_loop().run_in_executor(
                None, self._synthesize_pyttsx3, text
            )

        # 무음 WAV 반환 (44100Hz, 0.5초)
        return self._silent_wav(0.5)

    def _synthesize_pyttsx3(self, text: str) -> bytes:
        """pyttsx3로 TTS → WAV bytes"""
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            tmp_path = f.name

        try:
            self._pyttsx3.save_to_file(text, tmp_path)
            self._pyttsx3.runAndWait()
            with open(tmp_path, 'rb') as f:
                return f.read()
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def _silent_wav(self, duration: float = 0.5) -> bytes:
        """무음 WAV 생성"""
        sample_rate = 22050
        samples = np.zeros(int(sample_rate * duration), dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, samples, sample_rate, format='WAV')
        return buf.getvalue()
