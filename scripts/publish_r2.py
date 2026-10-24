"""Upload the built site data (db/ chunks, config, meta.json) to the R2 bucket.

Usage: python scripts/publish_r2.py <site dir> [--dry-run]
Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (GitHub secrets).
After a fully successful upload it deletes db/ objects not in this build (older than 1 hour) and aborts unfinished uploads older than 24 hours.
Files are uploaded with their relative paths as keys, e.g. db/config.json, meta.json.
meta.json is uploaded last, so a reader never sees a new meta.json with old chunks.
"""
import mimetypes
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

GRACE = timedelta(hours=1)        # keep recently replaced chunks so readers holding an older meta.json still work
STALE_UPLOAD = timedelta(hours=24)  # unfinished multipart uploads older than this are aborted


def files_in(root: Path):
    data = sorted(p for p in (root / "db").glob("*") if p.is_file())
    meta = [root / "meta.json"] if (root / "meta.json").exists() else []
    return [(p, p.relative_to(root).as_posix()) for p in data] + [(p, p.name) for p in meta]


def cleanup(s3, bucket, keep, now=None):
    """Delete db/ objects not in this build (older than GRACE) and abort stale unfinished uploads.
    Only touches the db/ prefix; meta.json and anything else (e.g. check/) is left alone."""
    now = now or datetime.now(timezone.utc)
    deleted, aborted = [], []
    token = None
    while True:
        kw = {"Bucket": bucket, "Prefix": "db/"}
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        for o in page.get("Contents", []):
            if o["Key"] not in keep and now - o["LastModified"] > GRACE:
                s3.delete_object(Bucket=bucket, Key=o["Key"])
                deleted.append(o["Key"])
        if not page.get("IsTruncated"):
            break
        token = page.get("NextContinuationToken")
    for u in s3.list_multipart_uploads(Bucket=bucket, Prefix="db/").get("Uploads", []):
        if now - u["Initiated"] > STALE_UPLOAD:
            s3.abort_multipart_upload(Bucket=bucket, Key=u["Key"], UploadId=u["UploadId"])
            aborted.append(u["Key"])
    return deleted, aborted


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    root = Path(argv[0])
    dry = "--dry-run" in argv
    items = files_in(root)
    if dry:
        for p, key in items:
            print(f"would upload {p} -> {key} ({p.stat().st_size} bytes)")
        return 0
    import boto3  # imported here so --dry-run works without it
    s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT"], region_name="auto",
                      aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                      aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])
    bucket = os.environ["R2_BUCKET"]
    for p, key in items:
        ctype = mimetypes.guess_type(key)[0] or "application/octet-stream"
        with p.open("rb") as f:
            s3.upload_fileobj(f, bucket, key, ExtraArgs={"ContentType": ctype,
                                                         "CacheControl": "public, max-age=300" if key.startswith("db/") else "no-cache"})
        print(f"uploaded {key} ({p.stat().st_size} bytes)", flush=True)
    # Reached only if every upload succeeded (an exception above stops the script before any deletion).
    try:
        deleted, aborted = cleanup(s3, bucket, {key for _, key in items})
        print(f"cleanup: deleted {len(deleted)} old db/ objects, aborted {len(aborted)} stale uploads", flush=True)
    except Exception as e:  # cleanup is best-effort; the publish itself already succeeded
        print(f"cleanup skipped: {type(e).__name__}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
