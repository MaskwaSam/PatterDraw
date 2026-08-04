"""Generate a one-pixel image-mask fixture for dark PDF preview tests."""

from pathlib import Path


OUTPUT = Path(__file__).with_name("image-mask.pdf")


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
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] "
        b"/Resources << /XObject << /M1 5 0 R >> >> /Contents 4 0 R >>"
    ),
    stream(b"1 0 0 rg\nq\n80 0 0 80 20 10 cm\n/M1 Do\nQ\n"),
    stream(
        b"\x00",
        dictionary=b"/Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1",
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
