"""Infer heading levels for v7 content.

v7 had a single `heading` block type and stored no level, so every migrated
heading renders as H1 and a document shows no hierarchy. The level is not
recoverable — it was never written — so this infers it from what the headings
say, and only where the signal is unambiguous.

Deliberately conservative: a heading it cannot read confidently is left as H1.
Guessing wrong is worse than leaving a flat document, because a wrong level
looks intentional and the user has no way to know it was inferred.

Reads the candidate rows as JSON on stdin and emits SQL, so the query and the
apply stay ordinary wrangler commands:

  wrangler d1 execute et-al --remote --json --command \
    "SELECT id, content_json FROM block WHERE type='heading' \
     AND json_extract(content_json,'$.level') IS NULL" \
  | python3 scripts/backfill_heading_levels.py > backfill.sql
"""
import json, re, sys

# Ordered: the first pattern that matches decides the level.
RULES = [
    # An explicit numbering scheme is the strongest signal there is.
    (re.compile(r'^\s*(slide|step|phase|part|chapter|week|day|v)\s*\d+\b', re.I), 2),
    (re.compile(r'^\s*\d+(\.\d+)+\s'), 3),          # 1.2  / 1.2.3
    (re.compile(r'^\s*\d+[\.\)]\s'), 2),            # 1.   / 1)
    # Section words that conventionally sit at the top of a document.
    (re.compile(r'^\s*(overview|summary|introduction|background|context|abstract|'
                r'architecture|tasks|objectives|roadmap|results|conclusion|'
                r'appendix|references|notes)\s*$', re.I), 1),
    # Sub-section words that conventionally sit under one of the above.
    (re.compile(r'^\s*(format|headline|subhead|body|tag|goal|scope|risks|'
                r'next steps|open questions|why|how|what)\b', re.I), 3),
]


def infer(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 1
    for pattern, level in RULES:
        if pattern.search(stripped):
            return level
    # Short lines read as section headers; longer ones as sub-sections. Length
    # alone is weak, which is why the first-heading rule in main() overrides it.
    return 1 if len(stripped.split()) <= 4 else 2


def esc(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw[raw.index("["):])
    rows = payload[0]["results"]
    # The first heading on a page is its title far more often than not — a much
    # stronger signal than anything the text itself carries, so it wins.
    first_on_page = set()
    seen_pages = set()
    for r in rows:
        page = r.get("page_id")
        if page and page not in seen_pages:
            seen_pages.add(page)
            first_on_page.add(r["id"])

    statements, counts = [], {1: 0, 2: 0, 3: 0}
    for r in rows:
        try:
            content = json.loads(r["content_json"])
        except Exception:
            continue
        level = 1 if r["id"] in first_on_page else infer(str(content.get("text", "")))
        counts[level] += 1
        content["level"] = level
        statements.append(
            f"UPDATE block SET content_json = {esc(json.dumps(content))} WHERE id = {esc(r['id'])};"
        )

    print(f"{len(rows)} headings without a level", file=sys.stderr)
    print(f"  H1 {counts[1]}   H2 {counts[2]}   H3 {counts[3]}", file=sys.stderr)
    print("\n".join(statements))


if __name__ == "__main__":
    main()
