# PatterDraw Classroom Editor

PatterDraw keeps classroom work portable by separating temporary creation surfaces from the local artifacts that belong to a project.

## Language

**Tool workspace**:
A wrapper-owned editor used to create content before inserting it into the board. Its UI and any device-local working state stay outside the project.
_Avoid_: Web embed, board iframe

**Board asset**:
A self-contained local object that belongs to the classroom project and remains available to save, reopen, and export.
_Avoid_: Live webpage, remote object

**Web embed**:
Live website content stored or rendered as part of the board. PatterDraw projects do not support web embeds.
_Avoid_: Tool workspace
