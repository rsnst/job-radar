from scraper.pay import pay_from_text


def test_yearly_range():
    assert pay_from_text("<p>Salary: $120,000 - $150,000 per year</p>") == "$120,000 – $150,000 / year"


def test_k_suffix_range_with_annual_word():
    assert pay_from_text("Pay is $95k–$110k annually.") == "$95,000 – $110,000 / year"


def test_hourly_range():
    assert pay_from_text("Rate: $25.50/hr to $32/hr") == "$25.50 – $32 / hour"


def test_single_amount_with_unit():
    assert pay_from_text("Starting at $85,000 a year") == "$85,000 / year"


def test_no_pay_returns_empty():
    assert pay_from_text("<p>We build great software.</p>") == ""
    assert pay_from_text(None) == ""


def test_numbers_without_unit_are_ignored():
    assert pay_from_text("We have 120 employees and $5 million in revenue") == ""


def test_implausible_values_are_ignored():
    assert pay_from_text("Budget $3 - $4 per year") == ""


def test_description_with_lone_surrogate_still_encodes():
    from scraper.build_db import description_bytes
    assert description_bytes("<p>Pay \ud83d</p>").decode("utf-8") == "<p>Pay ?</p>"


def test_jsonld_salary_range_per_year():
    from scraper.pay import salary_from_jsonld
    node = {"baseSalary": {"@type": "MonetaryAmount", "currency": "USD",
                           "value": {"@type": "QuantitativeValue", "minValue": 90000,
                                     "maxValue": 120000, "unitText": "YEAR"}}}
    assert salary_from_jsonld(node) == "$90,000 – $120,000 / year"


def test_jsonld_hourly_single_value():
    from scraper.pay import salary_from_jsonld
    node = {"baseSalary": {"value": {"value": 28, "unitText": "HOUR"}}}
    assert salary_from_jsonld(node) == "$28 / hour"


def test_jsonld_missing_or_implausible_is_empty():
    from scraper.pay import salary_from_jsonld
    assert salary_from_jsonld({}) == ""
    assert salary_from_jsonld({"baseSalary": {"value": {"minValue": 5, "maxValue": 9, "unitText": "YEAR"}}}) == ""
    assert salary_from_jsonld({"baseSalary": {"value": {"minValue": 90000, "unitText": "MONTH"}}}) == ""
