"""Recover the original JPEG hidden in dog_memorial_carrier.png.

Header layout (48 bytes):
    b"DOGSTEG1" | uint64 big-endian length | sha256(payload)
Payload bits are stored MSB-first in the LSB of R, G, B channels,
in row-major order.
"""

import hashlib
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

MAGIC = b"DOGSTEG1"


def extract(carrier_path: Path, output_path: Path) -> None:
    img = Image.open(carrier_path).convert("RGB")
    flat = np.array(img, dtype=np.uint8).reshape(-1)

    header_size = len(MAGIC) + 8 + 32
    header_bits = flat[: header_size * 8] & 1
    header = np.packbits(header_bits).tobytes()
    if header[:8] != MAGIC:
        raise SystemExit("no DOGSTEG1 payload found")

    length = struct.unpack(">Q", header[8:16])[0]
    expected_sha = header[16:48]
    if length > flat.size // 8:
        raise SystemExit(f"bad length: {length}")

    header_size = len(MAGIC) + 8 + 32
    total_bits = (header_size + length) * 8
    bits = flat[:total_bits] & 1
    blob = np.packbits(bits).tobytes()
    payload = blob[48:]

    actual_sha = hashlib.sha256(payload).digest()
    if actual_sha != expected_sha:
        raise SystemExit("sha256 mismatch, carrier damaged")

    output_path.write_bytes(payload)
    print(f"recovered {len(payload)} bytes -> {output_path}")
    print(f"sha256 {actual_sha.hex()}")


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    extract(
        Path(sys.argv[1]) if len(sys.argv) > 1 else here / "dog_memorial_carrier.png",
        Path(sys.argv[2]) if len(sys.argv) > 2 else here / "dog_recovered.jpg",
    )



