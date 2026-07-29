"""Regenerate the independent AcroForm fixture used by PDF export tests.

Run with ReportLab available:
  python3 generate_reportlab_acroform.py
"""

from pathlib import Path

from reportlab.lib.colors import black, blue, cyan, magenta, red, yellow
from reportlab.pdfgen.canvas import Canvas


OUTPUT = Path(__file__).with_name("reportlab-acroform.pdf")

canvas = Canvas(
    str(OUTPUT),
    pagesize=(360, 240),
    pageCompression=0,
    invariant=1,
    pdfVersion=(1, 7),
)
canvas.setAuthor("PatterDraw test fixture")
canvas.setCreator("ReportLab 5.0.0")
canvas.setTitle("Independent AcroForm fidelity fixture")

# Ordinary vector page content proves the source page itself remains vector.
canvas.setFont("Helvetica", 14)
canvas.drawString(62, 202, "REPORTLAB_VECTOR_SENTINEL")
canvas.setFillColor(red)
canvas.rect(12, 184, 28, 28, fill=1, stroke=0)
canvas.setFillColor(blue)
canvas.rect(320, 12, 28, 28, fill=1, stroke=0)

# These controls are annotation appearances, not ordinary page content.
form = canvas.acroForm
form.textfield(
    name="fixture.answer",
    value="REPORTLAB_FORM_VALUE",
    x=50,
    y=105,
    width=260,
    height=44,
    borderWidth=2,
    borderColor=magenta,
    fillColor=yellow,
    textColor=black,
    fontName="Helvetica",
    fontSize=14,
    forceBorder=True,
)
form.checkbox(
    name="fixture.checked",
    checked=True,
    x=20,
    y=24,
    size=26,
    buttonStyle="check",
    borderWidth=2,
    borderColor=black,
    fillColor=cyan,
    textColor=black,
    forceBorder=True,
)

canvas.showPage()
canvas.save()
print(OUTPUT)
