---
name: et-al-digest
description: Turn a saved source (article, video, paper) in et al. into a few connected notes. Use when the user says "digest this", "write up that article", or wants something they saved turned into knowledge.
---

# Digesting a source into notes

Load the `et-al` skill first.

A source is what the user saved; a note is what they keep from it. They are
separate on purpose: one source can feed several notes, and a note outlives the
link it came from.

## Sequence

1. Find the source: `list_inbox`, or `search` for it. Read the actual content at
   its `url` yourself — the server keeps the source's title, description and
   site, not the full text.
2. Extract the **ideas**, not the outline. An article with eight headings does
   not become eight notes. Which of these will the user want in six months?
   Usually one to three.
3. For each idea, `search` first. If a note already covers it, propose an
   addition to that note (`get_note`, then `insert` ops) instead of a
   near-duplicate.
4. Otherwise `create_note` under the note it relates to, then
   `propose_note_patch` with the explanation. Leave a heading such as
   "## What I think" empty for the user — a filled-in opinion would be a lie.
5. `file_source` into the main note it fed, so the source shows up in that
   note's context.

## Report back

Say what you proposed, what you merged into existing notes rather than
duplicating, and that the patches are waiting for them in the web app.
