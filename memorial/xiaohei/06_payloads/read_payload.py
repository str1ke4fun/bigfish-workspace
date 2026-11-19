"""Read the canonical payload back from every file-internal channel."""
from __future__ import annotations

import hashlib
import json
import re
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "06_payloads"
PAYLOAD = json.loads((P / "payload.json").read_text(encoding="utf-8"))
SHA = PAYLOAD["sha256"]
MEMORIAL_SHA = PAYLOAD["memorial_sha256"]
MEMORIAL = PAYLOAD["memorial"]
PHRASE = PAYLOAD["phrase"]
URL = PAYLOAD["url"]

results: list[tuple[str, bool, str]] = []


def check(name, fn):
    try:
        results.append((name, True, fn() or ""))
    except Exception as exc:  # noqa: BLE001
        results.append((name, False, f"{type(exc).__name__}: {exc}"))


def from_readme() -> str:
    raw = (ROOT / "README.md").read_text(encoding="utf-8")
    match = re.search(r"<!-- memorial:start -->(.*?)<!-- memorial:end -->", raw, re.S)
    assert match, "memorial markers missing"
    text = match.group(1).strip()
    assert text == MEMORIAL
    assert hashlib.sha256(text.encode()).hexdigest() == MEMORIAL_SHA
    return f"{len(text.encode())} bytes"


def from_json() -> str:
    raw = (P / "payload.json").read_bytes()
    assert json.loads(raw) == PAYLOAD
    return f"{len(raw)} bytes"


def from_exif() -> str:
    im = Image.open(P / "dog_payload_exif_xmp.jpg")
    exif = im.getexif()
    assert exif.get(0x010E) == "He was here.", repr(exif.get(0x010E))
    raw = exif.get(0x9286)
    assert raw.startswith(b"UNICODE\x00"), raw[:16]
    note = raw[8:].decode("utf-16-be")
    header, _, body = note.partition("\n\n")
    assert f"MEMORIAL_SHA256={MEMORIAL_SHA}" in header
    assert body == MEMORIAL
    return "ImageDescription + UserComment"


def from_xmp() -> str:
    raw = (P / "dog_payload_exif_xmp.jpg").read_bytes().decode("utf-8", "ignore")
    match = re.search(r"<dog:Memorial>(.*?)</dog:Memorial>", raw, re.S)
    assert match, "dog:Memorial missing"
    text = (
        match.group(1)
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&amp;", "&")
    )
    assert text == MEMORIAL
    assert MEMORIAL_SHA in raw
    return "XMP dog:Memorial / dog:MemorialSHA256"


def from_png() -> str:
    text = Image.open(P / "dog_payload.png").text
    assert text.get("Memorial") == MEMORIAL
    assert text.get("Memorial-SHA256") == MEMORIAL_SHA
    assert json.loads(text["Payload-JSON"])["memorial"] == MEMORIAL
    return f"{len(text)} text keys"


def from_ffd9() -> str:
    path = P / "dog_payload_ffd9.jpg"
    im = Image.open(path)
    im.load()
    assert im.size == (1920, 1280)
    with zipfile.ZipFile(path) as z:
        assert z.read("memorial.txt").decode("utf-8") == MEMORIAL
        assert json.loads(z.read("payload.json"))["memorial"] == MEMORIAL
        assert z.read("payload.txt")
        assert z.read("README.txt")
    return "JPEG + ZIP"


def from_lsb() -> str:
    path = P / "dog_payload_lsb.png"
    flat = np.array(Image.open(path).convert("RGB"), dtype=np.uint8).reshape(-1)
    header_size = 7 + 8 + 32
    header = np.packbits(flat[: header_size * 8] & 1).tobytes()
    assert header[:7] == b"DOGPAY1", header[:7]
    length = struct.unpack(">Q", header[7:15])[0]
    blob = np.packbits(flat[: (header_size + length) * 8] & 1).tobytes()
    data = blob[header_size:]
    assert hashlib.sha256(data).digest() == header[15:47]
    assert json.loads(data)["memorial"] == MEMORIAL
    return f"{len(data)} bytes in LSB"


def from_git_tag() -> str:
    raw = subprocess.run(
        ["git", "-C", str(ROOT), "cat-file", "-p", "archive-2026-11-19-payload"],
        capture_output=True,
        check=True,
    ).stdout.decode("utf-8")
    assert MEMORIAL in raw
    assert f"MEMORIAL_SHA256={MEMORIAL_SHA}" in raw
    assert URL in raw
    return "annotated tag archive-2026-11-19-payload"


checks = [
    ("00 README memorial", from_readme),
    ("01 payload.json", from_json),
    ("02 EXIF", from_exif),
    ("03 XMP", from_xmp),
    ("04 PNG tEXt/zTXt", from_png),
    ("05 FFD9 + ZIP", from_ffd9),
    ("06 LSB PNG", from_lsb),
]
if "--skip-git" not in sys.argv:
    checks.append(("07 Git tag", from_git_tag))

for name, fn in checks:
    check(name, fn)

if "--quiet" not in sys.argv:
    print(f"canonical memorial: {MEMORIAL_SHA[:16]}... / {PHRASE} / {URL}\n")
    width = max(len(name) for name, _, _ in results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<{width}}  {detail}")
if not all(ok for _, ok, _ in results):
    raise SystemExit(1)
