"""Attach the Notion databases captured so far onto the matching et al. pages.

Additive on purpose: the full mirror swap has to wait until every Notion page is
captured, but these three databases exist nowhere in et al., so adding them now
is pure gain and survives the later swap unchanged.
"""
import json, sys, time, uuid

NOW = int(time.time() * 1000)
esc = lambda s: "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"
nid = lambda p: f"{p}_{uuid.uuid4().hex}"

SCHEMAS = json.load(open("schemas.json"))


def emit(sql, *, page_id, title, icon, schema, rows, position, board_key=None):
    cid = nid("col")
    sql.append(
        "INSERT INTO collection (id, parent_page_id, title, icon, role, schema_json, inline, position, created_at, updated_at) "
        f"VALUES ({esc(cid)}, {esc(page_id)}, {esc(title)}, {esc(icon)}, NULL, "
        f"{esc(json.dumps(schema))}, 1, {position}, {NOW}, {NOW});"
    )
    sql.append(
        "INSERT INTO collection_view (id, collection_id, name, type, filter_json, sort_json, group_by, position, created_at) "
        f"VALUES ({esc(nid('cvw'))}, {esc(cid)}, 'Table', 'table', '[]', '[]', NULL, 0, {NOW});"
    )
    if board_key:
        sql.append(
            "INSERT INTO collection_view (id, collection_id, name, type, filter_json, sort_json, group_by, position, created_at) "
            f"VALUES ({esc(nid('cvw'))}, {esc(cid)}, 'Board', 'board', '[]', '[]', {esc(board_key)}, 1, {NOW});"
        )
    # Placed at the end of the page body so it lands under whatever is there.
    sql.append(
        "INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, version, is_ai, created_at, updated_at) "
        f"VALUES ({esc(nid('blk'))}, {esc(page_id)}, NULL, 'collection', "
        f"{esc(json.dumps({'collection_id': cid}))}, "
        f"(SELECT COALESCE(MAX(position),0)+1 FROM block WHERE page_id={esc(page_id)}), 1, 0, {NOW}, {NOW});"
    )
    for i, (title_val, props) in enumerate(rows):
        rid = nid("pg")
        sql.append(
            "INSERT INTO page (id, parent_page_id, collection_id, title, icon, cover, properties_json, "
            "position, status, trashed_at, favorite, is_ai, actor, created_at, updated_at) VALUES ("
            f"{esc(rid)}, NULL, {esc(cid)}, {esc(title_val)}, NULL, NULL, {esc(json.dumps(props))}, "
            f"{i}, 'active', NULL, 0, 0, 'human', {NOW}, {NOW});"
        )
        sql.append(
            "INSERT INTO search_fts (entity_type, entity_id, title, body) VALUES "
            f"('page', {esc(rid)}, {esc(title_val)}, {esc(' '.join(str(v) for v in props.values() if v))});"
        )
    return cid


def main():
    data = json.load(open("rows.json"))
    targets = json.load(open("targets.json"))
    sql = []
    emit(sql, page_id=targets["ucla"], title="courses of the next 4 years", icon="📚",
         schema=SCHEMAS["courses"], rows=data["courses"], position=0)
    emit(sql, page_id=targets["career"], title="summer '27 internship tracker", icon="🎯",
         schema=SCHEMAS["internships"], rows=data["internships"], position=0, board_key="status")
    emit(sql, page_id=targets["content"], title="Tool Database", icon="🧰",
         schema=SCHEMAS["tools"], rows=data["tools"], position=1, board_key="lane")
    open("dbs.sql", "w").write("\n".join(sql) + "\n")
    print(f"{len(sql)} statements ->  dbs.sql", file=sys.stderr)


if __name__ == "__main__":
    main()
