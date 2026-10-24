import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import publish_r2

NOW = datetime(2026, 10, 24, tzinfo=timezone.utc)


class FakeS3:
    def __init__(self, objs, uploads):
        self.objs, self.uploads, self.deleted, self.aborted = objs, uploads, [], []

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        assert Prefix == "db/"
        return {"Contents": [{"Key": k, "LastModified": t} for k, t in self.objs.items() if k.startswith(Prefix)], "IsTruncated": False}

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)

    def list_multipart_uploads(self, Bucket, Prefix):
        return {"Uploads": self.uploads}

    def abort_multipart_upload(self, Bucket, Key, UploadId):
        self.aborted.append(Key)


def test_cleanup_deletes_only_old_unlisted_db_objects_and_aborts_stale_uploads():
    old, fresh = NOW - timedelta(days=2), NOW - timedelta(minutes=5)
    s3 = FakeS3(
        {"db/config.json": old, "db/db.sqlite3.000": old, "db/db.sqlite3.old": old, "db/db.sqlite3.new-but-unlisted": fresh},
        [{"Key": "db/db.sqlite3.027", "UploadId": "a", "Initiated": old}, {"Key": "db/db.sqlite3.028", "UploadId": "b", "Initiated": fresh}],
    )
    deleted, aborted = publish_r2.cleanup(s3, "bkt", {"db/config.json", "db/db.sqlite3.000", "meta.json"}, now=NOW)
    assert deleted == ["db/db.sqlite3.old"]          # kept: listed ones and anything newer than the grace period
    assert aborted == ["db/db.sqlite3.027"]          # the in-progress (recent) upload is left alone
    assert s3.deleted == deleted
