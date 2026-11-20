"""사진 모델 호출: 사진은 가린 Picture 한 장만, OpenAI로만 간다."""
import base64
import json

import httpx
import pytest

from cheongeum.core.llm import LlmConfig, OpenAIStructuredLlm, OpenAIVisionLlm, create_structured_llm, create_vision_llm
from cheongeum.core.picture import PICTURE_SCHEMA, PICTURE_SCHEMA_NAME, MaskReport, Picture
from cheongeum.server.runtime import load_config

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
ANSWER = {"screen": "normal", "description": "안내문이 보여요.", "pressable": [1]}


def picture() -> Picture:
    return Picture._sealed(PNG, source="web", width=1, height=1, masks=MaskReport(0, 0, 0, False))


def vision(**over) -> OpenAIVisionLlm:
    return OpenAIVisionLlm(**{"model": "vision-model", "base_url": "https://api.openai.com/v1", "api_key": "sk-test", **over})


def reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


async def see(llm: OpenAIVisionLlm, **over):
    args = {"system": "설명한다", "user": "1. 닫기", "picture": picture(), "schemaName": PICTURE_SCHEMA_NAME, "schema": PICTURE_SCHEMA}
    return await llm.see(**{**args, **over})


async def test_see_sends_one_masked_image_and_a_strict_schema(http_mock):
    calls = http_mock(lambda req: reply(json.dumps(ANSWER)))
    assert await see(vision()) == ANSWER
    (req,) = calls
    assert str(req.url) == "https://api.openai.com/v1/chat/completions"
    assert req.headers["Authorization"] == "Bearer sk-test"
    body = json.loads(req.content)
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": PICTURE_SCHEMA_NAME, "strict": True, "schema": PICTURE_SCHEMA},
    }
    system, user = body["messages"]
    assert system == {"role": "system", "content": "설명한다"}
    images = [part for part in user["content"] if part["type"] == "image_url"]
    assert len(images) == 1
    assert images[0]["image_url"]["detail"] == "high"
    head, _, data = images[0]["image_url"]["url"].partition(",")
    assert head == "data:image/png;base64"
    assert base64.b64decode(data) == PNG
    assert [part for part in user["content"] if part["type"] != "image_url"] == [{"type": "text", "text": "1. 닫기"}]


async def test_detail_comes_from_config(http_mock):
    calls = http_mock(lambda req: reply(json.dumps(ANSWER)))
    await see(vision(detail="low"))
    assert json.loads(calls[0].content)["messages"][1]["content"][1]["image_url"]["detail"] == "low"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, json={"error": "boom"}),
        httpx.Response(200, json={"choices": [{"message": {"content": None, "refusal": "no"}}]}),
        httpx.Response(200, json={"choices": [{"message": {"content": "{not json"}}]}),
    ],
)
async def test_failed_call_returns_none(http_mock, response):
    http_mock(lambda req: response)
    assert await see(vision()) is None


async def test_see_takes_only_a_sealed_picture(http_mock):
    calls = http_mock(lambda req: reply(json.dumps(ANSWER)))
    for not_a_picture in (PNG, "data:image/png;base64,AAAA", "C:/shot.png"):
        with pytest.raises(TypeError):
            await see(vision(), picture=not_a_picture)
    assert calls == []


async def test_text_model_still_sends_plain_text_and_cannot_see(http_mock):
    calls = http_mock(lambda req: reply('{"text": "네"}'))
    llm = OpenAIStructuredLlm(model="text-model", base_url="http://localhost:11434/v1", provider="ollama")
    assert await llm.generate(system="s", user="안녕", schemaName="t", schema={"type": "object"}) == {"text": "네"}
    assert json.loads(calls[0].content)["messages"] == [{"role": "system", "content": "s"}, {"role": "user", "content": "안녕"}]
    assert not hasattr(llm, "see")
    assert not hasattr(vision(), "generate")


@pytest.mark.parametrize(
    "cfg",
    [
        LlmConfig(provider="mock"),
        LlmConfig(provider="ollama", model="qwen2.5vl"),
        LlmConfig(provider="openai-compatible", model="qwen-vl", baseUrl="https://example.com/v1", apiKey="k"),
        LlmConfig(provider="openai", model=None, apiKey="k"),
        LlmConfig(provider="openai", model="vision-model", apiKey=None),
    ],
)
def test_no_vision_client_unless_openai_with_model_and_key(cfg):
    assert create_vision_llm(cfg) is None


def test_openai_builds_a_vision_client():
    llm = create_vision_llm(LlmConfig(provider="OpenAI", model="vision-model", apiKey="k"), detail="low")
    assert isinstance(llm, OpenAIVisionLlm)
    assert (llm.model, llm.base_url, llm.detail) == ("vision-model", "https://api.openai.com/v1", "low")


ENV = {"REQUIRE_CONSENT": "false", "HEADLESS": "true"}


def test_vision_role_is_read_like_the_other_roles():
    local = load_config({**ENV, "LLM_PROVIDER": "ollama", "LLM_MODEL": "qwen2.5:7b"})
    assert create_structured_llm(local.llmVision) is not None
    assert create_vision_llm(local.llmVision, detail=local.visionDetail) is None

    mixed = load_config(
        {
            **ENV,
            "LLM_PROVIDER": "ollama",
            "LLM_MODEL": "qwen2.5:7b",
            "LLM_VISION_PROVIDER": "openai",
            "LLM_VISION_MODEL": "vision-model",
            "LLM_VISION_API_KEY": "sk-vision",
            "LLM_VISION_DETAIL": "LOW",
        }
    )
    llm = create_vision_llm(mixed.llmVision, detail=mixed.visionDetail)
    assert (llm.model, llm.api_key, llm.detail) == ("vision-model", "sk-vision", "low")
    assert mixed.llm.provider == "ollama"

    follows_base = load_config({**ENV, "LLM_PROVIDER": "openai", "LLM_MODEL": "gpt-main", "LLM_API_KEY": "main"})
    assert create_vision_llm(follows_base.llmVision).model == "gpt-6.1-terra"
    assert follows_base.visionDetail == "high"
    assert load_config({**ENV, "LLM_VISION_DETAIL": "ultra"}).visionDetail == "high"
