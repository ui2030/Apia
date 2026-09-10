"""
TTS service. Engine priority: edge-tts (neural, network) → pyttsx3 (offline) → silent.

edge-tts는 Microsoft Edge의 신경망 음성을 무료·키 없이 쓰는 라이브러리다.
네트워크가 필요하므로 합성 실패 시 같은 요청 안에서 pyttsx3로 폴백한다 —
오프라인에서도 입은 움직여야 한다(완성 기준 ⑤는 품질, ①~④는 생존).

synthesize()는 (bytes, mime)을 반환한다. mime은 라우터가 Content-Type으로
흘리고, electron IPC → 렌더러 Blob type까지 그대로 전달된다.

**모든 경로가 wav("audio/wav")로 나간다.** edge-tts는 mp3를 주지만 렌더러가
mp3를 디코드하지 못한다 — lipsyncRuntime.isWavBuffer가 mp3를 거부하기 때문
(decodeAudioData에 mp3를 넘기면 일부 Windows에서 렌더러가 네이티브 크래시).
거부되면 비짐 타임라인이 null이 되어 립싱크가 사인파 입뻐끔 폴백으로 떨어진다.
그래서 여기서 wav로 디코드해 내보낸다(_mp3_to_wav). libsndfile에 mp3 디코드가
없는 환경에서는 mp3 그대로 나가고 립싱크만 폴백한다 — 발화는 항상 산다.
"""

import asyncio
import io
import threading

# 정적 큐레이션 — edge_tts.list_voices()는 네트워크 호출이라 /voices 콜드패스에
# 두지 않는다. 한국어 신경망 음성 3종이면 선택지로 충분하고, id 스킴
# "edge:<ShortName>"이라 추가는 한 줄이다.
EDGE_VOICES = [
    {"id": "edge:ko-KR-SunHiNeural", "name": "선히 (한국어 여성, 자연스러움)", "source": "edge"},
    {"id": "edge:ko-KR-InJoonNeural", "name": "인준 (한국어 남성)", "source": "edge"},
    {"id": "edge:ko-KR-HyunsuMultilingualNeural", "name": "현수 (한국어 남성, 다국어)", "source": "edge"},
]
DEFAULT_EDGE_VOICE = "ko-KR-SunHiNeural"
EDGE_TIMEOUT_SEC = 15  # electron IPC 타임아웃(30s)의 절반 — 폴백 합성 시간 확보
CLONE_TIMEOUT_SEC = 20  # 음색 변환 상한 — 초과 시 기본 음성 폴백 (발화 생존)


class TTSService:
    # None=미확인, True/False=libsndfile mp3 디코드 가능 여부(정적 특성이라 캐시).
    # 클래스 속성으로 둬서 __new__로 만든 인스턴스(테스트)도 기본값을 갖는다.
    _mp3_decode_ok = None

    def __init__(self):
        self.engine_type = "none"
        self._engine_lock = threading.Lock()
        self._available_voices = []
        self._edge_available = False
        self._init_engine()

    def _init_engine(self):
        # edge와 pyttsx3는 배타가 아니다 — edge가 1순위 엔진이어도 pyttsx3는
        # 오프라인 폴백 + system: 음성 목록 공급자로 항상 함께 초기화한다.
        try:
            import edge_tts  # noqa: F401

            self._edge_available = True
            print("[TTS] edge-tts available")
        except Exception as error:
            print(f"[TTS] edge-tts unavailable: {error}")

        try:
            import pyttsx3

            self._pyttsx3 = pyttsx3.init()
            self._pyttsx3.setProperty("rate", 180)

            voices = self._pyttsx3.getProperty("voices")
            self._available_voices = [
                {
                    "id": f"system:{voice.id}",
                    "name": getattr(voice, "name", voice.id),
                    "source": "system",
                }
                for voice in voices
            ]

            for voice in voices:
                name = getattr(voice, "name", "")
                if "korean" in name.lower() or "ko" in voice.id.lower():
                    self._pyttsx3.setProperty("voice", voice.id)
                    break

            self.engine_type = "pyttsx3"
            print("[TTS] pyttsx3 initialized")
        except Exception as error:
            print(f"[TTS] pyttsx3 init failed: {error}")
            if self.engine_type == "none":
                self.engine_type = "silent"
            self._available_voices = []
            print("[TTS] silent fallback enabled")

        if self._edge_available:
            self.engine_type = "edge"

    def list_voices(self) -> list:
        # edge 우선 노출 — 프런트 loadVoices()는 저장된 voiceId가 없으면
        # voices[0]을 기본으로 잡으므로, 이 순서가 곧 신규 사용자의 기본
        # 음성이다. 기존 저장된 system: id는 목록에 남아 있어 존중된다.
        voices = list(EDGE_VOICES) if self._edge_available else []
        voices.extend(self._available_voices)
        return voices

    def _resolve_system_voice(self, voice_id: str | None) -> str | None:
        if not voice_id or not str(voice_id).startswith("system:"):
            return None
        return str(voice_id)[len("system:"):]

    def _resolve_edge_voice(self, voice_id: str | None) -> str:
        if voice_id and str(voice_id).startswith("edge:"):
            short = str(voice_id)[len("edge:"):]
            if any(v["id"] == voice_id for v in EDGE_VOICES):
                return short
            # 큐레이션 밖 id(옛 설정 잔재 등)는 기본 음성으로 — 합성 단계의
            # 알 수 없는 voice 에러보다 로그 한 줄이 디버깅하기 쉽다.
            print(f"[TTS] unknown edge voice '{voice_id}', using {DEFAULT_EDGE_VOICE}")
        return DEFAULT_EDGE_VOICE

    async def synthesize(
        self, text: str, voice_id: str = None, engine: str = None
    ) -> tuple[bytes, str, bool]:
        """(audio, mime, fallback) — fallback=True는 "요청한 음성이 아닌
        대체 음성으로 말했다"는 뜻 (custom 변환 실패/미준비). 라우터가
        X-Apia-Tts-Fallback 헤더로 흘려 프런트가 정직하게 안내한다."""
        if engine == "cosyvoice":
            return await self._synthesize_cosyvoice(text)
        if voice_id and str(voice_id).startswith("custom:"):
            return await self._synthesize_custom(text, str(voice_id))
        audio, mime = await self.synthesize_base(text, voice_id)
        return audio, mime, False

    async def _synthesize_cosyvoice(self, text: str) -> tuple[bytes, str, bool]:
        """opt-in 엔진. 설정에서 명시 선택한 경우에만 불린다.

        어떤 실패(구성 미비·워커 크래시·타임아웃·비정형 응답)든 기본 체인으로
        폴백하고 fallback=True를 돌려준다 — /tts는 500을 내지 않는다.
        """
        from services import cosyvoice_service as cosy

        error = cosy.config_error()
        if error:
            print(f"[TTS] cosyvoice unavailable: {error}")
            audio, mime = await self.synthesize_base(text)
            return audio, mime, True

        try:
            prompt_wav = await self._ensure_cosyvoice_prompt()
            audio, mime = await cosy.synthesize(
                text, prompt_wav, cosy.prompt_text_for(prompt_wav)
            )
            return audio, mime, False
        except Exception as error:
            print(f"[TTS] cosyvoice failed, falling back: {type(error).__name__}: {error}")
            audio, mime = await self.synthesize_base(text)
            return audio, mime, True

    async def _ensure_cosyvoice_prompt(self):
        """참조(캐릭터) 음성 경로. 없으면 edge 한국어 음성으로 한 번 만들어 캐시한다.

        공개 repo에 음성 파일을 동봉할 수 없어(라이선스) 기본 참조는 로컬 생성이
        유일한 방법이다. edge가 안 되면 참조가 없으므로 엔진도 못 쓴다 → 예외.
        """
        from services import cosyvoice_service as cosy

        existing = cosy.resolve_prompt_wav()
        if existing is not None:
            return existing

        data = await asyncio.wait_for(
            self._synthesize_edge(cosy.DEFAULT_PROMPT_TEXT, DEFAULT_EDGE_VOICE),
            timeout=EDGE_TIMEOUT_SEC,
        )
        wav, mime = await asyncio.to_thread(self._mp3_to_wav, data)
        if mime != "audio/wav":
            raise RuntimeError("cosyvoice: default reference needs wav decode support")

        cosy.DEFAULT_PROMPT_WAV.parent.mkdir(parents=True, exist_ok=True)
        cosy.DEFAULT_PROMPT_WAV.write_bytes(wav)
        # transcript를 아는 참조라 sidecar를 남겨 zero-shot 경로를 쓴다.
        cosy.DEFAULT_PROMPT_WAV.with_suffix(".txt").write_text(
            cosy.DEFAULT_PROMPT_TEXT, encoding="utf-8"
        )
        print(f"[TTS] cosyvoice default reference generated: {cosy.DEFAULT_PROMPT_WAV}")
        return cosy.DEFAULT_PROMPT_WAV

    async def _synthesize_custom(self, text: str, voice_id: str) -> tuple[bytes, str, bool]:
        """custom:<voice_dir> — Edge 합성 후 seed-vc로 음색 변환.

        변환이 불가능한 모든 경우(미설치·참조 없음·모델 미로드·변환 실패)
        에 발화는 살린다: 기본 음성으로 말하되 fallback=True. 모델이 아직
        안 떠 있으면 이번 발화는 폴백하고 로드는 백그라운드로 시작 —
        채팅 첫 응답이 cold-load 수십 초를 기다리게 하지 않는다.
        """
        from services import voice_clone_service as clone
        from services import voice_manager

        dir_id = voice_id[len("custom:"):]
        base_audio, base_mime = await self.synthesize_base(text)

        if not voice_manager.validate_voice_dir(dir_id) or not clone.is_available():
            print(f"[TTS] custom voice unavailable ({voice_id}), fallback")
            return base_audio, base_mime, True

        ref_path = voice_manager.VOICES_DIR / dir_id / "reference.wav"
        if not ref_path.exists():
            print(f"[TTS] custom reference missing ({voice_id}), fallback")
            return base_audio, base_mime, True

        if not clone.is_loaded():
            asyncio.ensure_future(clone.ensure_loaded())
            print(f"[TTS] clone model warming, fallback this utterance ({voice_id})")
            return base_audio, base_mime, True

        try:
            converted = await asyncio.wait_for(
                clone.convert(base_audio, base_mime, ref_path),
                timeout=CLONE_TIMEOUT_SEC,
            )
            return converted, "audio/wav", False
        except Exception as error:
            print(f"[TTS] clone conversion failed, fallback: {error}")
            return base_audio, base_mime, True

    async def synthesize_base(self, text: str, voice_id: str = None) -> tuple[bytes, str]:
        """엔진 우선순위 edge→pyttsx3→silent (custom 변환의 입력이자
        직접 선택 음성의 출력)."""
        wants_system = bool(voice_id) and str(voice_id).startswith("system:")

        if self._edge_available and not wants_system:
            try:
                data = await asyncio.wait_for(
                    self._synthesize_edge(text, self._resolve_edge_voice(voice_id)),
                    timeout=EDGE_TIMEOUT_SEC,
                )
                # 렌더러가 비짐을 뽑으려면 wav여야 한다(모듈 docstring 참조).
                return await asyncio.to_thread(self._mp3_to_wav, data)
            except Exception as error:
                # 오프라인/서비스 오류 — 같은 요청 안에서 pyttsx3로 폴백.
                print(f"[TTS] edge synthesis failed, falling back: {error}")

        if self.engine_type in ("edge", "pyttsx3") and hasattr(self, "_pyttsx3"):
            try:
                wav = await asyncio.to_thread(
                    self._synthesize_pyttsx3,
                    text,
                    voice_id if wants_system else None,
                )
                return wav, "audio/wav"
            except Exception as error:
                # 계약은 edge→pyttsx3→silent — 합성 런타임 실패가 /tts 500이
                # 되면 안 된다 (Codex MUST-FIX).
                print(f"[TTS] pyttsx3 synthesis failed, silent fallback: {error}")

        return self._silent_wav(0.5), "audio/wav"

    def _mp3_to_wav(self, data: bytes) -> tuple[bytes, str]:
        """edge mp3 → wav. 디코더는 voice_clone_service와 공유(soundfile 고정).

        블로킹이라 호출측이 to_thread로 감싼다. mp3 디코드가 불가능한
        libsndfile이면 mp3를 그대로 돌려주고 다음부터는 시도하지 않는다.
        """
        if self._mp3_decode_ok is False:
            return data, "audio/mpeg"
        try:
            from services import voice_clone_service as clone

            samples, sr = clone.decode_audio(data, "audio/mpeg")
            wav = clone.encode_wav(samples, sr)
            self._mp3_decode_ok = True
            return wav, "audio/wav"
        except Exception as error:
            self._mp3_decode_ok = False
            print(f"[TTS] mp3->wav decode unavailable, lipsync falls back: {error}")
            return data, "audio/mpeg"

    async def _synthesize_edge(self, text: str, voice: str) -> bytes:
        import edge_tts

        communicate = edge_tts.Communicate(text, voice)
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        data = b"".join(chunks)
        if not data:
            raise RuntimeError("edge-tts returned no audio")
        return data

    def _synthesize_pyttsx3(self, text: str, voice_id: str = None) -> bytes:
        import os
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            tmp_path = handle.name

        try:
            with self._engine_lock:
                previous_voice = self._pyttsx3.getProperty("voice")
                requested_voice = self._resolve_system_voice(voice_id)

                try:
                    if requested_voice:
                        self._pyttsx3.setProperty("voice", requested_voice)

                    self._pyttsx3.save_to_file(text, tmp_path)
                    self._pyttsx3.runAndWait()
                finally:
                    # runAndWait가 죽어도 다음 요청이 이전 음성으로 돌아가게.
                    if requested_voice:
                        self._pyttsx3.setProperty("voice", previous_voice)

            with open(tmp_path, "rb") as handle:
                return handle.read()
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)

    def _silent_wav(self, duration: float = 0.5) -> bytes:
        # lazy import — 무음 폴백 전용. 모듈 import 시점에 numpy를 요구하면
        # TTS를 스텁하는 테스트 환경까지 무겁게 만든다.
        import numpy as np
        import soundfile as sf

        sample_rate = 22050
        samples = np.zeros(int(sample_rate * duration), dtype=np.float32)
        buffer = io.BytesIO()
        sf.write(buffer, samples, sample_rate, format="WAV")
        return buffer.getvalue()
