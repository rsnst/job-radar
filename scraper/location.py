"""Classify a job location as US / non-US / unknown and pull out a US state code."""
from __future__ import annotations

import re

STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
}
NAME_TO_CODE = {v.lower(): k for k, v in STATES.items()}
# "Georgia" and "Washington" are ambiguous on their own; only trust them with other US context.
AMBIGUOUS_NAMES = {"georgia", "washington"}

US_COUNTRY = {"us", "usa", "united states", "united states of america", "u.s.", "u.s.a."}

BIG_US_CITIES = {
    "new york city": "NY", "nyc": "NY", "san francisco": "CA", "los angeles": "CA", "seattle": "WA",
    "chicago": "IL", "boston": "MA", "austin": "TX", "dallas": "TX", "houston": "TX",
    "san antonio": "TX", "atlanta": "GA", "denver": "CO", "miami": "FL", "philadelphia": "PA",
    "phoenix": "AZ", "san diego": "CA", "san jose": "CA", "palo alto": "CA", "mountain view": "CA",
    "menlo park": "CA", "sunnyvale": "CA", "washington dc": "DC", "washington, d.c.": "DC",
    "minneapolis": "MN", "detroit": "MI", "pittsburgh": "PA", "nashville": "TN", "charlotte": "NC",
    "raleigh": "NC", "salt lake city": "UT", "portland": "OR", "baltimore": "MD", "st. louis": "MO",
    "kansas city": "MO", "columbus": "OH", "cleveland": "OH", "indianapolis": "IN", "tampa": "FL",
    "orlando": "FL", "las vegas": "NV", "brooklyn": "NY", "jersey city": "NJ", "irvine": "CA",
    "plano": "TX", "redmond": "WA", "bellevue": "WA", "cambridge, ma": "MA",
}

FOREIGN = [
    "canada", "toronto", "vancouver", "montreal", "ontario", "british columbia", "quebec", "alberta",
    "calgary", "ottawa", "mexico", "united kingdom", "uk", "england", "london", "scotland", "ireland",
    "dublin", "germany", "berlin", "munich", "france", "paris", "spain", "madrid", "barcelona",
    "portugal", "lisbon", "netherlands", "amsterdam", "belgium", "switzerland", "zurich", "austria",
    "poland", "warsaw", "krakow", "italy", "milan", "sweden", "stockholm", "norway", "denmark",
    "copenhagen", "finland", "czech", "prague", "romania", "hungary", "greece", "ukraine", "israel",
    "tel aviv", "india", "bangalore", "bengaluru", "hyderabad", "pune", "chennai", "mumbai",
    "gurgaon", "gurugram", "noida", "delhi", "singapore", "philippines", "manila", "japan", "tokyo",
    "china", "shanghai", "beijing", "hong kong", "taiwan", "korea", "seoul", "australia", "sydney",
    "melbourne", "new zealand", "brazil", "são paulo", "sao paulo", "argentina", "buenos aires",
    "colombia", "bogota", "chile", "peru", "costa rica", "uae", "dubai", "saudi", "south africa",
    "nigeria", "kenya", "egypt", "turkey", "istanbul", "vietnam", "thailand", "malaysia", "indonesia",
    "pakistan", "emea", "apac", "latam", "europe",
]
_FOREIGN_RE = re.compile(r"\b(" + "|".join(re.escape(f) for f in FOREIGN) + r")\b")
_STATE_ABBR_RE = re.compile(r"(?:,|\s-|\(|^|\|)\s*(" + "|".join(STATES) + r")\b(?!\.\w)")
_ICIMS_RE = re.compile(r"\bUS-([A-Z]{2})\b")
_US_RE = re.compile(r"\b(united states|u\.s\.a?\.?|usa)\b", re.I)
_US_UPPER_RE = re.compile(r"\bUS\b")
_STATE_NAME_RE = re.compile(r"\b(" + "|".join(re.escape(n) for n in NAME_TO_CODE) + r")\b")


def classify(text: str | None, country: str | None = None) -> tuple[str, str | None]:
    """Return (us, state) where us is 'us', 'non', or 'unk'."""
    t = (text or "").strip()
    c = (country or "").strip().lower()
    state = _state(t)
    if c:
        if c in US_COUNTRY:
            return "us", state or _city_state(t)
        return "non", None
    if not t:
        return "unk", None
    low = t.lower()
    has_us = bool(_US_RE.search(t) or _US_UPPER_RE.search(t) or _ICIMS_RE.search(t))
    if state or has_us:
        # "Remote - US or Canada" etc. still counts as US-eligible.
        return "us", state
    st = _city_state(t)
    if st:
        return "us", st
    if _FOREIGN_RE.search(low):
        return "non", None
    return "unk", None


def _city_state(t: str) -> str | None:
    low = t.lower()
    for city, st in BIG_US_CITIES.items():
        if city in low:
            return st
    return None


def _state(t: str) -> str | None:
    if not t:
        return None
    m = _ICIMS_RE.search(t)
    if m and m.group(1) in STATES:
        return m.group(1)
    m = _STATE_ABBR_RE.search(t)
    if m:
        return m.group(1)
    low = t.lower()
    for m in _STATE_NAME_RE.finditer(low):
        name = m.group(1)
        if name in AMBIGUOUS_NAMES and not (_US_RE.search(t) or _US_UPPER_RE.search(t)):
            continue
        return NAME_TO_CODE[name]
    return None


REMOTE_RE = re.compile(r"\bremote\b|\banywhere\b|work from home|\bwfh\b", re.I)


def is_remote(*parts) -> bool:
    for p in parts:
        if p is True:
            return True
        if isinstance(p, str) and REMOTE_RE.search(p):
            return True
    return False
