"""Generate the Type3 RGB-image fixture used by dark PDF preview tests.

The page contains ordinary vector paint plus a Type3 glyph whose character
procedure paints a small RGB image. The image is deliberately nested in the
Type3 operator list: PDF.js' public operationsFilter only visits the page's
top-level list, so this fixture catches regressions where the glyph inherits
the parent's showText dark filter.
"""

from pathlib import Path


OUTPUT = Path(__file__).with_name("type3-rgb-image.pdf")


def stream(value: bytes, *, dictionary: bytes = b"") -> bytes:
    return (
        b"<< "
        + dictionary
        + b" /Length "
        + str(len(value)).encode("ascii")
        + b" >>\nstream\n"
        + value
        + b"\nendstream"
    )


OBJECTS = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 120] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
    ),
    stream(
        b"q\n"
        b"1 0 0 rg\n5 5 16 16 re f\n"
        b"BT\n/F1 1 Tf\n1 0 0 1 34 46 Tm\n(A) Tj\nET\n"
        b"Q\n",
    ),
    (
        b"<< /Type /Font /Subtype /Type3 /Name /F1 "
        b"/FontBBox [0 0 20 20] /FontMatrix [1 0 0 1 0 0] "
        b"/CharProcs << /A 6 0 R >> "
        b"/Encoding << /Type /Encoding /Differences [65 /A] >> "
        b"/FirstChar 65 /LastChar 65 /Widths [20] "
        b"/Resources << /XObject << /Im1 7 0 R >> >> >>"
    ),
    stream(
        b"20 0 0 0 20 20 d1\n"
        b"q\n20 0 0 20 0 0 cm\n/Im1 Do\nQ\n",
    ),
    stream(
        bytes(
            [
                # red, green
                180,
                80,
                80,
                80,
                180,
                100,
                # blue, yellow
                80,
                100,
                180,
                180,
                180,
                80,
            ]
        ),
        dictionary=b"/Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8",
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
