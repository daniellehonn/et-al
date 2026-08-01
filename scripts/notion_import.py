"""Generate SQL that imports Notion content into et al.'s v8 page model.

Mirrors src/store/blocks.ts markdownToBlocks: same block types, same
indentation-to-nesting rule, so imported pages are indistinguishable from ones
written in the app. Emits INSERTs rather than API calls because the production
API key is the user's, while D1 access is already authenticated via wrangler.
"""
import json, re, sys, uuid, time

NOW = int(time.time() * 1000)

def esc(s):
    return "'" + (s or "").replace("'", "''") + "'"

def nid(p):
    return f"{p}_{uuid.uuid4().hex}"

TABLE_SEP = re.compile(r'^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$')

def cells(line):
    return [c.strip() for c in line.strip().strip('|').split('|')]

def md_to_blocks(md):
    """-> [(type, content_dict, depth)] — the Python twin of markdownToBlocks."""
    out, lines = [], md.replace('\r\n', '\n').split('\n')
    in_code, code = False, []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith('```'):
            if in_code:
                out.append(('code', {'text': '\n'.join(code)}, 0)); code = []; in_code = False
            else:
                in_code = True
            i += 1; continue
        if in_code:
            code.append(line); i += 1; continue
        s = line.strip()
        if s == '':
            i += 1; continue
        indent = re.match(r'^[\t ]*', line).group(0).replace('\t', '  ')
        depth = len(indent) // 2

        if '|' in s and i + 1 < len(lines) and TABLE_SEP.match(lines[i + 1]):
            columns = cells(s); rows = []
            i += 2
            while i < len(lines) and '|' in lines[i] and lines[i].strip() != '':
                rows.append(cells(lines[i])); i += 1
            out.append(('table', {'columns': columns, 'rows': rows}, 0)); continue

        if re.match(r'^#{1,6}\s+', s):
            out.append(('heading', {'text': re.sub(r'^#{1,6}\s+', '', s),
                                    'level': len(re.match(r'^#+', s).group(0))}, 0))
        elif re.match(r'^(-|\*|\+)\s+\[[ xX]\]\s+', s):
            out.append(('todo', {'text': re.sub(r'^(-|\*|\+)\s+\[[ xX]\]\s+', '', s),
                                 'checked': bool(re.search(r'\[[xX]\]', s))}, depth))
        elif re.match(r'^(-|\*|\+)\s+', s):
            out.append(('bullet', {'text': re.sub(r'^(-|\*|\+)\s+', '', s)}, depth))
        elif re.match(r'^\d+\.\s+', s):
            out.append(('numbered', {'text': re.sub(r'^\d+\.\s+', '', s)}, depth))
        elif re.match(r'^>\s?', s):
            out.append(('quote', {'text': re.sub(r'^>\s?', '', s)}, 0))
        elif re.match(r'^(-{3,}|\*{3,}|_{3,})$', s):
            out.append(('divider', {}, 0))
        else:
            out.append(('paragraph', {'text': s}, 0))
        i += 1
    if in_code and code:
        out.append(('code', {'text': '\n'.join(code)}, 0))
    return out


def emit_page(node, parent_id, position, sql):
    pid = nid('pg')
    sql.append(
        "INSERT INTO page (id, parent_page_id, collection_id, title, icon, cover, "
        "properties_json, position, status, is_ai, actor, created_at, updated_at) VALUES ("
        f"{esc(pid)}, {esc(parent_id) if parent_id else 'NULL'}, NULL, {esc(node['title'])}, "
        f"{esc(node.get('icon')) if node.get('icon') else 'NULL'}, NULL, '{{}}', {position}, "
        f"'active', 0, 'human', {NOW}, {NOW});"
    )
    sql.append(
        "INSERT INTO search_fts (entity_type, entity_id, title, body) VALUES "
        f"('page', {esc(pid)}, {esc(node['title'])}, {esc(node.get('markdown', '')[:4000])});"
    )

    # Blocks, rebuilding nesting from indentation depth.
    stack, pos = [], 1
    for (btype, content, depth) in md_to_blocks(node.get('markdown', '')):
        d = min(depth, len(stack))
        parent_block = stack[d - 1] if d > 0 else None
        bid = nid('blk')
        sql.append(
            "INSERT INTO block (id, page_id, parent_block_id, type, content_json, position, "
            "version, is_ai, created_at, updated_at) VALUES ("
            f"{esc(bid)}, {esc(pid)}, {esc(parent_block) if parent_block else 'NULL'}, "
            f"{esc(btype)}, {esc(json.dumps(content))}, {pos}, 1, 0, {NOW}, {NOW});"
        )
        pos += 1
        stack = stack[:d] + [bid]

    for i, child in enumerate(node.get('children', [])):
        emit_page(child, pid, i, sql)
    return pid


def main():
    tree = json.load(open(sys.argv[1]))
    sql = []
    for i, root in enumerate(tree):
        emit_page(root, None, 100 + i, sql)
    print(f"-- {len(sql)} statements", file=sys.stderr)
    open(sys.argv[2], 'w').write('\n'.join(sql) + '\n')


if __name__ == '__main__':
    main()
