"""Run one fixture welfare lookup through the AG-UI Python encoder and JS HTTP client."""

import asyncio
import socket
from pathlib import Path

import uvicorn
from ag_ui.core import (
    RunAgentInput,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from cheongeum.agents.welfare import WelfareInformationAgent
from cheongeum.agents.welfare.data import FixtureWelfareDataProvider

QUESTION = "장애인연금 신청 방법이 뭐예요?"
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.post("/ag-ui")
async def lookup(run: RunAgentInput):
    if len(run.messages) != 1 or run.messages[0].role != "user" or run.messages[0].content != QUESTION:
        raise HTTPException(422, "Only the public fixture question is supported.")

    agent = WelfareInformationAgent(FixtureWelfareDataProvider.from_file())
    answer = await agent.answer_policy_question(QUESTION)
    assert answer.grounded and answer.service["dataOrigin"] == "fixture" and len(answer.sources) == 1
    citation = answer.sources[0]
    source = {key: citation[key] for key in ("title", "url", "lastCheckedAt", "version")}
    source["dataOrigin"] = answer.service["dataOrigin"]
    message_id = f"answer-{run.run_id}"
    encoder = EventEncoder()
    events = [
        RunStartedEvent(thread_id=run.thread_id, run_id=run.run_id),
        TextMessageStartEvent(message_id=message_id, role="assistant"),
        TextMessageContentEvent(message_id=message_id, delta=answer.speech),
        TextMessageEndEvent(message_id=message_id),
        StateSnapshotEvent(snapshot={"source": source}),
        RunFinishedEvent(thread_id=run.thread_id, run_id=run.run_id),
    ]
    return StreamingResponse((encoder.encode(event) for event in events), media_type=encoder.get_content_type())


async def main():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="error"))
        task = asyncio.create_task(server.serve(sockets=[listener]))
        client = None
        try:
            async with asyncio.timeout(30):
                while not server.started:
                    if task.done():
                        await task
                        raise RuntimeError("Probe server did not start.")
                    await asyncio.sleep(0.02)
                client = await asyncio.create_subprocess_exec(
                    "node", str(Path(__file__).with_name("client.cjs")), f"http://127.0.0.1:{port}/ag-ui"
                )
                if await client.wait():
                    raise RuntimeError("AG-UI client checks failed.")
        finally:
            if client is not None and client.returncode is None:
                client.kill()
                await client.wait()
            server.should_exit = True
            await task


if __name__ == "__main__":
    asyncio.run(main())
