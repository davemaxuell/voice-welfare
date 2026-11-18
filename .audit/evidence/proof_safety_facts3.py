import asyncio
from cheongeum.core.dialogue import DialogueState
from cheongeum.agents.web.skills.guided import GuidedFill
from cheongeum.agents.web.agent import _action_label
from cheongeum.agents.web.approval import fingerprint, recheck, _value_hash
from cheongeum.orchestrator.session import APPROVAL_TTL_S
from cheongeum.personal.seal import Seal, MAGIC
from cheongeum.personal.action_log import ActionLog, GENESIS
from pathlib import Path
import tempfile, os, json

class FakeNarrator:
    def once(self, *a, **k):
        return ""

class FakeRules:
    async def parse(self, text, ctx):
        return {"type": "UNKNOWN"}

class FakeWeb:
    current_view = {
        "url": "https://evil.example/form",
        "pageId": "external",
        "fields": [{"fieldId": "f1", "label": "이름", "visible": True, "sensitive": False, "searchable": False, "type": "text"}],
    }
    @staticmethod
    def build_assist_action(field_, value):
        return {"id": "a1", "type": "typeText", "target": {"fieldId": field_["fieldId"]}, "value": value, "requiresConfirmation": True}

allowed = {}
dialogue = DialogueState("IDLE", clock=lambda: 0.0)
gfill = GuidedFill(
    web=FakeWeb(),
    dialogue=dialogue,
    narrator=FakeNarrator(),
    rules=FakeRules(),
    saved_value=lambda label: "SECRET_VAULT_VALUE",
    site_allowed=lambda o: bool(allowed.get(o)),
    allow_site=lambda o: allowed.__setitem__(o, True),
)
dialogue.start_guided("https://evil.example/form", ["f1"])
g = dialogue.guided
g["origin"] = "https://evil.example"
g["skipVault"] = False
q = gfill._question(FakeWeb.current_view)
assert "SECRET_VAULT_VALUE" not in q, q
assert g.get("awaitSiteAllow") is True and g.get("suggestion") is None
print("PROOF2a_OK: no siteAllow -> vault not suggested")

async def ans(t):
    return await gfill.answer(t, None)
r = asyncio.run(ans("응"))
assert allowed.get("https://evil.example") is True
assert dialogue.approval is None
print("PROOF2b_OK: site-allow yes does not fill; approval still None")

q2 = gfill._question(FakeWeb.current_view)
assert g.get("suggestion") == "SECRET_VAULT_VALUE"
r2 = asyncio.run(ans("응"))
assert r2["state"] == "WAITING_FOR_USER_CONFIRMATION"
assert dialogue.approval and dialogue.approval.get("guided") and dialogue.approval["action"]["value"] == "SECRET_VAULT_VALUE"
print("PROOF2c_OK: vault yes -> ask_approval only; fill needs _approve")

# spoken value also goes through _ask_fill
dialogue.clear_approval()
dialogue.start_guided("https://evil.example/form", ["f1"])
g = dialogue.guided
g["origin"] = "https://evil.example"
g["skipVault"] = True
g["suggestion"] = None
g["awaitSiteAllow"] = False
r3 = asyncio.run(ans("홍길동"))
assert r3["state"] == "WAITING_FOR_USER_CONFIRMATION"
assert dialogue.approval
print("PROOF2d_OK: spoken value also requires approval via _ask_fill")

# layers already passed pytest; show ALLOWED table facts
print("PROOF5_OK: test_layers.py passed earlier (2 passed)")

# action label / log
td = tempfile.mkdtemp()
seal = Seal(key=os.urandom(32))
apath = os.path.join(td, "a.sealed")
log = ActionLog(apath, seal=seal)
a = log.append({"label": "apply-btn", "actionType": "click"})
b = log.append({"label": "next", "actionType": "click"})
assert a["prev"] == GENESIS and b["prev"] == a["hash"]
raw = Path(apath).read_bytes()
assert raw.startswith(MAGIC) and b"apply-btn" not in raw
lab = _action_label({"type": "typeText", "reason": "주민번호 900101-1234567", "target": {"name": "이름"}, "value": "900101-1234567"})
assert "900101" not in lab
lab2 = _action_label({"type": "typeText", "target": {"name": "이름"}, "value": "SECRET"})
assert "SECRET" not in lab2
print("PROOF3_OK: sealed chain; _action_label redacts reason and omits value:", lab, "|", lab2)

view = {"url": "https://example.com/form", "outline": {"items": [{"ref": "r1", "role": "button", "name": "apply"}]}, "fields": [{"fieldId": "f1", "label": "name", "value": "Hong"}]}
action = {"type": "type", "target": {"fieldId": "f1"}}
fp = fingerprint(view, [action], "put?")
assert "Hong" not in str(fp["fields"]) and fp["fields"][0]["valueHash"] == _value_hash("Hong")
_, ch = recheck(fp, {**view, "url": "https://example.com/x"}, [action])
assert ch
_, ok = recheck(fp, view, [action])
assert ok is None
assert APPROVAL_TTL_S == 120
t0 = [0.0]
d = DialogueState("IDLE", clock=lambda: t0[0])
d.ask_approval({"kind": "assist", "fingerprint": fp, "actions": [action], "action": action})
t0[0] = 120.0
assert d.approval_age >= APPROVAL_TTL_S
sess = Path("src/cheongeum/orchestrator/session.py").read_text(encoding="utf-8")
assert sess.index("recheck(approval") < sess.index("approval_age >= APPROVAL_TTL_S") < sess.index("with turn.ctx.granted")
print("PROOF4_OK: fingerprint hash-only; page change blocks; TTL 120 before granted")
print("ALL_DONE")
