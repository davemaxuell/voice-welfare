"""다국어: 외국어 발화를 한국어로 옮겨 같은 흐름으로 처리하고, 답을 다시 옮긴다."""

from cheongeum.language.i18n import (
    FIXED,
    LANG_BCP47,
    LANG_NAME,
    detect_lang_switch,
    detect_script_lang,
    foreign_confirmation,
    translate_in,
    translate_out,
    untranslated_korean,
)

__all__ = [
    "FIXED",
    "LANG_BCP47",
    "LANG_NAME",
    "detect_lang_switch",
    "detect_script_lang",
    "foreign_confirmation",
    "translate_in",
    "translate_out",
    "untranslated_korean",
]
