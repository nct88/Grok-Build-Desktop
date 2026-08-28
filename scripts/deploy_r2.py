#!/usr/bin/env python3
"""Deploy Grok Build release artifacts and latest.json feed to Cloudflare R2.

Usage:
  python scripts/deploy_r2.py
  python scripts/deploy_r2.py --version 0.5.47

Reads configuration from .env or environment variables:
  R2_ENDPOINT          - e.g. https://<account_id>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID     - Cloudflare R2 Access Key ID
  R2_SECRET_ACCESS_KEY - Cloudflare R2 Secret Access Key
  R2_BUCKET            - R2 Bucket Name (e.g. grok-build or releases)
  R2_PUBLIC_URL        - (Optional) Public CDN URL, e.g. https://dl.example.com
"""
import sys
import os
import json
import pathlib
import argparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_env():
    env = dict(os.environ)
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def main():
    parser = argparse.ArgumentParser(description="Deploy release artifacts to Cloudflare R2")
    parser.add_argument("--version", "-v", help="Release version (defaults to package.json version)")
    parser.add_argument("--dry-run", action="store_true", help="Simulate upload without uploading")
    args = parser.parse_args()

    pkg_path = ROOT / "package.json"
    pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
    version = args.version or pkg.get("version")
    if not version:
        sys.exit("Error: Could not determine version.")

    env = load_env()
    req_keys = ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")
    missing = [k for k in req_keys if not env.get(k)]
    if missing:
        print(f"Notice: Missing R2 credentials in environment or .env: {', '.join(missing)}")
        print("Please configure R2 credentials to deploy to Cloudflare R2.")
        print("Format in .env:")
        print("  R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com")
        print("  R2_ACCESS_KEY_ID=...")
        print("  R2_SECRET_ACCESS_KEY=...")
        print("  R2_BUCKET=grok-build-releases")
        return 1

    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        sys.exit("Error: boto3 is required for R2 deployment. Run: pip install boto3")

    bucket = env["R2_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=env["R2_ENDPOINT"],
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    def put_file(local_path: pathlib.Path, key: str, ctype: str, cache: str | None = None):
        extra = {"ContentType": ctype}
        if cache:
            extra["CacheControl"] = cache
        if args.dry_run:
            print(f"  [DRY-RUN] Would upload {key} ({local_path.stat().st_size:,} bytes)")
        else:
            s3.upload_file(str(local_path), bucket, key, ExtraArgs=extra)
            print(f"  ✓ {key} ({local_path.stat().st_size:,} bytes)")

    version_dist = ROOT / "dist" / version
    if not version_dist.exists():
        sys.exit(f"Error: Release folder not found at {version_dist}. Run 'npm run release' or build first.")

    print(f"Deploying Grok Build v{version} -> R2 bucket '{bucket}'...")

    # Upload versioned release artifacts
    print("\n[1] Versioned release files:")
    for root_dir, _, files in os.walk(version_dist):
        for f in files:
            full_path = pathlib.Path(root_dir) / f
            rel_path = full_path.relative_to(version_dist).as_posix()
            r2_key = f"releases/{version}/{rel_path}"

            ctype = "application/octet-stream"
            if f.endswith(".json"):
                ctype = "application/json; charset=utf-8"
            elif f.endswith(".zip"):
                ctype = "application/zip"
            elif f.endswith(".exe"):
                ctype = "application/vnd.microsoft.portable-executable"

            put_file(full_path, r2_key, ctype)

    # Upload latest.json update feed
    latest_file = ROOT / "dist" / "latest.json"
    if latest_file.exists():
        print("\n[2] Update feed (latest.json):")
        put_file(latest_file, "latest.json", "application/json; charset=utf-8", cache="no-cache, no-store, must-revalidate")
        put_file(latest_file, f"releases/{version}/latest.json", "application/json; charset=utf-8")

    # Upload fixed-name links for convenient download
    setup_file = version_dist / "install" / f"Grok-Build-Setup-{version}.exe"
    portable_file = version_dist / "portable" / f"Grok-Build-{version}-win32-x64-portable.exe"
    zip_file = version_dist / "portable" / f"Grok-Build-{version}-win32-x64.zip"

    print("\n[3] Fixed latest download links (dl/):")
    if setup_file.exists():
        put_file(setup_file, "dl/Grok-Build-Setup.exe", "application/vnd.microsoft.portable-executable", cache="no-cache")
    if portable_file.exists():
        put_file(portable_file, "dl/Grok-Build-Portable.exe", "application/vnd.microsoft.portable-executable", cache="no-cache")
    if zip_file.exists():
        put_file(zip_file, "dl/Grok-Build.zip", "application/zip", cache="no-cache")

    print(f"\nSuccessfully deployed v{version} to Cloudflare R2.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
