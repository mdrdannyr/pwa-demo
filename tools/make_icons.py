#!/usr/bin/env python3
"""Generate the PNG icons used by manifest.webmanifest (standard library only)."""
import struct
import zlib
from pathlib import Path

BG = (79, 70, 229)    # indigo
FG = (255, 255, 255)  # white


def png(size, outer, inner):
    """Square icon: indigo background with a white ring centred in it."""
    c = size / 2
    r_out, r_in = outer * size, inner * size
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter type: none
        for x in range(size):
            hits = 0
            for dy in (0.25, 0.75):  # 2x2 supersampling
                for dx in (0.25, 0.75):
                    d2 = (x + dx - c) ** 2 + (y + dy - c) ** 2
                    if r_in * r_in <= d2 <= r_out * r_out:
                        hits += 1
            t = hits / 4
            rows += bytes(round(BG[i] + (FG[i] - BG[i]) * t) for i in range(3))

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)
(out / "icon-192.png").write_bytes(png(192, 0.32, 0.19))
(out / "icon-512.png").write_bytes(png(512, 0.32, 0.19))
# Maskable: keep artwork inside the central ~80% safe zone.
(out / "icon-maskable-512.png").write_bytes(png(512, 0.26, 0.15))
print("Wrote icons to", out)
