import pytest

from scraper.location import classify, is_remote


@pytest.mark.parametrize("text,country,us,state", [
    ("Austin, TX", None, "us", "TX"),
    ("San Antonio, Texas", None, "us", "TX"),
    ("Remote - US", None, "us", None),
    ("Remote (United States)", None, "us", None),
    ("US-CA-San Jose", None, "us", "CA"),
    ("New York", "United States", "us", "NY"),
    ("Seattle", None, "us", "WA"),
    ("London, UK", None, "non", None),
    ("Bengaluru, Karnataka", None, "non", None),
    ("Toronto, ON", None, "non", None),
    ("Tbilisi, Georgia", None, "unk", None),
    ("Remote", None, "unk", None),
    ("Anywhere", "DE", "non", None),
    ("Dallas", "us", "us", "TX"),
    ("", None, "unk", None),
])
def test_classify(text, country, us, state):
    assert classify(text, country) == (us, state)


def test_remote():
    assert is_remote(None, "Remote - US", "Engineer")
    assert is_remote(True)
    assert not is_remote(False, "Austin, TX", "Engineer")
