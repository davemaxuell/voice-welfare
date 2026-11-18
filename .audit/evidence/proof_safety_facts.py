from pathlib import Path
import tempfile, os, json
from cheongeum.personal.seal import Seal, MAGIC
from cheongeum.personal.store import PersonalStore
from cheongeum.personal.action_log import ActionLog, GENESIS
from cheongeum.agents.web.approval import fingerprint, recheck, _value_hash
from cheongeum.orchestrator.session import APPROVAL_TTL_S
from cheongeum.core.dialogue import DialogueState

td = tempfile.mkdtemp()

# --- 1 vault seal ---
path = os.path.join(td, "personal.json")
seal = Seal(key=os.urandom(32))
s = PersonalStore(path, seal=seal)
s.save_vault({"name": "HongGilDong", "phone": "010-1234-5678"})
raw = Path(path).read_bytes()
assert raw.startswith(MAGIC)
assert b"HongGilDong" not in raw and b"010-1234" not in raw
assert seal.is_sealed(raw)
assert "HongGilDong" in seal.open(raw).decode()
print("PROOF1_OK: Seal present -> MAGIC+ciphertext, no vault plaintext on disk")

path2 = os.path.join(td, "plain.json")
s2 = PersonalStore(path2, seal=None)
s2.save_vault({"name": "HongGilDong"})
raw2 = Path(path2).read_bytes()
assert not Seal(key=os.urandom(32)).is_sealed(raw2)
assert b"HongGilDong" in raw2
print("PROOF1b_OK: seal=None (keyring-fail path) writes plaintext JSON")

path3 = os.path.join(td, "migrate.json")
Path(path3).write_text('{"vault":{"name":"Kim"},"applications":[],"speech":{},"siteAllow":{}}', encoding="utf-8")
PersonalStore(path3, seal=seal)
raw3 = Path(path3).read_bytes()
assert raw3.startswith(MAGIC) and b"Kim" not in raw3
print("PROOF1c_OK: plaintext migrated to sealed on load when Seal present")

# keyring fail simulation: Seal() exception swallowed in runtime -> seal=None
class Boom:
    def get_password(self, *a): raise RuntimeError("no keyring")
    def set_password(self, *a): raise RuntimeError("no keyring")
try:
    Seal(store=Boom())
    raise SystemExit("expected Seal to raise")
except RuntimeError as e:
    print("PROOF1d_OK: keyring failure raises:", e)

# --- 2 guided: site allow + approval gates in code paths ---
# Prove _question blocks suggestion without site allow
class FakeWeb:
    current_view = {"url": "https://evil.example/form", "pageId": "external", "fields": [
        {"fieldId": "f1", "label": "이름", "visible": True, "sensitive": False, "searchable": False, "type": "text"}
    ]}
from cheongeum.agents.web.skills.guided import GuidedFill
from cheongeum.understanding.rules import RuleBasedIntentProvider
from cheongeum.speech.screen import Narrator

allowed = {}
dialogue = DialogueState("IDLE", clock=lambda: 0.0)
gfill = GuidedFill(
    web=FakeWeb(),
    dialogue=dialogue,
    narrator=Narrator(),
    rules=RuleBasedIntentProvider(),
    saved_value=lambda label: "SECRET_VAULT_VALUE" if "이름" in label or True else None,
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
print("PROOF2a_OK: without siteAllow, question asks consent and does NOT expose vault value as suggestion")

# after allow, suggestion appears but fill still goes through _ask_fill -> ask_approval
allowed["https://evil.example"] = True
g["awaitSiteAllow"] = False
q2 = gfill._question(FakeWeb.current_view)
assert "SECRET_VAULT_VALUE" in q2
assert g.get("suggestion") == "SECRET_VAULT_VALUE"
# answer '응' with suggestion -> ask_approval, not direct type
import asyncio
async def try_answer():
    return await gfill.answer("응", None)
# need view match
FakeWeb.current_view = {**FakeWeb.current_view, "url": "https://evil.example/form"}
# build_assist_action needed on web
def build_assist_action(field_, value):
    return {"id": "a1", "type": "typeText", "target": {"fieldId": field_["fieldId"]}, "value": value, "requiresConfirmation": True}
FakeWeb.build_assist_action = staticmethod(build_assist_action)
# active checks url
result = asyncio.get_event_loop().run_until_complete(try_answer())
assert result["state"] == "WAITING_FOR_USER_CONFIRMATION"
assert dialogue.approval is not None
assert dialogue.approval.get("kind") == "assist"
assert dialogue.approval.get("guided") is True
print("PROOF2b_OK: vault suggestion '응' goes to ask_approval, not direct fill; state=", result["state"])

# --- 3 action log ---
apath = os.path.join(td, "actions.sealed")
alog = ActionLog(apath, seal=seal)
r1 = alog.append({"host": "ex.com", "actionType": "click", "label": "apply-btn", "phase": "before"})
r2 = alog.append({"host": "ex.com", "actionType": "click", "label": "next", "phase": "before", "ok": True})
assert r1["prev"] == GENESIS and r2["prev"] == r1["hash"] and len(r1["hash"]) == 64
araw = Path(apath).read_bytes()
assert araw.startswith(MAGIC) and b"apply-btn" not in araw
opened = json.loads(seal.open(araw).decode())
assert opened["rows"][0]["label"] == "apply-btn"
print("PROOF3_OK: ActionLog sealed + hash chain")

apath2 = os.path.join(td, "actions.json")
ActionLog(apath2, seal=None).append({"label": "phone 010-9999-8888", "actionType": "type"})
assert b"010-9999" in Path(apath2).read_bytes()
print("PROOF3b_OK: seal=None stores label plaintext; append itself does not redact")

# --- 4 approval fingerprint ---
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
assert ch and "changed" in ch.lower() or "바뀌" in ch
print("PROOF4a_OK: valueHash only; page change blocks:", ch)
_, ch2 = recheck(fp, view, [action])
assert ch2 is None
print("PROOF4b_OK: identical view passes recheck")
click = {"type": "click", "target": {"ref": "r1", "role": "button", "name": "apply"}}
fp_c = fingerprint(view, [click], "click?")
_, ch3 = recheck(fp_c, {**view, "outline": {"items": []}}, [click])
assert ch3
print("PROOF4c_OK: missing target blocks:", ch3)
assert APPROVAL_TTL_S == 120
# TTL gate via DialogueState
t0 = [0.0]
d = DialogueState("IDLE", clock=lambda: t0[0])
d.ask_approval({"kind": "assist", "fingerprint": fp, "actions": [action], "action": action})
assert d.approval_age == 0.0
t0[0] = 119.0
assert d.approval_age < APPROVAL_TTL_S
t0[0] = 120.0
assert d.approval_age >= APPROVAL_TTL_S
print("PROOF4d_OK: APPROVAL_TTL_S=120; age crosses at 120s (session._approve uses >=)")

print("ALL_PROOFS_DONE")
