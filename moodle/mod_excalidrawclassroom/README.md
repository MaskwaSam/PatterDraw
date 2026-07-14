# Moodle activity boundary

This directory is reserved for the future GPL-3.0-or-later `mod_excalidrawclassroom` activity. It must be a new Moodle module, not an editor switch inside `mod_polypad`.

The first implementation must include Moodle-native capability checks, starter project/PDF files, isolated per-user drafts, autosave, submission and resubmission, activity completion, backup/restore, privacy metadata, and local file storage. It must not require LTI, Redis, Firebase, WebSockets, analytics, or another hosted service.

Do not copy MIT standalone source into the plugin without preserving its license notice, and do not apply the repository's root MIT license to Moodle PHP files; Moodle plugin code must declare GPL-3.0-or-later.

