"""Regenerate the page transparency-group fixture used by PDF export tests.

This generator uses only Python's standard library and writes a deliberately
small PDF directly, keeping the fixture independent of PatterDraw's pdf-lib
dependency.
"""

from pathlib import Path


OUTPUT = Path(__file__).with_name("page-transparency-group.pdf")
CONTENT = b"""q
/GS1 gs
1 0 0 rg
20 30 90 60 re f
0 0 1 rg
70 30 90 60 re f
Q
"""

OBJECTS = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 180 120] "
        b"/Resources << /ExtGState << /GS1 5 0 R >> >> "
        b"/Group 6 0 R /Contents 4 0 R >>"
    ),
    (
        f"<< /Length {len(CONTENT)} >>\nstream\n".encode("ascii")
        + CONTENT
        + b"endstream"
    ),
    b"<< /Type /ExtGState /ca 0.55 /CA 0.55 /BM /Multiply >>",
    (
        b"<< /Type /Group /S /Transparency /CS /DeviceRGB "
        b"/I true /K false >>"
    ),
]


def build_pdf() -> bytes:
    payload = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for object_number, value in enumerate(OBJECTS, start=1):
        offsets.append(len(payload))
        payload.extend(f"{object_number} 0 obj\n".encode("ascii"))
        payload.extend(value)
        payload.extend(b"\nendobj\n")

    xref_offset = len(payload)
    payload.extend(f"xref\n0 {len(OBJECTS) + 1}\n".encode("ascii"))
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        payload.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    payload.extend(
        (
            f"trailer\n<< /Size {len(OBJECTS) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii"),
    )
    return bytes(payload)


OUTPUT.write_bytes(build_pdf())
print(OUTPUT)
