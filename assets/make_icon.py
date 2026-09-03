"""Generate assets/icon.ico (a red circle with a white pulse line) without external libraries."""
import math, struct, zlib, os

SIZES = [16, 32, 48, 64, 128, 256]

def png_bytes(size):
    px = bytearray()
    cx = cy = (size - 1) / 2
    r = size / 2 - 0.5
    for y in range(size):
        px.append(0)  # filter byte
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            a = max(0.0, min(1.0, r - d + 0.5))  # anti-aliased edge
            if a <= 0:
                px += b"\0\0\0\0"; continue
            # pulse line: baseline with a spike in the middle
            t = x / (size - 1)
            base = 0.55
            if 0.36 <= t < 0.44: yy = base - (t - 0.36) / 0.08 * 0.28
            elif 0.44 <= t < 0.52: yy = base - 0.28 + (t - 0.44) / 0.08 * 0.42
            elif 0.52 <= t < 0.58: yy = base + 0.14 - (t - 0.52) / 0.06 * 0.14
            else: yy = base
            lw = max(1.2, size * 0.055)
            on_line = abs(y - yy * (size - 1)) < lw and 0.18 <= t <= 0.82
            if on_line:
                rr, gg, bb = 255, 255, 255
            else:
                rr, gg, bb = 225, 29, 72
            px += bytes((rr, gg, bb, int(255 * a)))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(px), 9)) + chunk(b"IEND", b"")

images = [(s, png_bytes(s)) for s in SIZES]
header = struct.pack("<HHH", 0, 1, len(images))
offset = 6 + 16 * len(images)
entries, blobs = b"", b""
for s, data in images:
    entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
    blobs += data
    offset += len(data)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.ico")
with open(out, "wb") as f:
    f.write(header + entries + blobs)
print("wrote", out)
