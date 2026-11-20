"""
승인 지문: 승인을 물을 때 읽어 준 것(할 조작과 누를 대상, 화면 주소, 입력 칸 값, 읽어 준 문장)을 적어 두었다가
'응'을 들으면 그때 화면으로 다시 만들어 비교한다. 본문 글·제목은 넣지 않는다(돌아가는 배너·시계로 괜히 취소되지 않게).
"""
from __future__ import annotations

import hashlib

from cheongeum.core.jsutil import try_url
from cheongeum.speech.phrasing import josa, speak_label


def _value_hash(value: str | None) -> str | None:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16] if value is not None else None


def _page(url: str) -> str:
    u = try_url(url)
    return f"{u.origin}{u.pathname}" if u else url


def _target_now(view: dict, target: dict) -> dict | None:
    """조작 대상이 지금 화면에서 어떤 모습인지. 누를 대상은 ref로(없으면 역할·이름으로) 찾고, 없어졌으면 None. 입력 칸은 값 쪽에서 본다."""
    if target.get("fieldId"):
        return {"fieldId": target["fieldId"]}
    ref = target.get("ref")
    for it in (view.get("outline") or {}).get("items") or []:
        if (it["ref"] == ref) if ref else (it["role"], it["name"]) == (target.get("role"), target.get("name")):
            return {"role": it["role"], "name": it["name"], **({"ref": ref} if ref else {})}
    return None


def _action_entry(view: dict, action: dict) -> dict:
    target = action.get("target") or {}
    entry = {
        "type": action["type"],
        "role": target.get("role"),
        "name": target.get("name"),
        "now": _target_now(view, target),
    }
    # 넣을 값(아직 화면에 없을 수 있음)도 지문에 묶어, 승인 대기 중 값이 바뀌면 막는다.
    if "value" in action:
        entry["valueHash"] = _value_hash(action.get("value"))
    return entry


def fingerprint(view: dict, actions: list[dict], speech: str, field_ids: list[str] | None = None) -> dict:
    """
    승인 지문. speech = 승인을 물으며 읽어 준 문장. field_ids = 값을 지켜볼 입력 칸(주지 않으면 입력 액션이 겨누는 칸).
    화면 칸 값·액션에 실린 넣을 값은 해시로만 적는다.
    """
    if field_ids is None:
        field_ids = [a["target"]["fieldId"] for a in actions if (a.get("target") or {}).get("fieldId")]
    observed = {f["fieldId"]: f for f in view.get("fields") or []}
    return {
        "actions": [_action_entry(view, a) for a in actions],
        "page": _page(view.get("url") or ""),
        "fields": [
            {
                "fieldId": fid,
                "label": speak_label(observed[fid]["label"]) if fid in observed else "",
                "valueHash": _value_hash(observed[fid]["value"]) if fid in observed else None,
            }
            for fid in field_ids
        ],
        "speech": speech,
    }


def _difference(asked: dict, now: dict) -> str | None:
    if asked["page"] != now["page"]:
        return "여쭤본 뒤에 화면이 바뀌었어요."
    for a, n in zip(asked["actions"], now["actions"]):
        if a.get("valueHash") != n.get("valueHash"):
            return "여쭤본 뒤에 넣을 값이 바뀌었어요."
        if a != n:
            kind = josa("링크" if a["role"] == "link" else "버튼", "이", "가")
            how = "화면에서 없어졌어요" if n["now"] is None else "다른 것으로 바뀌었어요"
            return f"누르려던 '{a['name'] or ''}' {kind} {how}."
    changed = [a["label"] for a, n in zip(asked["fields"], now["fields"]) if (a["label"], a["valueHash"]) != (n["label"], n["valueHash"])]
    return f"{', '.join(changed)} 칸 값이 바뀌었어요." if changed else None


def recheck(asked: dict, view: dict, actions: list[dict]) -> tuple[dict, str | None]:
    """'응'을 들은 지금 화면으로 지문을 다시 만든다. (새 지문, 물어볼 때와 달라진 것을 말하는 문장 — 같으면 None)"""
    now = fingerprint(view, actions, asked["speech"], [f["fieldId"] for f in asked["fields"]])
    return now, _difference(asked, now)
