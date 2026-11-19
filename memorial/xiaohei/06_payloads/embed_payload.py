"""Embed one canonical payload (SHA-256, memorial, URL) into five file-internal
channels: EXIF/XMP JPEG, PNG tEXt/zTXt, FFD9+ZIP, LSB PNG.  The Git tag message
is written to payload_git_tag.txt for the caller to tag.
"""
from __future__ import annotations

import hashlib
import io
import json
import struct
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np
from PIL import Image, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD_PATH = ROOT / "06_payloads" / "payload.json"
SRC = ROOT / "source" / "dog_photo.jpg"
SRC_BW = ROOT / "source" / "dog_photo_bw.jpg"
OUT = ROOT / "06_payloads"

payload_bytes = PAYLOAD_PATH.read_bytes()
payload = json.loads(payload_bytes)
SHA = payload["sha256"]
MEMORIAL_SHA = payload["memorial_sha256"]
MEMORIAL = payload["memorial"]
PHRASE = payload["phrase"]
URL = payload["url"]
CREATED = payload["created"]
ISO_DATE = "2026-11-19T17:32:16+08:00"


def ascii_value(text: str) -> bytes:
    return text.encode("ascii", "replace") + b"\x00"


def build_exif() -> bytes:
    note_body = (
        f"SHA256={SHA}\n"
        f"MEMORIAL_SHA256={MEMORIAL_SHA}\n"
        f"PHRASE={PHRASE}\n"
        f"URL={URL}\n"
        f"CREATED={CREATED}\n\n"
        f"{MEMORIAL}"
    ).encode("utf-16-be")
    entries = []

    def add(tag, typ, data):
        entries.append((tag, typ, len(data), data))

    add(0x010E, 2, ascii_value("He was here."))
    add(0x010F, 2, ascii_value("Codex"))
    add(0x0110, 2, ascii_value("Dog Memorial Payload"))
    add(0x0131, 2, ascii_value("Codex memorial writer"))
    add(0x0132, 2, ascii_value("2026:11:19 17:32:16"))
    add(0x013B, 2, ascii_value("Anonymous"))
    add(0x8298, 2, ascii_value(f"Personal memento. SHA-256 {SHA}"))
    add(0x9003, 2, ascii_value("2026:11:19 17:32:16"))
    add(0x9286, 7, b"UNICODE\x00" + note_body)

    entries.sort(key=lambda item: item[0])
    ifd_size = 2 + 12 * len(entries) + 4
    data_offset = 8 + ifd_size
    data_area = bytearray()
    packed = []

    for tag, typ, count, data in entries:
        if len(data) <= 4:
            value = data.ljust(4, b"\x00")
        else:
            if data_offset % 2:
                data_area += b"\x00"
                data_offset += 1
            value = struct.pack("<I", data_offset)
            data_area += data
            data_offset += len(data)
            if data_offset % 2:
                data_area += b"\x00"
                data_offset += 1
        packed.append(struct.pack("<HHI", tag, typ, count) + value)

    tiff = bytearray(b"II")
    tiff += struct.pack("<H", 42)
    tiff += struct.pack("<I", 8)
    tiff += struct.pack("<H", len(entries))
    tiff += b"".join(packed)
    tiff += struct.pack("<I", 0)
    tiff += data_area
    return b"Exif\x00\x00" + bytes(tiff)


def build_xmp() -> str:
    memorial = escape(MEMORIAL)
    phrase = escape(PHRASE)
    return f'''<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dog="https://example.local/dog/1.0/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">One photograph</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">{memorial}</rdf:li></rdf:Alt></dc:description>
   <xmp:CreatorTool>Codex memorial writer</xmp:CreatorTool>
   <xmp:CreateDate>{ISO_DATE}</xmp:CreateDate>
   <dog:OriginalFile>dog_photo.jpg</dog:OriginalFile>
   <dog:Bytes>295442</dog:Bytes>
   <dog:SHA256>{SHA}</dog:SHA256>
   <dog:MemorialSHA256>{MEMORIAL_SHA}</dog:MemorialSHA256>
   <dog:Phrase>{phrase}</dog:Phrase>
   <dog:Memorial>{memorial}</dog:Memorial>
   <dog:URL>{URL}</dog:URL>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>'''


def app1(data: bytes) -> bytes:
    if len(data) + 2 > 0xFFFF:
        raise ValueError("APP1 too large")
    return b"\xff\xe1" + struct.pack(">H", len(data) + 2) + data


def insert_after_app0(jpeg: bytes, segments: list[bytes]) -> bytes:
    assert jpeg[:2] == b"\xff\xd8"
    pos = 2
    if jpeg[pos:pos + 2] == b"\xff\xe0":
        length = struct.unpack(">H", jpeg[pos + 2:pos + 4])[0]
        pos += 2 + length
    return jpeg[:pos] + b"".join(segments) + jpeg[pos:]


jpeg = SRC.read_bytes()
xmp = build_xmp()
stamped = insert_after_app0(
    jpeg,
    [app1(build_exif()), app1(b"http://ns.adobe.com/xap/1.0/\x00" + xmp.encode("utf-8"))],
)
(OUT / "dog_payload_exif_xmp.jpg").write_bytes(stamped)
(OUT / "payload.xmp").write_text(xmp + "\n", encoding="utf-8")

info = PngImagePlugin.PngInfo()
info.add_text("SHA256", SHA)
info.add_text("Memorial-SHA256", MEMORIAL_SHA)
info.add_text("Memorial", MEMORIAL)
info.add_text("Phrase", PHRASE)
info.add_text("URL", URL)
info.add_text("Created", CREATED)
info.add_text("Payload-JSON", payload_bytes.decode("utf-8"), zip=True)
Image.open(SRC).convert("RGB").save(OUT / "dog_payload.png", "PNG", pnginfo=info, optimize=True)

readme = f"""一张照片的统一载荷（文件内部）

SHA-256         {SHA}
纪念文 SHA-256  {MEMORIAL_SHA}
短句            {PHRASE}
URL             {URL}
时间            {CREATED}

这个 ZIP 接在原始 JPEG 的 FFD9 之后。图片仍可正常打开；
ZIP 工具从文件末尾的中央目录找到 memorial.txt / payload.json / payload.txt。
"""
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr("README.txt", readme)
    z.writestr("memorial.txt", MEMORIAL)
    z.writestr("payload.json", payload_bytes)
    z.writestr("payload.txt", (ROOT / "06_payloads" / "payload.txt").read_bytes())
    z.comment = f"SHA256={SHA} | {PHRASE}".encode("utf-8")
(OUT / "dog_payload_ffd9.jpg").write_bytes(jpeg + zbuf.getvalue())

carrier = Image.open(SRC_BW).convert("RGB")
arr = np.array(carrier, dtype=np.uint8)
flat = arr.reshape(-1).copy()
magic = b"DOGPAY1"
blob = magic + struct.pack(">Q", len(payload_bytes)) + hashlib.sha256(payload_bytes).digest() + payload_bytes
bits = np.unpackbits(np.frombuffer(blob, dtype=np.uint8))
assert bits.size <= flat.size, (bits.size, flat.size)
flat[:bits.size] = (flat[:bits.size] & 0xFE) | bits
Image.fromarray(flat.reshape(arr.shape), "RGB").save(OUT / "dog_payload_lsb.png", "PNG", optimize=True)

tag_message = (
    f"SHA256={SHA}\n"
    f"MEMORIAL_SHA256={MEMORIAL_SHA}\n"
    f"PHRASE={PHRASE}\n"
    f"URL={URL}\n"
    f"CREATED={CREATED}\n\n"
    f"{MEMORIAL}\n"
)
(OUT / "payload_git_tag.txt").write_text(tag_message, encoding="utf-8")

print("payload_bytes", len(payload_bytes))
print("memorial_bytes", len(MEMORIAL.encode("utf-8")))
print("exif_xmp", (OUT / "dog_payload_exif_xmp.jpg").stat().st_size)
print("png", (OUT / "dog_payload.png").stat().st_size)
print("ffd9", (OUT / "dog_payload_ffd9.jpg").stat().st_size)
print("lsb", (OUT / "dog_payload_lsb.png").stat().st_size)
print("lsb_payload_bytes", len(blob), "capacity", flat.size // 8)
