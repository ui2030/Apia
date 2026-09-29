"""
발화 직전 텍스트 정화 + 운율(prosody) 추정.

말풍선에 뜨는 원문과 **입으로 나가는 문장은 다르다.** 이모지·마크다운·URL을
그대로 TTS에 넘기면 "웃는 얼굴 이모지", "별표 별표", "에이치 티 티 피 에스"를
또박또박 읽어 이입이 깨진다. 그렇다고 지워버리면 그 안에 있던 감정 정보까지
같이 버리는 셈이라, 이모지·ㅋㅋ는 **지우되 운율로 흡수한다** —
소리에서는 빼고, 그 정보를 Edge-TTS의 rate/pitch로 옮긴다.

순수 함수만 둔다(네트워크·엔진 없음). 호출자는 TTSService.synthesize 하나.
"""

import re

# ── 이모지/픽토그램 ──────────────────────────────────────────────────────────
# ponytail: `regex` 모듈의 \p{Extended_Pictographic}이 정확하지만 의존성이
# 하나 늘어난다. 실제로 쓰이는 블록만 손으로 적으면 stdlib `re`로 끝난다.
# 빠진 코드포인트가 발음되기 시작하면 여기 범위를 늘리면 된다.
_EMOJI_RANGES = (
    "\U0001F000-\U0001FAFF"  # 이모지 본체(감정·사물·국기·기호 확장)
    "\U00002600-\U000027BF"  # 기타 기호 + 딩뱃(☀ ✨ ✅ ❤ …)
    "\U00002B00-\U00002BFF"  # 화살표/도형 확장(⬆ ⭐ …)
    "\U0001F1E6-\U0001F1FF"  # 국기 regional indicator
    "\U0000FE00-\U0000FE0F"  # variation selector(️)
    "\U0000200D"             # ZWJ (👩‍💻 같은 결합 이모지)
    "\U000020E3"             # keycap combining
    "\U00002190-\U000021FF"  # 화살표
    "\U00002300-\U000023FF"  # ⌚ ⏰ …
    "\U000025A0-\U000025FF"  # ▪ ◼ …
    "™ℹⓂ〰〽㊗㊙©®"
)
_EMOJI = re.compile(f"[{_EMOJI_RANGES}]+")

# 텍스트 이모티콘 — ^^ :) ;-) T_T 등. 앞뒤가 문자면 건드리지 않게 경계를 둔다.
_KAOMOJI = re.compile(r"(?<![0-9A-Za-z가-힣])[:;=][-^oO*']?[)(DPp/\\|3]+(?![0-9A-Za-z가-힣])")
_CARET_SMILE = re.compile(r"\^[_\-\s]*\^|[Tt][_\-][Tt]|[;:]_[;:]")

# 웃음/울음 의성어. 발음하지 않고 운율로 흡수한다(ㅋㅋ→"크크"는 조잡함).
_LAUGH = re.compile(r"[ㅋㅎ]{2,}|[ㅠㅜ]{2,}|[ㅡ]{2,}")

# 한글에서 멈춘다 — 파이썬 \w와 \S는 한글도 먹어서 "a@b.com으로"의 조사까지
# 삼키고, 그러면 읽을 말이 사라진다. TLD는 ASCII 알파벳으로 못박는다.
_URL = re.compile(r"(?:https?://|www\.)[^\s가-힣]+|[\w.+-]+@[\w-]+\.[A-Za-z]{2,}")

# 마크다운. 기호만 걷어내고 안쪽 글자는 남긴다 — 강조된 낱말도 말은 해야 한다.
_CODE_FENCE = re.compile(r"```[\s\S]*?```")
_MD_INLINE = re.compile(r"(\*\*|__|~~|`)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")          # [글자](링크) → 글자
_MD_LINE_LEAD = re.compile(r"^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+", re.MULTILINE)
_MD_HR = re.compile(r"^[ \t]*(?:[-*_][ \t]*){3,}$", re.MULTILINE)
_EMOTION_TAG = re.compile(r"\s*\[EMOTION:\w+\]\s*", re.IGNORECASE)

# 남은 장식 기호 뭉치. 한국어 문장부호(. , ? ! … ~)는 억양에 쓰이니 보존한다.
_SPECIAL_RUN = re.compile(r"[#*_~`^<>{}\[\]|\\/+=@$%&]{1,}")
_PUNCT_RUN = re.compile(r"([!?.,])\1{1,}")
_WS = re.compile(r"[ \t]{2,}")


def sanitize(text: str) -> str:
    """TTS로 보낼 문장. 소리로 갈 때만 쓴다 — 말풍선 원문은 건드리지 않는다."""
    s = str(text or "")
    s = _EMOTION_TAG.sub(" ", s)
    s = _CODE_FENCE.sub(" ", s)
    s = _MD_LINK.sub(r"\1", s)
    s = _URL.sub(" ", s)
    s = _EMOJI.sub(" ", s)
    s = _KAOMOJI.sub(" ", s)
    s = _CARET_SMILE.sub(" ", s)
    s = _LAUGH.sub(" ", s)
    s = _MD_HR.sub(" ", s)
    s = _MD_LINE_LEAD.sub("", s)
    s = _MD_INLINE.sub("", s)
    s = _SPECIAL_RUN.sub(" ", s)
    s = _PUNCT_RUN.sub(r"\1", s)          # "정말???" → "정말?"
    s = _WS.sub(" ", s)
    # 빈 줄 정리 + 기호만 남은 줄 제거.
    lines = [line.strip() for line in s.splitlines()]
    lines = [line for line in lines if re.search(r"[0-9A-Za-z가-힣]", line)]
    return "\n".join(lines).strip()


# ── 운율 ─────────────────────────────────────────────────────────────────────
# 버킷 5개. 과장하면 성우 흉내가 아니라 만화 더빙이 된다 — 실청취로 정한
# ±5~12% 범위 안에서만 움직인다. pitch는 edge-tts 계약상 Hz 오프셋이고
# 한국어 여성 음성 F0가 대략 200Hz라 15Hz ≈ 7%다.
#
# 튜닝 레버: 이 표 하나만 고치면 전 경로에 반영된다.
PROSODY = {
    "happy":     ("+6%", "+15Hz"),
    "surprised": ("+10%", "+22Hz"),
    "sad":       ("-8%", "-15Hz"),
    "angry":     ("+5%", "-8Hz"),
    "neutral":   ("+0%", "+0Hz"),
}
# relaxed(차분)는 neutral보다 살짝 느리게. 그 외 미지의 라벨은 neutral.
PROSODY["relaxed"] = ("-5%", "+0Hz")

_BUCKETS = set(PROSODY)


def estimate_bucket(text: str, emotion: str | None = None) -> str:
    """발화 한 건의 감정 버킷.

    1순위는 응답에 이미 붙는 [EMOTION:...] 라벨. 라벨이 없거나 neutral일 때만
    **정화 전 원문의** 단서(ㅋㅋ 밀도·느낌표·말줄임·이모지 계열)로 보정한다.
    단서는 지워질 문자 안에 있으므로 반드시 sanitize 전에 부른다.
    """
    label = str(emotion or "").strip().lower()
    if label in _BUCKETS and label != "neutral":
        return label

    raw = str(text or "")
    if re.search(r"[ㅠㅜ]{2,}", raw) or re.search(r"[\U0001F622\U0001F62D\U0001F614\U0001F61E]", raw):
        return "sad"
    # ㅋㅋ/ㅎㅎ 2회 이상 또는 4글자 이상 한 덩이 = 확실한 웃음.
    laughs = re.findall(r"[ㅋㅎ]{2,}", raw)
    if len(laughs) >= 2 or any(len(m) >= 4 for m in laughs):
        return "happy"
    if re.search(r"[!?]{2,}|[\U0001F62E\U0001F632\U0001F631]", raw):
        return "surprised"
    if laughs or re.search(r"[\U0001F600-\U0001F60F\U0001F970\U0001F929]", raw):
        return "happy"
    if raw.count("…") >= 1 or re.search(r"\.{3,}", raw):
        return "relaxed"
    return label if label in _BUCKETS else "neutral"


def prosody_for(bucket: str) -> tuple[str, str]:
    """버킷 → (rate, pitch). edge-tts Communicate가 그대로 받는 문자열."""
    return PROSODY.get(str(bucket or "").lower(), PROSODY["neutral"])


def speech_plan(text: str, emotion: str | None = None) -> tuple[str, str, str]:
    """(정화된 문장, rate, pitch). TTSService.synthesize 진입부 한 줄용."""
    bucket = estimate_bucket(text, emotion)
    rate, pitch = prosody_for(bucket)
    return sanitize(text), rate, pitch


if __name__ == "__main__":  # 자가 점검
    assert sanitize("안녕하세요 😊 **반가워요**!") == "안녕하세요 반가워요!"
    assert sanitize("ㅋㅋㅋ 웃기다") == "웃기다"
    assert sanitize("여기 https://a.b/c 봐") == "여기 봐"
    assert estimate_bucket("ㅋㅋㅋㅋ 진짜?") == "happy"
    assert estimate_bucket("그랬구나", "sad") == "sad"
    print("speech_text self-check ok")
