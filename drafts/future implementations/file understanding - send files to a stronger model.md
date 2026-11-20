# File understanding: send PDFs and files to a stronger LLM instead of OCR

Status: implemented and tested offline. On 2026-11-18 the owner selected all supported downloads for explicit summary and question requests, with spoken confirmation before each send. The FILE model is configurable. The app uses a spoken accuracy notice for image-only answers and checks evidence against local text when available. The settings and usage are in the README. Live model cost and latency remain unmeasured.

The owner chose to inherit the existing model for now. Set `LLM_FILE_MODEL` to select a separate model later.

## Decision

When the user asks about a PDF or another file, send the file to the general-purpose LLM instead of running local OCR. Local OCR was rejected because its performance is too low. File understanding should use a stronger, higher-tier model than the default one.

This replaces the earlier suggestion of local OCR as the first step.

## Starting behavior before implementation

- `agents/web/docs.py` `read_document` extracts text locally. A PDF goes through `pypdf`, so only a text layer is read. A HWPX is unzipped and its XML text is joined.
- A PDF without a text layer, such as a scanned notice, returns "글을 찾지 못했어요". An old `.hwp` and any image file are refused as unreadable.
- `downloads.py` `read_latest` reads the extracted text aloud in chunks of about 1,200 characters. It reads raw text. It does not summarize or answer a question about the file.
- The LLM client (`core/llm.py` `OpenAIStructuredLlm.generate`) takes only `system` and `user` strings, so it cannot carry a file.
- LLM roles already follow one pattern: `_llm_role` in `server/runtime.py` reads `LLM_<ROLE>_PROVIDER|MODEL|BASE_URL|API_KEY|REASONING_EFFORT` and falls back to the default LLM. Today's roles are UNDERSTAND, GOAL and WEB. The default model in `.env` is `gpt-5-mini`.

## What the OpenAI API allows (web search 2026-11-18)

- Chat Completions accepts a PDF as base64 `file_data` or as an uploaded `file_id`. Both work for PDFs only. External URLs are not supported there. The Responses API also takes URLs.
- Vision-capable models can read PDFs. The docs example uses `gpt-4.1`. I found no per-model list.
- Cited limits are about 100 pages and 32MB per request across all files. These figures come from community and third-party sources, and one source gives a different page limit. Check the current official page before relying on them.
- One user reported that only the last file is used when several are attached. This is anecdotal, so send one file per request.
- Images go in as `image_url` data URLs. I did not verify that in the search.
- Old `.hwp` is not a supported type. HWPX can still be unzipped locally and sent as text.
  - https://developers.openai.com/api/docs/guides/pdf-files
  - https://developers.openai.com/api/docs/guides/file-inputs

## Proposed shape

- **New LLM role `FILE`.** Env vars `LLM_FILE_PROVIDER|MODEL|BASE_URL|API_KEY|REASONING_EFFORT`, built in `runtime.py` like the other roles and falling back to the default LLM. The user picks the higher model ID in `.env`. Model IDs stay out of the code.
- **File input on the LLM client.** `generate` gains an optional list of attachments. A PDF becomes a `file` content part, and an image becomes an `image_url` part. Only the `openai` provider accepts them. With `ollama` or another provider, the app falls back to today's local text reading and says why.
- **Where it plugs in.** `read_document` stays the local path for text. A new function in `agents/web/` sends the file to the `FILE` role. `BrowseSkill.read_download` chooses between them.
- **What the user gets.** A short Korean summary, or an answer to the user's question about the file. This is better for a blind listener than 1,200 characters of raw text. The user can still ask for it verbatim.

## Design questions considered

1. **Privacy.** A file is sent whole, so the app's text redaction (`redact_text`) cannot hide names, ID numbers or addresses in it. Options: a spoken notice before every send, a yes/no confirmation, or both. The consent text at the start must also say that files may go to OpenAI. For PDFs with a text layer, an alternative is to send redacted text instead of the file.
2. **Always send, or only when local reading fails.** The decision says to send PDFs and files to the model. Open: whether text-layer PDFs also go to the model, or only scanned ones and images.
3. **Checking the answer.** The app normally checks quotes and numbers against the source text (`safety/verify.py`). A scanned file has no local text. Options: ask the model to also return a transcript and check the answer's numbers against it, or tell the user "AI가 읽은 내용이라 틀릴 수 있어요" for scanned files.
4. **Which higher model, and the cost.** The file role runs a bigger model on every page. Cost and delay per file are not measured.

## Other points to handle

- **Timeout.** The default OpenAI timeout is 30 seconds. A long PDF on a stronger model will need more, and the user needs a spoken "읽는 중이에요" so the wait is not silent. The progress system can carry this.
- **Size.** Files over the page or size limit need a clear spoken answer, or a split.
- **Tests.** Use `FakeLlm` and never call the real API. Include an image-only PDF fixture.
- **Docs.** Update the README env table, the consent text and `CLAUDE.md` when it is built.
