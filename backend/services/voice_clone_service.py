"""
제로샷 음색 변환 (voice cloning) — seed-vc 래퍼.

파이프라인: Edge-TTS(선히)가 발음·억양을 만들고, seed-vc가 음색만 참조
음성(캐릭터 목소리)으로 교체한다. 학습이 필요 없어 업로드 후 바로 쓸 수
있다("즉시 복제형"). RVC 학습형은 2차 후보.

설계 계약 (Codex 사전 검토 반영):
  - 디코더는 soundfile 하나로 고정 (내장 libsndfile 1.2가 mp3 디코드 지원
    — ffmpeg 의존 없음). is_available()은 import뿐 아니라 실제 mp3 디코드
    헬스체크(아래 _MP3_SAMPLE)까지 통과해야 True.
  - seed-vc 미설치(패키징 exe 등)면 custom 음성 기능 전체가 조용히
    비활성화된다. /tts custom 경로는 Edge 원음 폴백 + fallback 플래그로
    "복제 음성이 적용되지 않았음"을 정직하게 알린다.
  - GPU 변환은 _convert_lock으로 직렬화 (VRAM 공유), 모델 로드는
    _load_lock으로 1회 보장.
  - 모델 로드(첫 회 HuggingFace 체크포인트 다운로드 포함)는 업로드
    파이프라인/워밍업에서 선행 — 채팅 TTS 경로에서 cold-load 금지.

엔진 어댑터: seed_vc.seed_vc_wrapper.SeedVCWrapper.convert_voice(source,
target) — 파일 경로 입력. yield문이 있어 stream_output=False여도 제너레이터
가 반환되며, 결과 파형은 StopIteration.value로 나온다 (소스 확인 완료).
출력 샘플레이트는 v1 비-f0 경로 고정값 22050 (통합 테스트로 검증).
"""

import asyncio
import base64
import io
import os
import tempfile
import threading

_load_lock = threading.Lock()
_convert_lock = threading.Lock()
_loaded = False
_load_error: str | None = None
_health_checked: bool | None = None

OUTPUT_SR = 22050  # seed-vc v1 (f0_condition=False) bigvgan 출력 샘플레이트
DIFFUSION_STEPS = 10  # 품질/지연 균형 — wrapper 기본값과 동일


def _import_engine():
    """seed-vc import. 실패 시 예외 전파.

    anaconda 환경에서 torch가 OpenMP 런타임 중복(libiomp5md)으로 즉사하는
    문제가 있어 import 전에 회피 플래그를 깔아준다 (인텔 공식 워크어라운드).
    """
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    import seed_vc  # noqa: F401


def is_available() -> bool:
    """seed-vc가 import되고 mp3 디코드 헬스체크를 통과하는가. 결과 캐시."""
    global _health_checked
    if _health_checked is not None:
        return _health_checked
    try:
        _import_engine()
        decode_audio(base64.b64decode(_MP3_SAMPLE_B64), "audio/mpeg")
        _health_checked = True
    except Exception as error:
        print(f"[VoiceClone] unavailable: {error}")
        _health_checked = False
    return _health_checked


def is_loaded() -> bool:
    return _loaded


def decode_audio(data: bytes, mime: str):
    """bytes → (float32 mono ndarray, sample_rate). 디코더는 soundfile 고정."""
    import soundfile as sf

    samples, sr = sf.read(io.BytesIO(data), dtype="float32")
    if getattr(samples, "ndim", 1) > 1:
        samples = samples.mean(axis=1)
    return samples, int(sr)


def encode_wav(samples, sr: int) -> bytes:
    """float32 mono ndarray → WAV bytes."""
    import soundfile as sf

    buffer = io.BytesIO()
    sf.write(buffer, samples, sr, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


async def ensure_loaded(progress_cb=None) -> None:
    """모델 로드 (첫 회 체크포인트 다운로드 포함, 수십 초~수 분). idempotent."""
    if _loaded:
        return
    await asyncio.to_thread(_load_blocking, progress_cb)


def _load_blocking(progress_cb=None) -> None:
    global _loaded, _load_error
    with _load_lock:
        if _loaded:
            return
        try:
            if progress_cb:
                progress_cb("loading_model")
            _engine_load()
            _loaded = True
            _load_error = None
            print("[VoiceClone] model loaded")
        except Exception as error:
            _load_error = str(error)
            raise


async def convert(audio: bytes, mime: str, reference_wav_path) -> bytes:
    """오디오(bytes)를 참조 음성의 음색으로 변환해 WAV bytes 반환.

    호출 전 ensure_loaded 선행 필수 (TTS 경로는 wait_for로 감싼다).
    변환 실패는 예외 전파 — 폴백 결정은 호출자 몫.
    """
    return await asyncio.to_thread(
        _convert_blocking, audio, mime, str(reference_wav_path)
    )


def _convert_blocking(audio: bytes, mime: str, reference_wav_path: str) -> bytes:
    if not _loaded:
        raise RuntimeError("voice clone model not loaded")
    with _convert_lock:
        return _engine_convert(audio, mime, reference_wav_path)


# ── seed-vc 엔진 어댑터 ──────────────────────────────────────────────────
# 패키지 API와의 유일한 결합 지점. 엔진 교체(RVC 등) 시 아래 두 함수만
# 갈아끼운다.

_engine = None


def _patch_bigvgan_hub_compat() -> None:
    """seed-vc 내장 BigVGAN과 신버전 huggingface_hub 호환 패치.

    hub의 ModelHubMixin.from_pretrained가 더 이상 proxies/resume_download를
    _from_pretrained에 넘기지 않는데, BigVGAN._from_pretrained는 이를 필수
    키워드 인자로 요구해 TypeError가 난다. 누락 시 None을 채워준다.
    """
    from seed_vc.modules.bigvgan import bigvgan as bigvgan_module

    cls = bigvgan_module.BigVGAN
    if getattr(cls, "_apia_hub_patched", False):
        return
    original = cls._from_pretrained.__func__

    def patched(klass, *args, **kwargs):
        kwargs.setdefault("proxies", None)
        kwargs.setdefault("resume_download", None)
        return original(klass, *args, **kwargs)

    cls._from_pretrained = classmethod(patched)
    cls._apia_hub_patched = True


def _engine_load() -> None:
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    _patch_bigvgan_hub_compat()
    from seed_vc.seed_vc_wrapper import SeedVCWrapper

    global _engine
    _engine = SeedVCWrapper()


def _engine_convert(audio: bytes, mime: str, reference_wav_path: str) -> bytes:
    # convert_voice는 파일 경로를 받으므로 소스를 임시 WAV로 내린다.
    # (mp3를 그대로 넘기지 않는 이유: 내부 librosa 경로의 포맷 의존을
    # 우리 디코더(soundfile)로 일원화하기 위해 — Codex MUST-FIX)
    samples, sr = decode_audio(audio, mime)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            tmp_path = handle.name
        with open(tmp_path, "wb") as f:
            f.write(encode_wav(samples, sr))

        generator = _engine.convert_voice(
            tmp_path,
            reference_wav_path,
            diffusion_steps=DIFFUSION_STEPS,
            stream_output=False,
        )
        # stream_output=False면 yield 없이 끝나고 결과는 StopIteration.value
        result = None
        try:
            while True:
                next(generator)
        except StopIteration as stop:
            result = stop.value
        if result is None or len(result) == 0:
            raise RuntimeError("seed-vc returned empty audio")
        return encode_wav(result, OUTPUT_SR)
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)


# 헬스체크용 실제 Edge-TTS mp3 앞부분 (1440B, 24kHz 48kbps 6프레임 무손상
# 디코드 확인 완료). 내용은 무관 — libsndfile의 mpeg 디코더 존재 검증용.
_MP3_SAMPLE_B64 = (
    "//NkxAAAAANIAAAAAExBTUVVVVVMQU1FCiASJAWFAwgiujRtro2zwghsCE8SubmlNCdyrmiU458Qq514AEHAz3d+JypT/0TQQlDizj/vwIIi"
    "IXEriNz/T8t3/rmhe+7ABe7x30QvdK5+if/5yooGaFXj9MIX1P93PdzielACd/0Q4iJu5/u/xHc0RE6ifoTi//NkxHwAAANIAAAAAOn+7mji"
    "2gABb6rM0BGSzahFIjQMCoMsJH1lrJdNNDLZpNCgRIEtZKGhlmTKFhEiO9BqSCcm0OKrKzFWikyoW0zSyTRGSWVTMtQnSjeB7ZikuyikfkuU"
    "VUlM2XaNoC8rI1SMlG0b7nJ8c2adMomMjtPZUOpEGkxYGZGS5ETd41JhC6LI//NkxPsfxB4E1EiGZbDrDVECISFUJubGqvhjYpULaqnJ82hs"
    "PI04TioenrrSgTx8yazELKowyYRNoyKCtCpVGuMxRmi6PDzTyNFNvBEF1kAYiSIILoC5MhVKIHGjyQYUKYhWSo+YOqEiN8/5QNOzACGBSH9B"
    "tsofChKK0bZG89SorzGhRBdltRRi3TigYtx5//NkxP817DoNdHpSAJ714oWFmMnDTGNqsHUmo+UHWZIchCamLFkFl/4CDtSSMo4FXKIfU1bW"
    "Y2DEapKck5I/CmEb3Qcymlc780TMyFDKb4pqh44zjSsa0yvTde55XrYMTqWEiayFJtB3zq1uXNkSbEZKQX7E4JtIYy8VFEFRz182lEk0/GuH"
    "kmMcvc2EoJtQ//NkxKowJDoQCs4SAGSFmWnTSVH4oiBE0Vs4cfkdTOxNEykaCR/jYiDnyi3jRXMirvRp/o1K6WzUvd+/vLGvY597FztRdT4V"
    "yfPh29PKUFsSKhqNCZfqqUOUuXQVlIhzNWVjUfPsE2m9zNu/VBzLd9DzhmRn+aSZtb5vw3xbXJylOXVo85qxvKeTAs8MULPo//NkxGwgg0Yo"
    "S1oYAc18VJ9dBUDTFb/Eb+KTdMf0F/rjfvsABg4KCLGqBoiHsEL0BktDKftyirDrvzur2dSBFi0tVRgNKBEOnHU53jAdwDAGIWYfhh6GrB7P"
    "j/RvBx1a9vvY8/lbIJ557N1S5qEdqueee0sOIynJxzXTdsUjs7Z9qhimeRLx/rPoMqqfCLo6//NkxG0ujDooTZpYADs3Myfg+aZyDQmPmuz/"
    "O2zRm+D/n7qIehV7LWUrOxbWTNtcjcXFtlzzt8SqbQ9NBZj0c/FObMubX22VVauYnb2eRXcsy5o78XbOt7TsVahmtRmKxqNjsNDqtWAB/nGr"
    "DkulrVRiENqEq+OjC+4fjpG0OAdhYELl04Ux9hq8ZMuB0hAD//NkxDUpctbaX4+IAnFmE6fLiwxoIAGCBoEOBaCqIgbm5ohk+buhk+xeKY5p"
    "A0KkKBACck+6ZoOWIqIUGGSZBTJBN36bpl8+kRQnCXSdOZJOT3dakmyYPMmbkQW9BlGZiaFYxQMEnpLar3flw0TTdN77etG1BBZ8qLOkbzZl"
    "ZejG243INX1RJ0eU5R3D5EBH//NkxBIhab7eH89gAhBGZWRdjoT2e2391hpjXdet+PxzU6zYFda+ZLHDpDicfPVkTDdIsZ5ufqn9K5Sp0cjX"
    "ANJUXE87iL4lQlZcIc0um7LPd8wfS1ugnH5BoJAqfe5roaaEJ0qEBoSJMSonrjiBkPjGJcr///+Xrqrwu8gfsORyYWi3r23JtnezqMd5nxYE"
    "//NkxA8gIrLaNsMK0owvwwYkhlZ0k487t5MJT2mhKAlVXUJVd2PXd9Srf2STk+mSr21JFnceolyJmbTQuUpmQwY6lZ9Gt6syGdku1JmS45Ts"
    "90dqkfIdnUzuNdTpEiV1M3XjL0R8SPKixtn6E0s/8ffUWJpZrWUODBUBuB9xmgOA0EBjn+3lVcI5xYAkN9KZ"
)
