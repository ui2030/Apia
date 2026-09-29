"""services/speech_text — 발화 정화 + 운율 추정.

규칙별로 한 건씩. 한국어 문장이 멀쩡히 살아남는지가 가장 중요한 단언이다
(정화가 과하면 말을 못 하게 된다).
"""
import pytest

from services import speech_text as st


# ── 정화 ────────────────────────────────────────────────────────────────

def test_emoji_is_dropped():
    assert st.sanitize("반가워요 😊🎉") == "반가워요"


def test_zwj_emoji_sequence_is_dropped():
    assert st.sanitize("저는 👩‍💻 개발자예요") == "저는 개발자예요"


def test_markdown_symbols_go_but_words_stay():
    assert st.sanitize("**아주** 중요한 `코드`예요") == "아주 중요한 코드예요"


def test_heading_and_bullet_markers_go():
    assert st.sanitize("# 제목\n- 첫째\n2. 둘째") == "제목\n첫째\n둘째"


def test_markdown_link_keeps_label_only():
    assert st.sanitize("[여기](https://a.b/c)를 봐") == "여기를 봐"


def test_bare_url_and_email_go():
    assert st.sanitize("https://example.com/x 참고, a@b.com으로") == "참고, 으로"


def test_code_fence_is_dropped_whole():
    assert st.sanitize("이거예요\n```py\nprint(1)\n```\n끝") == "이거예요\n끝"


def test_laughter_is_not_pronounced():
    assert st.sanitize("ㅋㅋㅋ 진짜 웃겨요 ㅎㅎ") == "진짜 웃겨요"


def test_crying_onomatopoeia_is_not_pronounced():
    assert st.sanitize("망했어요 ㅠㅠ") == "망했어요"


def test_text_emoticons_go():
    assert st.sanitize("좋아요 ^^ :) 정말") == "좋아요 정말"


def test_repeated_punctuation_collapses():
    assert st.sanitize("정말?? 대박!!!") == "정말? 대박!"


def test_emotion_tag_leftover_is_dropped():
    assert st.sanitize("안녕하세요 [EMOTION:happy]") == "안녕하세요"


def test_emoji_only_reply_becomes_empty():
    # 읽을 게 없으면 침묵해야 한다 — TTSService가 무음 wav로 처리한다.
    assert st.sanitize("😊😊😊") == ""


@pytest.mark.parametrize("sentence", [
    "오늘 날씨가 참 좋네요. 산책이라도 하실래요?",
    "3시 30분에 회의가 있어요 — 잊지 마세요!",
    "그 파일은 C 드라이브에 있어요.",
    "네, 알겠어요… 조금만 기다려 주세요.",
])
def test_korean_sentences_survive_untouched(sentence):
    assert st.sanitize(sentence) == sentence


def test_no_crash_on_none_or_empty():
    assert st.sanitize(None) == ""
    assert st.sanitize("") == ""


# ── 운율 ────────────────────────────────────────────────────────────────

def test_emotion_label_wins_over_text_cues():
    # ㅋㅋ가 있어도 라벨이 sad면 sad다(라벨이 1순위).
    assert st.estimate_bucket("ㅋㅋㅋ 아니야", "sad") == "sad"


def test_unknown_label_falls_through_to_text_cues():
    assert st.estimate_bucket("ㅋㅋㅋㅋ 웃겨", "excited") == "happy"


def test_laughter_density_reads_as_happy():
    assert st.estimate_bucket("ㅎㅎ 그래 ㅎㅎ") == "happy"
    assert st.estimate_bucket("ㅋㅋㅋㅋ") == "happy"


def test_crying_reads_as_sad():
    assert st.estimate_bucket("힘들어 ㅠㅠ") == "sad"


def test_double_bang_reads_as_surprised():
    assert st.estimate_bucket("진짜?!") == "surprised"


def test_ellipsis_reads_as_relaxed():
    assert st.estimate_bucket("음… 그렇구나") == "relaxed"


def test_plain_sentence_is_neutral():
    assert st.estimate_bucket("네 알겠어요.") == "neutral"


def test_prosody_directions_are_sane():
    happy_rate, happy_pitch = st.prosody_for("happy")
    sad_rate, sad_pitch = st.prosody_for("sad")
    assert happy_rate.startswith("+") and happy_pitch.startswith("+")
    assert sad_rate.startswith("-") and sad_pitch.startswith("-")
    assert st.prosody_for("neutral") == ("+0%", "+0Hz")
    # 알 수 없는 버킷은 중립 — 엉뚱한 톤으로 말하지 않는다.
    assert st.prosody_for("wat") == ("+0%", "+0Hz")


def test_prosody_stays_within_gentle_range():
    # 과장 금지 — 속도 ±12%, 피치 ±25Hz 안.
    for rate, pitch in st.PROSODY.values():
        assert abs(int(rate.rstrip("%"))) <= 12, rate
        assert abs(int(pitch.rstrip("Hz"))) <= 25, pitch


def test_speech_plan_sanitizes_and_maps_together():
    clean, rate, pitch = st.speech_plan("ㅋㅋㅋ 대박 **진짜**야 😂")
    assert clean == "대박 진짜야"
    assert (rate, pitch) == st.PROSODY["happy"]
