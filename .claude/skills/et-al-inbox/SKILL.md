---
name: et-al-inbox
description: Process the et al. inbox — triage captured links, notes, and ideas into projects, knowledge notes, tools, or nothing at all. Use when the user says "process my inbox", "clear my captures", "sort what I saved", or asks what is waiting for them.
---

# Processing the et al. inbox

Load the `et-al` skill first for the object model and the rules.

The inbox is a queue of **immutable raw captures**. Your job is to propose what
each should become, get agreement, create it, then resolve the capture.

## The one thing that makes this go wrong

The failure mode is turning an inbox into a second, larger backlog of
low-quality records. **Most captures should not become a typed record.** A
passing thought can be marked `dismissed` and still be searchable forever; the
capture itself is never deleted. Creating a note for every link is exactly the
"AI fills the system with low-quality notes" outcome the system is designed to
avoid.

Bias toward fewer, better records.

## Sequence

1. `list_inbox` — read the queue.
2. For each capture, decide what it actually is. If it was a URL, the system has
   already fetched it: call `get_capture_status` to see whether processing
   succeeded, and `list_sources` / `get_source` to read the fetched title,
   author, and text. **Read the source before classifying it** — do not guess
   from the URL.
3. Propose a batch to the user in one message. Group them; do not ask about
   twenty captures one at a time. Say plainly which ones you think deserve
   nothing.
4. On agreement, create the records:
   - a tool → `save_tool` (include `expected_use`: why it might be useful)
   - a concept → `find_note_by_title` first, then `create_note`
   - a project idea → `create_project` at status `idea`
   - a content idea → `create_content_seed`
   - already-fetched external material → a Source already exists; just relate it
5. `relate` the new record back to what it came from, so provenance survives.
6. `triage_capture` with `accepted` or `dismissed`, plus a `classification`.

## Failed captures

A capture whose fetch failed is **not lost** — the raw input is intact and it is
still fully reviewable. Report the failure, offer `retry_capture`, and if the
link is simply dead, triage it by hand from the raw input.

## Leave it better than you found it

Finish by saying how many captures were resolved, what was created, and what you
deliberately left pending because it needed the user's judgement.
