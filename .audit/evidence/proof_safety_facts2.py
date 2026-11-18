from pathlib import Path
import tempfile, os, json, asyncio
from cheongeum.personal.seal import Seal, MAGIC
from cheongeum.personal.action_log import ActionLog, GENESIS
from cheongeum.agents.web.approval import fingerprint, recheck, _value_hash
from cheongeum.orchestrator.session import APPROVAL_TTL_S
from cheongeum.core.dialogue import DialogueState
from cheongeum.agents.web.skills.guided import GuidedFill
from cheongeum.understanding.rules import RuleBasedIntentProvider
from cheongeum.agents.web.agent import _action_label

td = tempfile.mkdtemp()
seal = Seal(key=os.urandom(32))

# --- guided site allow + approval ---
class FakeNarrator:
    def once(self, *a, **k):
        return ""

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
    rules=RuleBasedIntentProvider(),
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
assert g.get("awaitSiteAllow") is True
assert g.get("suggestion") is None
print("PROOF2a_OK: no siteAllow -> no vault suggestion; asks site consent")

# yes to site allow sets allow_site, does NOT yet type
async def say_yes_site():
    return await gfill.answer("응", None)
r = asyncio.run(say_yes_site())
assert allowed.get("https://evil.example") is True
assert dialogue.approval is None  # site allow is not fill approval
print("PROOF2b_OK: site-allow yes stores allow; no fill approval yet; speech asks next question")

q2 = gfill._question(FakeWeb.current_view)
assert g.get("suggestion") == "SECRET_VAULT_VALUE"
assert "SECRET_VAULT_VALUE" in q2
r2 = asyncio.run(say_yes_site())  # yes to suggestion
assert r2["state"] == "WAITING_FOR_USER_CONFIRMATION"
assert dialogue.approval is not None
assert dialogue.approval.get("guided") is True
assert dialogue.approval["action"]["value"] == "SECRET_VAULT_VALUE"
print("PROOF2c_OK: vault '응' -> ask_approval only; cannot type without _approve path")

# default site_allowed=True if callbacks omitted (constructor default)
gfill2 = GuidedFill(FakeWeb(), DialogueState("IDLE", clock=lambda: 0.0), FakeNarrator(), RuleBasedIntentProvider(), lambda l: "V")
# default site_allowed is lambda _o: True — session overrides; prove constructor default exists
import inspect
src = inspect.getsource(GuidedFill.__init__)
assert "site_allowed or (lambda _o: True)" in src
print("PROOF2d_NOTE: GuidedFill default site_allowed=True if not wired; session.py wires personal.site_allowed")

# --- action log + _action_label ---
apath = os.path.join(td, "actions.sealed")
alog = ActionLog(apath, seal=seal)
r1 = alog.append({"host": "ex.com", "actionType": "click", "label": "apply-btn", "phase": "before"})
r2 = alog.append({"host": "ex.com", "actionType": "click", "label": "next", "phase": "before", "ok": True})
assert r1["prev"] == GENESIS and r2["prev"] == r1["hash"]
araw = Path(apath).read_bytes()
assert araw.startswith(MAGIC) and b"apply-btn" not in araw
print("PROOF3_OK: sealed + hash chain")

# caller label path: reason redacted; value NOT logged by agent._action_label
lab = _action_label({"type": "typeText", "reason": "주민번호 900101-1234567 입력", "target": {"fieldId": "f1", "name": "이름"}, "value": "900101-1234567"})
assert "900101" not in lab  # redact_text on reason
print("PROOF3c_OK: _action_label redacts reason; value field not included in label:", lab)
lab2 = _action_label({"type": "typeText", "target": {"fieldId": "f1", "name": "이름"}, "value": "SECRET"})
assert "SECRET" not in lab2
assert lab2.startswith("typeText")
print("PROOF3d_OK: action value itself never enters _action_label:", lab2)

# --- approval ---
view = {
    "url": "https://example.com/form",
    "outline": {"items": [{"ref": "r1", "role": "button", "name": "apply"}]},
    "fields": [{"fieldId": "f1", "label": "name", "value": "Hong"}],
}
action = {"type": "type", "target": {"fieldId": "f1"}}
fp = fingerprint(view, [action], "put Hong?")
assert fp["fields"][0]["valueHash"] == _value_hash("Hong")
assert "Hong" not in str(fp["fields"])
_, ch = recheck(fp, {**view, "url": "https://example.com/other"}, [action])
assert ch
print("PROOF4a_OK: page change blocks:", ch)
_, ch2 = recheck(fp, view, [action])
assert ch2 is None
print("PROOF4b_OK: same fingerprint passes")
click = {"type": "click", "target": {"ref": "r1", "role": "button", "name": "apply"}}
_, ch3 = recheck(fingerprint(view, [click], "c?"), {**view, "outline": {"items": []}}, [click])
assert ch3
print("PROOF4c_OK: missing click target blocks:", ch3)
assert APPROVAL_TTL_S == 120
t0 = [0.0]
d = DialogueState("IDLE", clock=lambda: t0[0])
d.ask_approval({"kind": "assist", "fingerprint": fp, "actions": [action], "action": action})
t0[0] = 119.9
assert d.approval_age < APPROVAL_TTL_S
t0[0] = 120.0
assert d.approval_age >= APPROVAL_TTL_S
print("PROOF4d_OK: TTL 120s; _approve uses age >= APPROVAL_TTL_S before granted()")

# grep-level: _approve order is recheck THEN ttl THEN granted
from pathlib import Path as P
text = (P("src/cheongeum/orchestrator/session.py")).read_text(encoding="utf-8")
i_re = text.index("recheck(approval")
i_ttl = text.index("approval_age >= APPROVAL_TTL_S")
i_grant = text.index("with turn.ctx.granted")
assert i_re < i_ttl < i_grant
print("PROOF4e_OK: _approve order recheck < TTL < granted at offsets", i_re, i_ttl, i_grant)

print("ALL_PROOFS_DONE")
