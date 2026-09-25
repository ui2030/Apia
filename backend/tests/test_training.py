"""야간 학습기(A-3) 백엔드 표면 — on-policy 교정 + 그림자 모드.

여기서 지키는 계약은 셋이다.
  1. on-policy 교정은 주당 $0.10을 **일일 상한과 함께** 지킨다. 둘 중 하나라도
     닿으면 HTTP를 쏘지 않는다.
  2. 교정 결과가 조금이라도 수상하면(개수 불일치·빈 답) 통째로 버린다 — 밀려
     붙은 교정은 카드와 답을 뒤섞어 델타를 망친다. 학습기는 status!=ok를
     교재 원답 폴백 신호로 쓴다.
  3. 그림자는 **로컬 모델을 올리지 않는다**. 떠 있지 않으면 dormant.
  4. 이 라우터는 토큰 없이는 아무것도 하지 않는다 — 부르는 것만으로 교사 예산과
     GPU가 나가므로, localhost의 다른 프로세스가 대신 쓰게 두면 안 된다.
"""
from __future__ import annotations

import json

import pytest

from services import teacher_service


TOKEN = "test-training-token"


@pytest.fixture(autouse=True)
def _clear_ledger_guard(monkeypatch):
    monkeypatch.setattr(teacher_service, "_ledger_broken", None)


@pytest.fixture(autouse=True)
def _training_token(monkeypatch):
    """토큰이 맞는 상태를 기본으로 깔아 둔다 — 인증 테스트만 직접 어긴다."""
    monkeypatch.setenv("APIA_TRAINING_TOKEN", TOKEN)


def _post(client, url, payload, token=TOKEN):
    """토큰 헤더를 붙인 POST. token=None이면 헤더 자체를 빼고 보낸다."""
    headers = {} if token is None else {"X-Apia-Training-Token": token}
    return client.post(url, json=payload, headers=headers)


@pytest.fixture()
def usage_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key-not-real")
    return tmp_path


def _items(n=2):
    return {"items": [{"q": f"q{i}", "ref": f"ref{i}", "a": f"학생답{i}"} for i in range(n)]}


@pytest.fixture()
def patched_teacher(monkeypatch):
    from routers import training as router_mod

    def _install(fn):
        monkeypatch.setattr(router_mod.teacher_service, "ask_json", fn)

    return _install


# ── 인증 ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("token", [None, "", "wrong-token", TOKEN + "x"])
@pytest.mark.parametrize("url", ["/training/correct", "/training/shadow"])
def test_bad_token_is_403_before_any_work(client, monkeypatch, url, token):
    """토큰이 없거나 틀리면 교사도 GPU도 건드리지 않고 403."""
    from routers import training as router_mod

    def _must_not_run(*_a, **_k):
        raise AssertionError(f"{url} ran work with token={token!r}")

    monkeypatch.setattr(router_mod.teacher_service, "ask_json", _must_not_run)
    monkeypatch.setattr(router_mod.claude, "local_loaded", _must_not_run)
    monkeypatch.setattr(router_mod.claude, "shadow_reply", _must_not_run)
    payload = _items() if url.endswith("correct") else {"message": "안녕", "delta_dir": "D:/x"}
    assert _post(client, url, payload, token=token).status_code == 403


@pytest.mark.parametrize("url", ["/training/correct", "/training/shadow"])
def test_unset_token_denies_everything(client, monkeypatch, url):
    """외부에서 따로 띄운 백엔드(토큰 미주입)에서는 조용히 비활성 = fail-closed."""
    monkeypatch.delenv("APIA_TRAINING_TOKEN", raising=False)
    payload = _items() if url.endswith("correct") else {"message": "안녕", "delta_dir": "D:/x"}
    assert _post(client, url, payload).status_code == 403


def test_right_token_passes(client, patched_teacher):
    patched_teacher(lambda *_a, **_k: ({"answers": ["고친답0", "고친답1"]}, 0.004))
    response = _post(client, "/training/correct", _items())
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


# ── 주당 상한 ───────────────────────────────────────────────────────────────

def _write_usage(path, records):
    (path / "teacher_usage.json").write_text(json.dumps(records), encoding="utf-8")


def test_weekly_bucket_blocks_before_http(usage_dir, monkeypatch):
    """주간 버킷이 찼으면 일일 예산이 남아 있어도 호출하지 않는다."""
    _write_usage(usage_dir, {
        "2026-09-20": {"usd": 0.001, "usd_onpolicy": 0.06},
        teacher_service._today(): {"usd": 0.001, "usd_onpolicy": 0.05},
    })

    def _boom(*_a, **_k):
        raise AssertionError("weekly bucket guard did not fire")

    monkeypatch.setattr(teacher_service.urllib.request, "urlopen", _boom)
    with pytest.raises(teacher_service.TeacherUnavailable) as caught:
        teacher_service.ask_json(
            "sys", "user",
            bucket=teacher_service.ON_POLICY_BUCKET,
            bucket_weekly_cap=teacher_service.ON_POLICY_WEEKLY_USD,
        )
    assert "weekly" in str(caught.value)


def test_daily_budget_still_applies_to_the_bucket(usage_dir, monkeypatch):
    """버킷이 비어 있어도 일일 상한에 닿았으면 못 쓴다 — 두 가드는 AND다."""
    _write_usage(usage_dir, {
        teacher_service._today(): {"usd": teacher_service.DAILY_BUDGET_USD, "usd_onpolicy": 0.0},
    })
    monkeypatch.setattr(
        teacher_service.urllib.request, "urlopen",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("daily guard did not fire")),
    )
    with pytest.raises(teacher_service.TeacherUnavailable) as caught:
        teacher_service.ask_json(
            "sys", "user",
            bucket=teacher_service.ON_POLICY_BUCKET,
            bucket_weekly_cap=teacher_service.ON_POLICY_WEEKLY_USD,
        )
    assert "daily" in str(caught.value)


def test_bucket_spend_is_tracked_separately(usage_dir, monkeypatch):
    monkeypatch.setattr(
        teacher_service.urllib.request, "urlopen", lambda *_a, **_k: _FakeResponse()
    )
    teacher_service.ask_json("sys", "user")  # 버킷 없는 호출(교재 변환)
    before = teacher_service.on_policy_spent_week()
    assert before == 0.0

    teacher_service.ask_json(
        "sys", "user",
        bucket=teacher_service.ON_POLICY_BUCKET,
        bucket_weekly_cap=teacher_service.ON_POLICY_WEEKLY_USD,
    )
    after = teacher_service.on_policy_spent_week()
    assert after > 0.0
    # 버킷 지출은 전체 지출의 일부다 — 같이 세되 따로 센다.
    assert after < teacher_service.spent_today()


# ── status 계약 ─────────────────────────────────────────────────────────────

def test_correct_ok_returns_answers(client, patched_teacher):
    patched_teacher(lambda *_a, **_k: ({"answers": ["고친답0", "고친답1"]}, 0.004))
    body = _post(client, "/training/correct", _items()).json()
    assert body["status"] == "ok"
    assert body["answers"] == ["고친답0", "고친답1"]
    assert body["budget_week_usd"] == pytest.approx(0.10)


def test_correct_count_mismatch_is_failed_not_partial(client, patched_teacher):
    """밀려 붙은 교정은 카드와 답을 뒤섞는다 — 통째로 버려야 학습기가 폴백한다."""
    patched_teacher(lambda *_a, **_k: ({"answers": ["하나뿐"]}, 0.004))
    body = _post(client, "/training/correct", _items(2)).json()
    assert body["status"] == "failed"
    assert body["answers"] is None


def test_correct_empty_answer_is_failed(client, patched_teacher):
    patched_teacher(lambda *_a, **_k: ({"answers": ["좋은 답", "   "]}, 0.004))
    body = _post(client, "/training/correct", _items(2)).json()
    assert body["status"] == "failed"


def test_correct_budget_exhausted_is_deferred(client, patched_teacher):
    def _unavailable(*_a, **_k):
        raise teacher_service.TeacherUnavailable("onpolicy weekly budget reached")

    patched_teacher(_unavailable)
    body = _post(client, "/training/correct", _items()).json()
    assert body["status"] == "deferred"   # 학습기는 이걸 보고 남은 배치도 폴백한다
    assert body["answers"] is None


def test_correct_empty_request_costs_nothing(client, patched_teacher):
    patched_teacher(lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("no call expected")))
    body = _post(client, "/training/correct", {"items": []}).json()
    assert body["status"] == "ok"
    assert body["answers"] == []


# ── 그림자 ──────────────────────────────────────────────────────────────────

def test_shadow_dormant_when_model_not_resident(client, monkeypatch):
    """가장 중요한 불변식: 그림자가 로컬 모델 로드를 유발하지 않는다."""
    from routers import training as router_mod

    monkeypatch.setattr(router_mod.claude, "local_loaded", lambda: False)

    def _must_not_run(*_a, **_k):
        raise AssertionError("shadow tried to generate without a resident model")

    monkeypatch.setattr(router_mod.claude, "shadow_reply", _must_not_run)
    body = _post(client, "/training/shadow", {"message": "안녕", "delta_dir": "D:/x"}).json()
    assert body["status"] == "dormant"
    assert "resident" in body["reason"]


def test_shadow_dormant_without_delta(client, monkeypatch):
    from routers import training as router_mod

    monkeypatch.setattr(router_mod.claude, "local_loaded", lambda: True)
    body = _post(client, "/training/shadow", {"message": "안녕", "delta_dir": ""}).json()
    assert body["status"] == "dormant"


def test_shadow_ok_returns_reply(client, monkeypatch):
    from routers import training as router_mod

    async def _reply(message, delta_dir, **_k):
        assert message == "안녕"
        return "그림자 답"

    monkeypatch.setattr(router_mod.claude, "local_loaded", lambda: True)
    monkeypatch.setattr(router_mod.claude, "shadow_reply", _reply)
    body = _post(client, "/training/shadow", {"message": "안녕", "delta_dir": "D:/x"}).json()
    assert body["status"] == "ok"
    assert body["reply"] == "그림자 답"


def test_shadow_busy_local_path_is_dormant_not_queued(client, monkeypatch):
    """대화 지연 0 — 로컬이 바쁘면 그림자는 줄 서지 않고 그냥 쉰다."""
    from routers import training as router_mod

    async def _busy(*_a, **_k):
        raise RuntimeError("local path busy")

    monkeypatch.setattr(router_mod.claude, "local_loaded", lambda: True)
    monkeypatch.setattr(router_mod.claude, "shadow_reply", _busy)
    body = _post(client, "/training/shadow", {"message": "안녕", "delta_dir": "D:/x"}).json()
    assert body["status"] == "dormant"
    assert "busy" in body["reason"]


def test_shadow_failure_is_swallowed_as_status(client, monkeypatch):
    """그림자가 터져도 예외가 대화 경로로 새지 않는다(HTTP 500 금지)."""
    from routers import training as router_mod

    async def _boom(*_a, **_k):
        raise ValueError("adapter file corrupt")

    monkeypatch.setattr(router_mod.claude, "local_loaded", lambda: True)
    monkeypatch.setattr(router_mod.claude, "shadow_reply", _boom)
    response = _post(client, "/training/shadow", {"message": "안녕", "delta_dir": "D:/x"})
    assert response.status_code == 200
    assert response.json()["status"] == "failed"


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return json.dumps({
            "choices": [{"message": {"content": json.dumps({"answers": []})}}],
            "usage": {
                "prompt_cache_hit_tokens": 10,
                "prompt_cache_miss_tokens": 20,
                "completion_tokens": 5,
            },
        }).encode("utf-8")
