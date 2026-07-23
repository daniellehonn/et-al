---
name: et-al-digest
description: Turn a saved source (video, article, paper, podcast) in et al. into connected knowledge notes linked to real projects. Use when the user says "digest this video", "what did I save from X", "write up that article", or wants saved material turned into knowledge.
---

# Digesting a source into knowledge

Load the `et-al` skill first for the object model and the rules.

A source is external material the user consumed. The knowledge made from it is a
**separate record** — that separation is what lets several notes cite one source,
and lets a source be reprocessed without touching what the user already wrote.

## Sequence

1. `list_sources` to find it, then `get_source` to read the fetched transcript or
   article text. The text was fetched deterministically by the platform; you are
   reading real content, not guessing from a title.
2. Extract the **concepts**, not the outline. A source with eight headings does
   not become eight notes. Ask: which of these are durable ideas the user will
   want again in six months? Usually one to three.
3. For each concept, `find_note_by_title` **before** creating anything. Prefer
   extending an existing note over creating a near-duplicate. If a note already
   covers it, add to that note and relate the source instead.
4. `create_note` — mastery stays `captured`. It is not `understood` because you
   summarised it well.
5. `open_body` then `write_body`. Fill the explanation sections and mark every
   block you generated with `is_ai: true`. **Leave "My explanation" and "Where I
   applied it" empty** — those are the user's, and an empty prompt is an
   invitation; a filled-in one is a lie.
6. `relate` each note to the source with `learned-from`, and to any project it is
   relevant to with `used-in`.

## Linking to real work

The point of a knowledge note is eventual application. Check `list_projects` and
say which active project each concept bears on. If a concept connects to nothing
the user is doing, say so — that is useful information, not a gap to paper over.

## Report back

List what you created, what you deliberately merged into existing notes rather
than duplicating, and which sections you left for them to write.
