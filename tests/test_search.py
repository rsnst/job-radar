"""Run the browser's actual query builders against the published DB schema."""
import json
from pathlib import Path
import sqlite3
import subprocess

import pytest

from scraper.build_db import SCHEMA, INDEXES

ROOT = Path(__file__).resolve().parents[1]


def query(builder, filters):
    script = f"import {{ {builder} }} from './web/query.js'; console.log(JSON.stringify({builder}({json.dumps(filters)}, {{with_pay: 1}})));"
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script], cwd=ROOT))


@pytest.fixture
def db():
    con = sqlite3.connect(":memory:")
    con.executescript(SCHEMA)
    con.executemany("INSERT INTO boards(id,company,url,jobs) VALUES (?,?,?,?)", [
        (1, "Banking Example", "https://example.test/a", 2),
        (2, "Banking Sample", "https://example.test/b", 2),
    ])
    con.executemany("INSERT INTO jobs(id,title,company,loc,board) VALUES (?,?,?,?,?)", [
        (1, "Risk analyst", "Banking Example", "Texas", 1),
        (2, "C++ developer", "Banking Example", "Texas", 1),
        (3, "C# developer", "Banking Sample", "Texas", 2),
        (4, ".NET developer", "Banking Sample", "Texas", 2),
    ])
    con.executescript(INDEXES)
    yield con
    con.close()


@pytest.mark.parametrize("text,ids", [("ris anal", [1]), ("C++ dev", [2]), ("C# dev", [3]), (".net dev", [4]), ("\"risk\" OR nope", [])])
def test_job_search_prefixes(db, text, ids):
    q = query("jobsQuery", {"q": text})
    assert [r[0] for r in db.execute(q["sql"], q["params"])] == ids


def test_company_prefix_and_stable_order(db):
    q = query("boardsQuery", {"q": "bank"})
    assert [r[0] for r in db.execute(q["sql"], q["params"])] == [1, 2]
