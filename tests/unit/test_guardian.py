import hashlib
import hmac
import json

import httpx
import pytest

from cheongeum.personal.guardian import MESSAGE, PreviewSender, guardian_command, guardian_sender
from cheongeum.personal.store import PersonalStore


def test_guardian_does_not_replace_user_phone_and_is_cleared_with_vault(tmp_path):
    path = str(tmp_path / "vault.json")
    store = PersonalStore(path)
    contact = {"name": "홍길동", "phone": "01011223344"}
    store.save_vault({"phone": "01022334455"})
    store.set_guardian(contact)
    restored = PersonalStore(path)
    assert restored.guardian() == contact and restored.vault() == {"phone": "01022334455"}
    restored.clear_vault()
    assert PersonalStore(path).guardian() is None


def test_explicit_sender_and_exact_request():
    assert isinstance(guardian_sender({"SOLAPI_API_KEY": "key"}), PreviewSender)
    assert guardian_sender({"GUARDIAN_SMS_PROVIDER": "solapi"}) is None
    assert guardian_command("보호자 김하늘 전화번호 010123456789 등록해줘") == {"kind": "guardian-help"}
    assert guardian_command("보호자한테 연락하지 마") is None
    assert guardian_command("보호자 이름은 이진희이고 전화번호는 010-1122-3344 등록해줘")["contact"]["name"] == "이진희"


@pytest.mark.parametrize(("status", "body", "expected"), [
    (200, {"failedMessageList": [], "groupInfo": {"count": {"registeredSuccess": 1}}}, "accepted"),
    (200, {"failedMessageList": [{"statusCode": "3040"}]}, "failed"),
    (403, {}, "failed"), (500, {}, "unknown"), (200, {}, "unknown"),
])
async def test_solapi_single_request_and_acceptance(http_mock, status, body, expected):
    def handle(req):
        assert req.url == "https://api.solapi.com/messages/v4/send-many/detail"
        auth = dict(pair.split("=", 1) for pair in req.headers["Authorization"].removeprefix("HMAC-SHA256 ").split(", "))
        assert auth["apiKey"] == "key"
        assert auth["signature"] == hmac.new(b"secret", (auth["date"] + auth["salt"]).encode(), hashlib.sha256).hexdigest()
        assert json.loads(req.content)["messages"] == [{"from": "0212345678", "to": "01012345678", "text": MESSAGE, "type": "SMS"}]
        return httpx.Response(status, json=body)

    calls = http_mock(handle)
    sender = guardian_sender({"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "02-1234-5678"})
    assert await sender.send("01012345678", MESSAGE) == expected
    assert len(calls) == 1
