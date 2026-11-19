"""Verify the memorial branch: README + six payload channels + photo + terminal + LFS."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
P = ROOT / "06_payloads"
README = ROOT / "README.md"
PAYLOAD = json.loads((P / "payload.json").read_text(encoding="utf-8"))
SHA = PAYLOAD["sha256"]
MEMORIAL = PAYLOAD["memorial"]
MEMORIAL_SHA = PAYLOAD["memorial_sha256"]
PHRASE = PAYLOAD["phrase"]
URL = PAYLOAD["url"]
CREATED = PAYLOAD["created"]

results: list[tuple[str, bool, str]] = []


def check(name: str, fn) -> None:
    try:
        results.append((name, True, fn() or ""))
    except Exception as exc:  # noqa: BLE001 - verifier
        results.append((name, False, f"{type(exc).__name__}: {exc}"))


def text_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def from_readme() -> str:
    raw = README.read_text(encoding="utf-8")
    match = re.search(r"<!-- memorial:start -->(.*?)<!-- memorial:end -->", raw, re.S)
    assert match, "memorial markers missing"
    text = match.group(1).strip()
    assert text == MEMORIAL, "README memorial differs from payload.json"
    assert text_sha(text) == MEMORIAL_SHA
    return f"{len(text.encode('utf-8'))} bytes, sha {MEMORIAL_SHA[:12]}..."


def from_json() -> str:
    raw = (P / "payload.json").read_bytes()
    obj = json.loads(raw)
    assert obj == PAYLOAD
    assert text_sha(obj["memorial"]) == MEMORIAL_SHA
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
    assert body == MEMORIAL, "EXIF memorial text mismatch"
    return f"ImageDescription + UserComment ({len(body.encode('utf-8'))} bytes)"


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
    assert text == MEMORIAL, "XMP memorial text mismatch"
    assert MEMORIAL_SHA in raw
    return "XMP dog:Memorial / dog:MemorialSHA256"


def from_png() -> str:
    im = Image.open(P / "dog_payload.png")
    text = im.text
    assert text.get("Memorial") == MEMORIAL, "PNG Memorial mismatch"
    assert text.get("Memorial-SHA256") == MEMORIAL_SHA
    assert json.loads(text["Payload-JSON"])["memorial"] == MEMORIAL
    return f"{len(text)} text keys (incl. zTXt payload)"


def from_ffd9() -> str:
    path = P / "dog_payload_ffd9.jpg"
    im = Image.open(path)
    im.load()
    assert im.size == (1920, 1280)
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        assert z.read("memorial.txt").decode("utf-8") == MEMORIAL
        assert json.loads(z.read("payload.json"))["memorial"] == MEMORIAL
        assert z.read("payload.txt")
    return f"JPEG {im.size} + ZIP {len(names)} entries"


def from_lsb() -> str:
    path = P / "dog_payload_lsb.png"
    im = Image.open(path).convert("RGB")
    flat = np.array(im, dtype=np.uint8).reshape(-1)
    magic = b"DOGPAY1"
    header_size = len(magic) + 8 + 32
    header = np.packbits(flat[: header_size * 8] & 1).tobytes()
    assert header[:7] == magic, header[:7]
    length = struct.unpack(">Q", header[7:15])[0]
    expected = header[15:47]
    blob = np.packbits(flat[: (header_size + length) * 8] & 1).tobytes()
    data = blob[header_size:]
    assert len(data) == length
    assert hashlib.sha256(data).digest() == expected
    assert json.loads(data)["memorial"] == MEMORIAL
    return f"{len(data)} bytes in LSB, carrier {path.stat().st_size} bytes"


def check_photo() -> str:
    raw = (ROOT / "source" / "dog_photo.jpg").read_bytes()
    assert len(raw) == 295442, len(raw)
    assert hashlib.sha256(raw).hexdigest() == SHA
    return "295442 bytes, SHA-256 matches"


def check_terminal() -> str:
    script = ROOT / "02_terminal" / "dog_terminal_ghost.py"
    out = subprocess.run(
        [sys.executable, str(script)], capture_output=True, check=True
    ).stdout
    text = out.decode("utf-8", "ignore")
    assert text.count("▀") == 2160, text.count("▀")
    return f"{len(out)} bytes of ANSI, 2160 cells"


def have_git_lfs() -> bool:
    try:
        return subprocess.run(
            ["git", "lfs", "version"], capture_output=True
        ).returncode == 0
    except Exception:  # noqa: BLE001
        return False


def check_lfs() -> str:
    if not have_git_lfs():
        return "SKIP: git-lfs not available"
    object_rel = Path("36") / "ea" / SHA
    obj_src = ROOT / "01_git" / "lfs" / "objects" / object_rel
    assert obj_src.is_file(), obj_src
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td) / "lfs_repo"
        subprocess.run(
            ["git", "clone", "-q", str(ROOT / "01_git" / "lfs_repo.bundle"), str(repo)],
            check=True,
            capture_output=True,
        )
        obj_dst = repo / ".git" / "lfs" / "objects" / object_rel
        obj_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(obj_src, obj_dst)
        pointer = subprocess.run(
            ["git", "-C", str(repo), "show", "memorial-lfs:dog_photo.jpg"],
            capture_output=True,
            check=True,
        ).stdout
        out = subprocess.run(
            ["git", "-C", str(repo), "lfs", "smudge"],
            input=pointer,
            capture_output=True,
            check=True,
        ).stdout
        assert len(out) == 295442, len(out)
        assert hashlib.sha256(out).hexdigest() == SHA
    return "bundle + LFS object -> 295442 bytes"


checks = [
    ("00 README memorial", from_readme),
    ("01 payload.json", from_json),
    ("02 EXIF", from_exif),
    ("03 XMP", from_xmp),
    ("04 PNG tEXt/zTXt", from_png),
    ("05 FFD9 + ZIP", from_ffd9),
    ("06 LSB PNG", from_lsb),
    ("07 original photo", check_photo),
    ("08 terminal ghost", check_terminal),
]
if "--skip-lfs" not in sys.argv:
    checks.append(("09 LFS bundle", check_lfs))

for name, fn in checks:
    check(name, fn)

if "--quiet" not in sys.argv:
    print(f"memorial_sha256 {MEMORIAL_SHA}")
    print(f"phrase {PHRASE} / URL {URL}\n")
    width = max(len(name) for name, _, _ in results)
    for name, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name:<{width}}  {detail}")
if not all(ok for _, ok, _ in results):
    raise SystemExit(1)
