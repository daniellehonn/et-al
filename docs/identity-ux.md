# Identity UX

How the Identity layer from [data-model.md](./data-model.md) is expressed in the interface.

## Principle

Identity is not a peer of the spaces — it sits above them, and everything below should trace back to it. In the data that hierarchy is only `space IS NULL`. The UI's job is to make it *felt*, in three places: the nav, a dedicated Identity screen, and ambient signals inside the spaces.

---

## 1. Nav — Identity is a card, not a row

The sidebar teaches the hierarchy before you click anything. Identity renders as a bordered, tinted card above the `§ Spaces` label, with its own subtitle (`3 goals · 6 pages`). It never shares visual grammar with `school` or `career`.

Clicking it opens the Identity screen (`state.view = 'identity'`), not a filtered item list.

## 2. Identity screen — three lenses, one dataset

Identity has three jobs: be read, be seen whole, be traced downward. Those are tabs, not separate nav destinations. The chosen tab lives in `state.identityTab`.

| Lens | What it is | When you use it |
|------|-----------|-----------------|
| **Core** *(default)* | Identity goals and pages as a readable list | Daily. You land on your own words, not on a diagram you've already absorbed. |
| **Constellation** | Radial SVG, Identity at the origin, spokes out to each space | To check whether your life is actually pointed where you said it is. |
| **Cascade** | Indented outline: identity goal → related space goal → child tasks | While planning. |

Core is the default on every open. Constellation is the lens worth showing someone else.

### The orphan callout

Cascade ends with the highest-leverage element on the screen:

> **3 space goals aren't traced to Identity.** Link them, or mark one untethered.

This converts the philosophy in `data-model.md` into a visible, closable gap. It is dismissible per item — clicking *fine untethered* sets `metadata.untethered: true`, and that goal stops being counted. Nagging that can't be closed reads as guilt.

## 3. Ambient traceability

Identity can't live only on its own screen; it has to be present while you work.

- **Lineage chip** — every `goal` in a space shows the identity item it points back up at (`↑ Become a strong software engineer`), resolved from its `related` array. Untraced goals show a dashed `+ link to identity` instead.
- **Daily review opens with "why"** — one active identity goal renders above the task list under the label `TODAY, BECAUSE`. You read the reason before the list.

## 4. Capture: one inbox, one promote gesture

Identity deliberately has **no** capture box of its own.

Quick capture works because there's one place to throw a thought and zero decisions at throw-time — the model already encodes this (capture produces an `idea` with `status: inbox`). A dedicated Identity capture would force you to classify a half-formed realization as identity-grade *before* writing it down, and self-knowledge doesn't arrive pre-labeled. Two inboxes also means two places to forget things.

Instead the capture modal's space picker leads with **↑ Identity**, visually set apart, ahead of the six spaces. Choosing it sets `space = NULL`. The promoted item keeps its original `created_at`, so Identity records *when* you first had the thought — most of the value.

*Worth building later:* a reflection prompt closing the daily review ("anything you learned about yourself today?") writing straight to Identity. Not a competing inbox — a scheduled moment where context has already made the classification decision.

---

## API

`GET /api/identity/graph` backs the whole screen in one round trip. Every lens reads from it, so per-item `/backlinks` fan-out would be an N+1.

```jsonc
{
  "identity":    [ /* items where space IS NULL, non-archived, goals first */ ],
  "links":       { "<identity_id>": [ /* space items whose `related` contains it */ ] },
  "orphanGoals": [ /* space goals, not done/archived, not untethered,
                      with no identity id anywhere in `related` */ ]
}
```

Cascade resolves the third level (tasks under a space goal) client-side from the already-loaded item list via `parent_id`, rather than calling `/children` per branch.

## Known limits

- **Constellation degrades at both ends.** Empty Identity renders a written empty state instead of a bare diagram. There's no ring-2 collapsing yet, so a node with many children will crowd — worth capping around 8.
- **Depth.** Constellation is capped at two rings by construction; Cascade goes as deep as `parent_id` chains allow.
- **Client-side children.** Cascade only sees tasks inside the loaded item window (`/api/items?limit=100`). Beyond that, branches will look emptier than they are.
