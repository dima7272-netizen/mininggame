#!/usr/bin/env python3
"""Read published Roblox experience configs without changing the game.

The outer artifact stores every config as a JSON string. This keeps large
integer literals intact when the balance service later parses the bundle in
JavaScript.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPOSITORY = "InExperienceConfig"
SAFE_NAME = re.compile(r"^[A-Za-z0-9_. -]{1,120}$")


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def main():
    api_key = os.environ.get("ROBLOX_API_KEY", "").strip()
    universe_id = os.environ.get("ROBLOX_UNIVERSE_ID", "").strip()
    environment = os.environ.get("ROBLOX_ENV", "UNKNOWN").strip()
    requested_name = os.environ.get("CONFIG_NAME", "").strip()
    output_path = Path(os.environ.get("OUTPUT_PATH", "configs.json"))

    if not api_key:
        fail("ROBLOX_API_KEY secret is missing")
    if not universe_id:
        fail("ROBLOX_UNIVERSE_ID is missing")
    if requested_name and not SAFE_NAME.fullmatch(requested_name):
        fail("CONFIG_NAME contains unsupported characters")

    url = (
        "https://apis.roblox.com/"
        "creator-configs-public-api/v1/configs/"
        f"universes/{universe_id}/repositories/{REPOSITORY}"
    )
    request = urllib.request.Request(
        url,
        headers={"x-api-key": api_key, "Accept": "application/json"},
        method="GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        fail(f"GET Roblox configs: HTTP {exc.code}: {detail[:500]}")
    except urllib.error.URLError as exc:
        fail(f"GET Roblox configs: network error: {exc}")

    try:
        entries = json.loads(raw).get("entries", {}) or {}
    except (json.JSONDecodeError, AttributeError) as exc:
        fail(f"GET Roblox configs returned invalid JSON: {exc}")

    if not isinstance(entries, dict):
        fail("GET Roblox configs did not return an entries object")
    if requested_name:
        if requested_name not in entries:
            fail(f"Config {requested_name} does not exist in {environment}")
        entries = {requested_name: entries[requested_name]}
    if not entries:
        fail(f"Roblox returned no published configs for {environment}")

    # Inner values remain source strings after the outer JSON is parsed by JS.
    config_sources = {
        name: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        for name, value in sorted(entries.items())
    }
    bundle = {
        "environment": environment,
        "universeId": universe_id,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "configs": config_sources,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(bundle, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Read {len(config_sources)} published config(s) from {environment}")


if __name__ == "__main__":
    main()
