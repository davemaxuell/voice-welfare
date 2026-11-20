"""역할별 LLM 설정(.env 덮어쓰기)."""
from cheongeum.core.llm import LlmConfig, overlay_llm
from cheongeum.core.model_stack import STACK
from cheongeum.server.runtime import load_config


def test_overlay_llm_falls_back():
    base = LlmConfig(provider="openai", model="gpt-4o", apiKey="k", baseUrl="https://api.openai.com/v1")
    assert overlay_llm(base) is base
    over = overlay_llm(base, provider="ollama", model="qwen2.5")
    assert (over.provider, over.model, over.apiKey) == ("ollama", "qwen2.5", "k")


def test_load_config_role_overrides():
    cfg = load_config(
        {
            "LLM_PROVIDER": "openai",
            "LLM_MODEL": "gpt-4o-mini",
            "LLM_API_KEY": "main",
            "LLM_GOAL_PROVIDER": "ollama",
            "LLM_GOAL_MODEL": "qwen2.5:7b",
            "LLM_UNDERSTAND_MODEL": "gpt-4o",
            "REQUIRE_CONSENT": "false",
            "HEADLESS": "true",
        }
    )
    assert cfg.llm.model == "gpt-4o-mini"
    assert cfg.llmGoal.provider == "ollama"
    assert cfg.llmGoal.model == "qwen2.5:7b"
    assert cfg.llmUnderstand.model == "gpt-4o"
    assert cfg.llmUnderstand.provider == "openai"
    assert cfg.llmWeb.model == STACK.utility
    assert cfg.llmGoal.apiKey is None


def test_single_key_defaults_and_independent_role_endpoints():
    cfg = load_config({"LLM_API_KEY": "local-test-key"})
    assert [cfg.voice.liveModel, cfg.llm.model, cfg.llmWeb.model, cfg.llmVision.model, cfg.llmRecovery.model,
            cfg.voice.sttModel] == [STACK.voice, STACK.agent, STACK.utility, STACK.vision, STACK.recovery, STACK.transcription]
    assert cfg.voice.apiKey == cfg.llmUnderstand.apiKey == cfg.llmRecovery.apiKey == "local-test-key"
    mixed = load_config({"OPENAI_API_KEY": "local-test-key", "LLM_WEB_BASE_URL": "https://other.example/v1",
                         "VOICE_BASE_URL": "https://voice.example/v1"})
    assert mixed.llmWeb.apiKey is None and mixed.voice.apiKey is None
