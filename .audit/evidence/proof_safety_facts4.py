import asyncio
from cheongeum.core.dialogue import DialogueState
from cheongeum.agents.web.skills.guided import GuidedFill
from cheongeum.agents.web.agent import _action_label
from cheongeum.agents.web.approval import fingerprint, recheck, _value_hash
from cheongeum.orchestrator.session import APPROVAL_TTL_S
from cheongeum.personal.seal import Seal, MAGIC
from cheongeum.personal.action_log import ActionLog, GENESIS
from pathlib import Path
import tempfile, os

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
        "fields": [{"fieldId": "f1", "label": "이름", "value": "", "visible": True, "sensitive": False, "searchable": False, "type": "text"}],
    }
    @staticmethod
    def build_assist_action(field_, value):
        return {"id": "a1", "type": "typeText", "target": {"fieldId": field_["fieldId"]}, "value": value, "requiresConfirmation": True}

allowed = {}
dialogue = DialogueState("IDLE", clock=lambda: 0.0)
gfill = GuidedFill(FakeWeb(), dialogue, FakeNarrator(), FakeRules(), lambda label: "SECRET_VAULT_VALUE",
                   site_allowed=lambda o: bool(allowed.get(o)), allow_site=lambda o: allowed.__setitem__(o, True))
dialogue.start_guided("https://evil.example/form", ["f1"])
g = dialogue.guided
g.update(origin="https://evil.example", skipVault=False)
assert "SECRET_VAULT_VALUE" not in gfill._question(FakeWeb.current_view)
assert g["awaitSiteAllow"] and g["suggestion"] is None
print("PROOF2a_OK")

async def ans(t):
    return await gfill.answer(t, None)
assert asyncio.run(ans("응")) and allowed.get("https://evil.example") and dialogue.approval is None
print("PROOF2b_OK")
assert gfill._question(FakeWeb.current_view) and g["suggestion"] == "SECRET_VAULT_VALUE"
r2 = asyncio.run(ans("응"))
assert r2["state"] == "WAITING_FOR_USER_CONFIRMATION" and dialogue.approval["action"]["value"] == "SECRET_VAULT_VALUE"
print("PROOF2c_OK: vault yes -> approval only")

dialogue.clear_approval()
dialogue.start_guided("https://evil.example/form", ["f1"])
g = dialogue.guided
g.update(origin="https://evil.example", skipVault=True, suggestion=None, awaitSiteAllow=False)
r3 = asyncio.run(ans("Hong"))
assert r3["state"] == "WAITING_FOR_USER_CONFIRMATION" and dialogue.approval
print("PROOF2d_OK: spoken value also needs approval")

# only caller of assist_approved is session._approve
import pathlib, re
form = pathlib.Path("src/cheongeum").rglob("*.py")
hits = []
for p in pathlib.Path("src/cheongeum").rglob("*.py"):
    for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        if "assist_approved" in line and "def assist_approved" not in line and "after_assist" not in line:
            hits.append(f"{p}:{i}:{line.strip()}")
print("assist_approved call sites:", hits)
assert any("session.py" in h and "_approve" in open(h.split(":")[0], encoding="utf-8").read() for h in hits) or any("session.py" in h for h in hits)
assert len([h for h in hits if "assist_approved(" in h]) == 1
print("PROOF2e_OK: sole assist_approved( call is session._approve")

td = tempfile.mkdtemp(); seal = Seal(key=os.urandom(32))
apath = os.path.join(td, "a.sealed")
log = ActionLog(apath, seal=seal)
a = log.append({"label": "apply-btn", "actionType": "click"})
b = log.append({"label": "next", "actionType": "click"})
assert a["prev"] == GENESIS and b["prev"] == a["hash"] and Path(apath).read_bytes().startswith(MAGIC)
assert b"apply-btn" not in Path(apath).read_bytes()
lab = _action_label({"type": "typeText", "reason": "주민번호 900101-1234567", "target": {"name": "이름"}, "value": "900101-1234567"})
assert "900101" not in lab
assert "SECRET" not in _action_label({"type": "typeText", "target": {"name": "이름"}, "value": "SECRET"})
print("PROOF3_OK", lab)

view = {"url": "https://example.com/form", "outline": {"items": [{"ref": "r1", "role": "button", "name": "apply"}]}, "fields": [{"fieldId": "f1", "label": "name", "value": "Hong"}]}
action = {"type": "type", "target": {"fieldId": "f1"}}
fp = fingerprint(view, [action], "put?")
assert "Hong" not in str(fp["fields"])
_, ch = recheck(fp, {**view, "url": "https://example.com/x"}, [action]); assert ch
_, ok = recheck(fp, view, [action]); assert ok is None
assert APPROVAL_TTL_S == 120
t0=[0.0]; d=DialogueState("IDLE", clock=lambda: t0[0]); d.ask_approval({"kind":"assist","fingerprint":fp,"actions":[action],"action":action}); t0[0]=120.0
assert d.approval_age >= APPROVAL_TTL_S
sess = Path("src/cheongeum/orchestrator/session.py").read_text(encoding="utf-8")
assert sess.index("recheck(approval") < sess.index("approval_age >= APPROVAL_TTL_S") < sess.index("with turn.ctx.granted")
print("PROOF4_OK", ch)
print("ALL_DONE")
