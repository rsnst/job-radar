"""Upload the built site data (db/ chunks, config, meta.json) to the R2 bucket.

Usage: python scripts/publish_r2.py <site dir> [--dry-run]
Env: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (GitHub secrets).
Files are uploaded with their relative paths as keys, e.g. db/config.json, meta.json.
meta.json is uploaded last, so a reader never sees a new meta.json with old chunks.
"""
import mimetypes
import os
import sys
from pathlib import Path


def files_in(root: Path):
    data = sorted(p for p in (root / "db").glob("*") if p.is_file())
    meta = [root / "meta.json"] if (root / "meta.json").exists() else []
    return [(p, p.relative_to(root).as_posix()) for p in data] + [(p, p.name) for p in meta]


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
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
