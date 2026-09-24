"""교재 변환 라우터 + 교사 비용 가드.

여기서 지키는 계약은 두 개다.
  1. 비용 가드: 그날 지출이 상한에 닿으면 HTTP를 아예 쏘지 않는다.
  2. status 계약: 카드가 실제로 나온 경우에만 "ok". 나머지는 cards=None —
     클라이언트가 원본 버퍼를 지우는 조건이 status=="ok" 하나뿐이기 때문이다.
"""
from __future__ import annotations

import json
import threading

import pytest

from services import teacher_service


@pytest.fixture(autouse=True)
def _clear_ledger_guard(monkeypatch):
    # fail-closed 플래그는 모듈 전역이다. 한 테스트가 세운 걸 다음 테스트가
    # 물려받으면 엉뚱한 곳에서 TeacherUnavailable이 난다.
    monkeypatch.setattr(teacher_service, "_ledger_broken", None)


@pytest.fixture()
def usage_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key-not-real")
    return tmp_path


def _write_usage(path, day, usd):
    (path / "teacher_usage.json").write_text(
        json.dumps({day: {"calls": 1, "in_hit": 0, "in_miss": 0, "out": 0, "usd": usd}}),
        encoding="utf-8",
    )


# ── 비용 가드 ───────────────────────────────────────────────────────────────

def test_budget_reached_blocks_call_before_http(usage_dir, monkeypatch):
    _write_usage(usage_dir, teacher_service._today(), teacher_service.DAILY_BUDGET_USD)

    def _boom(*_a, **_k):  # urlopen이 불리면 가드가 새는 것
        raise AssertionError("budget guard did not fire")

    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", _boom)
    with pytest.raises(teacher_service.TeacherUnavailable) as caught:
        teacher_service.ask_json("sys", "user")
    assert "budget" in str(caught.value)


def test_budget_is_per_day_not_cumulative(usage_dir, monkeypatch):
    _write_usage(usage_dir, "1999-01-01", 99.0)  # 옛날에 많이 썼어도 오늘은 새 예산
    monkeypatch.setattr(
        teacher_service.urllib.request, "urlopen", lambda *_a, **_k: _FakeResponse()
    )
    parsed, spent = teacher_service.ask_json("sys", "user")
    assert parsed == {"cards": []}
    assert spent < teacher_service.DAILY_BUDGET_USD


def test_missing_key_is_unavailable_not_failure(usage_dir, monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(teacher_service.TeacherUnavailable):
        teacher_service.ask_json("sys", "user")


def test_usage_accumulates_and_prunes_to_seven_days(usage_dir):
    usage = {f"2026-09-{d:02d}": {"usd": 0.001} for d in range(1, 12)}
    (usage_dir / "teacher_usage.json").write_text(json.dumps(usage), encoding="utf-8")
    teacher_service._record(teacher_service._load_usage(), hit=1000, miss=2000, out=500)
    kept = json.loads((usage_dir / "teacher_usage.json").read_text(encoding="utf-8"))
    assert len(kept) == 7
    today = teacher_service._today()
    assert today in kept
    expected = (1000 * 0.07 + 2000 * 0.27 + 500 * 1.10) / 1e6
    assert kept[today]["usd"] == pytest.approx(expected)


def test_http_error_never_leaks_the_key(usage_dir, monkeypatch):
    import urllib.error

    def _raise(*_a, **_k):
        raise urllib.error.HTTPError("https://x/chat/completions", 401, "Unauthorized", {}, None)

    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", _raise)
    with pytest.raises(teacher_service.TeacherFailed) as caught:
        teacher_service.ask_json("sys", "user")
    assert str(caught.value) == "HTTP 401"
    assert "test-key-not-real" not in str(caught.value)


# ── 경쟁·fail-closed (회귀) ────────────────────────────────────────────────

def test_concurrent_calls_cannot_both_pass_the_budget(usage_dir, monkeypatch):
    """확인과 기록 사이가 열려 있으면 두 호출이 같은 잔액을 보고 함께 통과한다."""
    # 한 번 더 쓰면 상한을 넘는 잔액으로 시작한다.
    _write_usage(usage_dir, teacher_service._today(), teacher_service.DAILY_BUDGET_USD - 1e-9)

    calls = []

    def _slow(*_a, **_k):
        calls.append(1)
        # 락이 없으면 두 스레드가 이 구간에서 겹쳐 둘 다 HTTP를 쏜다.
        threading.Event().wait(0.05)
        return _FakeResponse()

    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", _slow)

    results = []

    def _run():
        try:
            teacher_service.ask_json("sys", "user")
            results.append("ok")
        except teacher_service.TeacherUnavailable:
            results.append("blocked")

    threads = [threading.Thread(target=_run) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sorted(results) == ["blocked", "ok"]
    assert len(calls) == 1  # 상한을 넘긴 두 번째 호출은 HTTP까지 가지 않았다


def test_unreadable_ledger_refuses_the_call(usage_dir, monkeypatch):
    (usage_dir / "teacher_usage.json").write_text("{ 깨진 장부", encoding="utf-8")

    def _boom(*_a, **_k):
        raise AssertionError("ledger unreadable but the call went out anyway")

    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", _boom)
    with pytest.raises(teacher_service.TeacherUnavailable) as caught:
        teacher_service.ask_json("sys", "user")
    assert "ledger" in str(caught.value)


def test_missing_ledger_is_not_broken_just_empty(usage_dir, monkeypatch):
    """파일이 없는 건 정상(첫 실행). 못 읽는 것과 뭉개면 상한이 사라진다."""
    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", lambda *_a, **_k: _FakeResponse())
    parsed, spent = teacher_service.ask_json("sys", "user")
    assert parsed == {"cards": []}
    assert spent > 0


def test_ledger_write_failure_blocks_every_later_call(usage_dir, monkeypatch):
    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", lambda *_a, **_k: _FakeResponse())

    def _no_write(*_a, **_k):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(teacher_service, "_save_usage", _no_write)
    # 첫 호출은 이미 돈을 썼으므로 결과는 돌려준다.
    parsed, _spent = teacher_service.ask_json("sys", "user")
    assert parsed == {"cards": []}
    assert teacher_service._ledger_broken

    # 그 다음부터는 막는다 — 적히지 않는 지출이 쌓이게 두지 않는다.
    monkeypatch.setattr(
        teacher_service.urllib.request, "urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not call after ledger break")),
    )
    with pytest.raises(teacher_service.TeacherUnavailable):
        teacher_service.ask_json("sys", "user")


def test_broken_ledger_surfaces_as_deferred_not_failed(client, monkeypatch):
    from routers import courseware as router_mod

    def _unavailable(*_a, **_k):
        raise teacher_service.TeacherUnavailable("usage ledger unavailable: write failed (OSError)")

    monkeypatch.setattr(router_mod.teacher_service, "ask_json", _unavailable)
    body = client.post("/courseware/convert", json=_payload()).json()
    assert body["status"] == "deferred"  # 연기 = 원본 보존
    assert body["cards"] is None


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return json.dumps({
            "choices": [{"message": {"content": json.dumps({"cards": []})}}],
            "usage": {"prompt_cache_hit_tokens": 10, "prompt_cache_miss_tokens": 20, "completion_tokens": 5},
        }).encode("utf-8")


# ── status 계약 ─────────────────────────────────────────────────────────────

@pytest.fixture()
def patched_teacher(monkeypatch):
    from routers import courseware as router_mod

    def _install(fn):
        monkeypatch.setattr(router_mod.teacher_service, "ask_json", fn)

    return _install


def _payload():
    return {"day": "2026-09-01", "exchanges": [{"u": "커피 두 잔 마셨어", "a": "줄여봐요"}]}


def test_convert_ok_returns_cards(client, patched_teacher):
    patched_teacher(lambda *_a, **_k: ({"cards": [{"u": "q", "a": "a"}]}, 0.004))
    body = client.post("/courseware/convert", json=_payload()).json()
    assert body["status"] == "ok"
    assert body["cards"] == [{"u": "q", "a": "a"}]
    assert body["spent_today"] == pytest.approx(0.004)
    assert body["budget_usd"] == pytest.approx(0.07)


def test_convert_unavailable_is_deferred_without_cards(client, patched_teacher):
    def _unavailable(*_a, **_k):
        raise teacher_service.TeacherUnavailable("no DEEPSEEK_API_KEY")

    patched_teacher(_unavailable)
    body = client.post("/courseware/convert", json=_payload()).json()
    assert body["status"] == "deferred"
    assert body["cards"] is None


def test_convert_failure_is_failed_without_cards(client, patched_teacher):
    def _failed(*_a, **_k):
        raise teacher_service.TeacherFailed("HTTP 500")

    patched_teacher(_failed)
    body = client.post("/courseware/convert", json=_payload()).json()
    assert body["status"] == "failed"
    assert body["cards"] is None


def test_convert_rejects_non_card_output(client, patched_teacher):
    patched_teacher(lambda *_a, **_k: ({"answer": "엉뚱한 모양"}, 0.001))
    body = client.post("/courseware/convert", json=_payload()).json()
    assert body["status"] == "failed"
    assert body["cards"] is None


def test_empty_exchanges_never_calls_the_teacher(client, patched_teacher):
    def _boom(*_a, **_k):
        raise AssertionError("teacher should not be called")

    patched_teacher(_boom)
    body = client.post("/courseware/convert", json={"day": "2026-09-01", "exchanges": []}).json()
    assert body == {
        "status": "ok",
        "cards": [],
        "reason": None,
        "budget_usd": pytest.approx(0.07),
        "spent_today": pytest.approx(body["spent_today"]),
        "spend_7d": pytest.approx(body["spend_7d"]),
    }


def test_prompt_carries_the_anonymization_instruction():
    from routers.courseware import BOOK_SYSTEM

    assert "익명화" in BOOK_SYSTEM
    assert "실명" in BOOK_SYSTEM
    assert "취향" in BOOK_SYSTEM  # 사실·취향은 보존해야 교재가 쓸모 있다
