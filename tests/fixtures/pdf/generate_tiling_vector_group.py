"""Generate a tiling-pattern fixture with a nested vector transparency group."""

from pathlib import Path


OUTPUT = Path(__file__).with_name("tiling-vector-group.pdf")


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
        b"/Resources << /Pattern << /P1 5 0 R >> >> /Contents 4 0 R >>"
    ),
    stream(b"/Pattern cs\n/P1 scn\n0 0 160 120 re f\n"),
    stream(
        b"/Fm1 Do\n",
        dictionary=(
            b"/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 "
            b"/BBox [0 0 40 40] /XStep 40 /YStep 40 "
            b"/Resources << /XObject << /Fm1 6 0 R >> >>"
        ),
    ),
    stream(
        b"0.706 0.314 0.314 rg\n0 0 40 40 re f\n",
        dictionary=(
            b"/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 40 40] "
            b"/Resources << >> /Group << /S /Transparency /I true /K false >>"
        ),
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
