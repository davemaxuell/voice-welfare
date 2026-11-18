"""목표 수행이 어디까지 왔는지: 세션당 하나. 단계 문장은 코드가 행동 종류·대상 이름·사이트 이름으로 만든 것만 들어온다."""
from __future__ import annotations


class Progress:
    """
    BrowseSkill.run_goal이 쓰고, 오케스트레이터('지금 어디까지 했어?')와 서버(GET /api/session/{id}/progress)가 읽는다.
    목표 수행이 끝나도 마지막 단계는 남겨 둔다(다음 목표를 시작하면 지운다).
    """

    def __init__(self) -> None:
        # 묻지 않아도 진행 상황을 소리로 알릴지(기본 켬). 음성 설정 명령이 바꾼다.
        self.spoken = True
        self._running = False
        self._steps: list[str] = []
        # 지금까지 넣은 단계 수(목표가 바뀌어도 이어 센다): 화면은 이 번호로 아직 말하지 않은 단계인지 안다
        self._seq = 0

    @property
    def running(self) -> bool:
        return self._running

    @property
    def count(self) -> int:
        """이번(또는 지난) 목표 수행에서 마친 단계 수"""
        return len(self._steps)

    @property
    def latest(self) -> str | None:
        return self._steps[-1] if self._steps else None

    def start(self) -> None:
        self._running = True
        self._steps = []

    def add(self, sentence: str) -> None:
        self._steps.append(sentence)
        self._seq += 1

    def finish(self) -> None:
        self._running = False

    def snapshot(self) -> dict:
        return {"running": self._running, "seq": self._seq, "latest": self.latest, "spoken": self.spoken}
