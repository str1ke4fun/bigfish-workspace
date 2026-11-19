"""Build payload.json / payload.txt from the README memorial block."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

SHA = "36ea4869ad9ec223d2eddb6bff1ca9e74cec11f82d12b64570731a2c2ea19eb5"
PHRASE = "他曾经在这里。"
URL = "https://github.com/str1ke4fun/bigfish-workspace/tree/archive/2026-11-19/memorial/xiaohei"
CREATED = "2026-11-19T17:32:16+08:00"
START = "<!-- memorial:start -->"
END = "<!-- memorial:end -->"


def memorial_from_readme(root: Path) -> str:
    text = (root / "README.md").read_text(encoding="utf-8")
    match = re.search(re.escape(START) + r"(.*?)" + re.escape(END), text, re.S)
    if not match:
        raise SystemExit("memorial markers not found in README.md")
    return match.group(1).strip()


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    memorial = memorial_from_readme(root)
    payload = {
        "sha256": SHA,
        "memorial_sha256": hashlib.sha256(memorial.encode("utf-8")).hexdigest(),
        "memorial": memorial,
        "phrase": PHRASE,
        "url": URL,
        "created": CREATED,
    }
    out = root / "06_payloads"
    (out / "payload.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out / "payload.txt").write_text(
        "一张照片的统一载荷\n"
        "==================\n\n"
        f"SHA-256        {SHA}\n"
        f"纪念文 SHA-256 {payload['memorial_sha256']}\n"
        f"短句           {PHRASE}\n"
        f"URL            {URL}\n"
        f"时间           {CREATED}\n\n"
        "纪念文\n"
        "------\n"
        + memorial
        + "\n",
        encoding="utf-8",
    )
    print("memorial_sha256", payload["memorial_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
