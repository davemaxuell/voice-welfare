"""④ Agent A 웹 탐색·실행: 모든 조작은 PolicyGuard → 실행 → 재관찰. browser/는 Playwright 실행기."""

from cheongeum.agents.web.agent import ExecContext, FieldResolution, WebExecutionAgent, WebOutcome
from cheongeum.agents.web.auth_page import AuthPageKind, auth_page_kind, first_fill_field, still_needs_auth
from cheongeum.agents.web.autopilot import MAIN_CHARS, Autopilot, AutopilotResult, page_for_llm
from cheongeum.agents.web.digest import PAGE_KIND_LABEL, PageDigest, digest_for_llm, digest_page
from cheongeum.agents.web.profile import (
    INCOME_OPTIONS,
    FieldProfile,
    SiteProfile,
    Validation,
    create_mock_welfare_profile,
    field_vocabulary,
    match_option,
    normalize_term,
    validate_address,
    validate_household_size,
    validate_name,
    validate_phone,
    validate_yes_no,
)

__all__ = [
    "AuthPageKind",
    "Autopilot",
    "AutopilotResult",
    "ExecContext",
    "FieldProfile",
    "FieldResolution",
    "INCOME_OPTIONS",
    "MAIN_CHARS",
    "PAGE_KIND_LABEL",
    "PageDigest",
    "SiteProfile",
    "Validation",
    "WebExecutionAgent",
    "WebOutcome",
    "auth_page_kind",
    "create_mock_welfare_profile",
    "digest_for_llm",
    "digest_page",
    "field_vocabulary",
    "first_fill_field",
    "match_option",
    "normalize_term",
    "page_for_llm",
    "still_needs_auth",
    "validate_address",
    "validate_household_size",
    "validate_name",
    "validate_phone",
    "validate_yes_no",
]
