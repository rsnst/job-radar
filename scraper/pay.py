"""Pay text found in a job description, for postings whose job list has no pay field.

Only explicit amounts count: a dollar range or a single amount with a unit ("per year", "/hr").
Anything ambiguous returns "" so the card shows nothing rather than a wrong number.
"""
from __future__ import annotations

import html as _html
import re

_TAG = re.compile(r"<[^>]+>")
_NUM = r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kK])?"
_UNIT = r"(?:per|/|a|an|each)\s*(year|yr|annum|annually|hour|hr)\b"
_UNIT_NC = r"(?:per|/|a|an|each)\s*(?:year|yr|annum|annually|hour|hr)\b"  # no capture, keeps group numbers
_RANGE = re.compile(
    rf"\$\s*{_NUM}\s*(?:{_UNIT_NC})?\s*(?:-|–|—|to)\s*\$?\s*{_NUM}\s*(?:{_UNIT}|(?=\W))", re.I)
_SINGLE = re.compile(rf"\$\s*{_NUM}\s*{_UNIT}", re.I)


def _value(num: str, k: str) -> float:
    v = float(num.replace(",", ""))
    return v * 1000 if k else v


def _unit(text: str) -> str | None:
    t = text.lower()
    if re.search(r"\b(year|yr|annum|annually)\b", t):
        return "year"
    if re.search(r"\b(hour|hr)\b", t):
        return "hour"
    return None


def _fmt(v: float) -> str:
    return f"${v:,.0f}" if v >= 100 or v == int(v) else f"${v:,.2f}"


def _plausible(lo: float, hi: float, unit: str) -> bool:
    if unit == "year":
        return 15_000 <= lo <= hi <= 1_000_000
    return 7 <= lo <= hi <= 500


def pay_from_text(body: str | None) -> str:
    """e.g. "$120,000 - $150,000 per year" -> "$120,000 – $150,000 / year". "" when nothing clear is found."""
    if not body:
        return ""
    text = _html.unescape(_TAG.sub(" ", body))
    text = re.sub(r"\s+", " ", text)
    for m in _RANGE.finditer(text):
        lo = _value(m.group(1), m.group(2) or "")
        hi = _value(m.group(3), m.group(4) or "")
        unit = _unit(text[m.end(0) - 40 if m.end(0) > 40 else 0:m.end(0) + 20]) or _unit(m.group(0))
        if unit and lo <= hi and _plausible(lo, hi, unit):
            return f"{_fmt(lo)} – {_fmt(hi)} / {unit}"
    for m in _SINGLE.finditer(text):
        v = _value(m.group(1), m.group(2) or "")
        unit = _unit(m.group(0))
        if unit and _plausible(v, v, unit):
            return f"{_fmt(v)} / {unit}"
    return ""


def salary_from_jsonld(node: dict) -> str:
    """Pay from a schema.org JobPosting's baseSalary, e.g. min/max with unitText YEAR or HOUR."""
    base = node.get("baseSalary")
    if not isinstance(base, dict):
        return ""
    val = base.get("value") if isinstance(base.get("value"), dict) else base
    unit_raw = str(val.get("unitText") or base.get("unitText") or "").upper()
    unit = {"YEAR": "year", "HOUR": "hour"}.get(unit_raw)
    if not unit:
        return ""
    try:
        lo = float(val.get("minValue") or val.get("value") or 0)
        hi = float(val.get("maxValue") or lo)
    except (TypeError, ValueError):
        return ""
    if lo <= 0 or lo > hi or not _plausible(lo, hi, unit):
        return ""
    if lo == hi:
        return f"{_fmt(lo)} / {unit}"
    return f"{_fmt(lo)} – {_fmt(hi)} / {unit}"
