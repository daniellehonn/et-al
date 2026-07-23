---
name: et-al-review
description: Run the et al. guided weekly review — process captures, surface stalled projects, confirm next actions, check tools stuck in testing, promote learning, and choose next week's focus. Use when the user says "weekly review", "let's do my review", or asks what needs attention.
---

# The weekly review

Load the `et-al` skill first for the object model and the rules.

This is a **guided sequence**, not a dashboard. The point is cleanup, decisions,
and focus — the user should finish with fewer open loops and a clear next week,
not a page of statistics.

## Sequence

Call `get_weekly_review`. It returns the steps in order, each with its items
attached. Walk them one at a time; do not dump all seven at once.

1. **Process captures** — anything pending. Follow the `et-al-inbox` skill.
2. **Stalled projects** — `list_stale_projects`. For each, the honest question
   is not "what is the next step" but "is this still real?" Offer `paused` or
   `archived` as first-class answers. A project parked deliberately is a success;
   one drifting silently is not.
3. **Confirm next actions** — every active project needs one. If the user cannot
   name a next physical step, the project is not actually active; move it to
   `planned`.
4. **Tools in testing** — anything stuck. Each needs a written verdict to move on:
   what worked, what failed, would they use it again. Untested saved tools are
   the failure this system exists to prevent, so push gently here.
5. **Promote learning** — notes still at `captured`. Ask the user to explain one
   in their own words; when they do, offer to advance the mastery. **Never
   advance it yourself.**
6. **Content seeds** — recent logs, tested tools, and completed work with
   publishable potential. Suggest specific angles grounded in what actually
   happened, not generic topics.
7. **Balance** — which Life Areas got no attention at all. Report it plainly and
   without moralising; the user decides whether that matters.

## Finish with a decision

End by asking for next week's focus: which projects, and what outcome each should
reach. Record it — `update_project` with a sharpened `next_action` is usually the
right way, since that is what the system reads back to them all week.

## Tone

Protect follow-through, do not manufacture guilt. Streaks, nagging, and
engagement pressure are explicitly out of scope for this product. A quiet week is
allowed to have been a quiet week.
