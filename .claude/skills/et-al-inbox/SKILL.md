---
name: et-al-inbox
description: Work through the et al. inbox — file saved links and thoughts into notes, turn the few that deserve it into notes or tasks, and clear the rest. Use when the user says "process my inbox", "sort what I saved", or asks what is waiting for them.
---

# Working through the et al. inbox

Load the `et-al` skill first.

## The one thing that makes this go wrong

Turning an inbox into a second, larger backlog. **Most captures should not
become a note.** Filing a source into the note it belongs to is usually enough —
it stays searchable and shows up in that note's context. Marking it `done` is a
fine outcome too.

## Sequence

1. `list_inbox` for what is waiting, and `list_proposals` for insights the
   extractor already suggested from saved links. Those are the user's to keep or
   discard in the web app; mention them, don't duplicate them.
2. For each source, decide what it is. A source with a `url` has been fetched in
   the background: its `description` and `site` are filled in, or
   `fetch_status: failed` says why not. Read the link yourself before
   classifying anything you can't tell from that.
3. Propose a batch in one message, grouped. Say plainly which ones deserve
   nothing.
4. On agreement:
   - belongs with existing work → `file_source` with that `note_id`
   - a durable idea → `search` first, then `create_note` + `propose_note_patch`,
     then `file_source` into it
   - something to do → `create_task` (with `note_id` if it belongs to a note)
   - nothing → `file_source` with `status: "done"`
5. Report what you filed, what you proposed (and that it's waiting for them),
   and what you left because it needed their judgement.
