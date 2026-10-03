# Working rules

How Claude (and anyone else) works on Lee's Premiere projects with this toolkit.

## Before any Premiere task

- Read the project notes and the Premiere Automation Reference doc first.
- Use the saved skills (sync external audio by waveform, link external audio to
  camera clips) when they fit.
- Confirm which machine and bridge the task runs on. Tool behaviour differs:
  - Mac Studio: `premiere-pro` bridge.
  - Data's Mac mini: `MCP_for_Adobe_Premiere_Pro` bridge (CEP).

## Safety

- Never guess. Test before handing anything back, and mark anything untested as
  unverified.
- Never test in the live project; use the TEST project.
- Never rename clips, never delete footage, proxies or project items.
- Save the project only when Lee agrees.
- Anything that edits a timeline runs only on a sequence whose name ends
  `TOOLKIT COPY` (made by **Make safe copy**).
- Never trust a "success" return from Premiere: read the result back and report
  what actually happened.
- Only one ExtendScript call at a time.

## Other

- Search for products in the UK.
- Give Lee full folder paths (e.g. `/Users/<name>/PenyToolkit/...`), never `~` or
  "your home folder".
