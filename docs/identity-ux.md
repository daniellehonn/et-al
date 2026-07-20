# Identity UX

How the Identity layer from [data-model.md](./data-model.md) is expressed in the interface.

## Principle

Identity is not a peer of the spaces — it sits above them, and everything below should trace back to it. In the data that hierarchy is just a space value (`space = 'identity'` as of schema v3; it was `space IS NULL` in v2). The UI's job is to make it *felt*, in three places: the nav, a dedicated Identity screen, and ambient signals inside the spaces.

---

## 1. Nav — Identity is a card, not a row

The sidebar teaches the hierarchy before you click anything. Identity renders as a bordered, tinted card above the `§ Spaces` label, with its own subtitle (`5 goals · 0 pages`). It never shares visual grammar with `school` or `career`.

Clicking it opens the Identity screen (`state.view = 'identity'`), not a filtered item list.

## 2. Identity screen — two lenses, one dataset

Identity needs to be traced downward and seen whole. Those are tabs, not separate nav destinations. The chosen tab lives in `state.identityTab`.

| Lens | What it is | When you use it |
|------|-----------|-----------------|
| **Cascade** *(default)* | Collapsible outline: identity goal → related space goal → child tasks | Daily, and while planning. |
| **Constellation** | Radial SVG, Identity at the origin, spokes out to each space | To check whether your life is actually pointed where you said it is. Also the lens worth showing someone else. |

Cascade is the default on every open. Each identity renders as a large heading with a fold caret and a link count; collapsing one hides its whole branch (`state.collapsed[id]`). The point of the lens is scanning identities, so their branches have to be able to get out of the way.

> **Superseded:** an earlier revision had a third **Core** lens (identity goals and pages as a readable list) and defaulted to it. It was removed — in practice the Identity layer holds *no pages at all*, only goals, so Core was a list that duplicated Cascade's headings with none of the structure. See §6.

### The orphan callout

Cascade ends with the highest-leverage element on the screen:

> **3 space goals aren't traced to Identity.** Link them, or mark one untethered.

This converts the philosophy in `data-model.md` into a visible, closable gap. It is dismissible per item — clicking *fine untethered* sets `metadata.untethered: true`, and that goal stops being counted. Nagging that can't be closed reads as guilt.

## 3. Ambient traceability

Identity can't live only on its own screen; it has to be present while you work.

- **Lineage chip** — every `goal` in a space shows the identity item it traces up to (`↑ Become a strong software engineer`), resolved from `parent_id` first and falling back to `related`. Untraced goals show a dashed `+ link to identity` instead.
- **Daily review opens with "why"** — one active identity goal renders above the task list under the label `TODAY, BECAUSE`. You read the reason before the list.

## 4. Capture: one inbox, one promote gesture

Identity deliberately has **no** capture box of its own.

Quick capture works because there's one place to throw a thought and zero decisions at throw-time — the model already encodes this (capture produces an `idea` with `status: inbox`). A dedicated Identity capture would force you to classify a half-formed realization as identity-grade *before* writing it down, and self-knowledge doesn't arrive pre-labeled. Two inboxes also means two places to forget things.

Instead the capture modal's space picker leads with **↑ Identity**, visually set apart, ahead of the six spaces. Choosing it sets `space = 'identity'`. The promoted item keeps its original `created_at`, so Identity records *when* you first had the thought — most of the value.

*Worth building later:* a reflection prompt closing the daily review ("anything you learned about yourself today?") writing straight to Identity. Not a competing inbox — a scheduled moment where context has already made the classification decision.

---

## 5. API

`GET /api/identity/graph` backs the whole screen in one round trip. Both lenses read from it, so per-item `/backlinks` fan-out would be an N+1.

```jsonc
{
  "identity":    [ /* space = 'identity', non-archived, goals first */ ],
  "links":       { "<identity_id>": [ /* traced items, each tagged via: "parent" | "related" */ ] },
  "orphanGoals": [ /* goals outside the identity layer, not done/archived,
                      not untethered, traced by neither mechanism */ ]
}
```

An item traced by *both* mechanisms appears once, keeping `via: "parent"` — the stronger claim. Cascade resolves the third level (tasks under a space goal) client-side from the already-loaded item list via `parent_id`, rather than calling `/children` per branch.

## 6. What production actually looks like

Measured against the live database on 2026-07-20 — this is what the screen is really rendering, and it drove the Core/Cascade change above.

| | |
|---|---|
| Items | 27 |
| Identity layer | 5 items — **all `goal`, zero `page`** |
| Traced | 13 space goals trace up via `parent_id`; **0 orphans** |
| Unused | no `page`, no `link`, no `due_date` anywhere (1 `task` exists) |

The identity items are `Identity: Creative AI-native developer`, `Identity: Student…`, `Identity: Entrepreneur`, `Identity: Content creator`, `Identity: Fit`. Branch weight is very uneven — the developer identity carries 8 space goals, the rest carry 1–2. That imbalance is legible information, and it's the main thing Cascade shows at a glance.

Three conventions emerged in real use that the design didn't anticipate:

- **`Identity: ` title prefix.** Identity items are self-labelling, because they show up in feeds and search alongside space items.
- **A slug tag per identity** (`creative-ai-dev`, `student`, `entrepreneur`, `content-creator`, `fitness`) is repeated on every descendant. This is a *second*, informal lineage mechanism running parallel to `related` — and unlike `related`, it survives being viewed anywhere in the app.
- **`parent_id` and `related` are both set**, to the same identity item, on all 13 traced goals. Under schema v3 `parent_id` is the primary lineage mechanism, so the `related` half is redundant. The identity graph honours either, marking each link `via: "parent" | "related"`.

## Known limits

- **Constellation degrades at both ends.** Empty Identity renders a written empty state instead of a bare diagram. There's no ring-2 collapsing yet, so a node with many children will crowd — the developer identity's 8 links already push this.
- **Depth.** Constellation is capped at two rings by construction; Cascade goes as deep as `parent_id` chains allow — though in production nothing is nested below the second level yet.
- **Client-side children.** Cascade only sees tasks inside the loaded item window (`/api/items?limit=100`). At 27 items that's not binding yet.
- **Collapse state is per-session.** `state.collapsed` is in-memory; folds reset on reload.
