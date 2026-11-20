# 변경 부분만 보인다. 원본: src/cheongeum/core/llm.py:98 (generate)
# 기존 호출은 그대로 동작한다(images 기본값 ()).

class OpenAIStructuredLlm:
    async def generate(
        self,
        *,
        system: str,
        user: str,  # 여전히 JSON 문자열. FakeLlm.scripted가 json.loads(user)를 쓴다.
        schemaName: str,
        schema: dict,
        signal: AbortSignal | None = None,
        images: tuple[bytes, ...] = (),  # PNG 바이트. 비면 기존 텍스트 요청과 같다.
    ) -> Any | None:
        """텍스트 요청. images가 있으면 user 메시지를 content 목록으로 보낸다.

        content 모양(Chat Completions):
          [{"type": "text", "text": user},
           {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}, ...]
        detail은 LLM_VISION_DETAIL(기본 "high": 작은 한글을 읽어야 해서 "low"는 부족하다).
        strict json_schema와 이미지를 함께 쓰는 것은 소유자 모델에서 확인되지 않았다(PLAN U0).
        """
        raise NotImplementedError
