// Interim root page for Phase 1.
//
// The v5 UI (src/ui.ts) was written against the old single-`page` model and
// cannot render v6 data; the real client is the Next.js workspace from Phase 3
// (Decision E). Rather than serve a broken editor, "/" reports what is live.
// src/ui.ts is retained on disk as the port source for the block editor.
//
// Styled in the product's design tokens (spec §5.2) so this placeholder already
// looks like the thing it is standing in for.

export function renderStatusPage(appName: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(appName)}</title>
<style>
  :root{--canvas:#F8F7F3;--surface:#fff;--ink:#161616;--ink2:#66645F;--border:#DDDAD2;--accent:#365E55}
  @media(prefers-color-scheme:dark){:root{--canvas:#17181a;--surface:#1e2023;--ink:#ecebe6;--ink2:#a5a29a;--border:#33352f;--accent:#7fb0a3}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
  .wrap{max-width:680px;margin:0 auto;padding:72px 24px}
  h1{font-size:32px;letter-spacing:-.02em;margin:0 0 6px}
  p.lede{color:var(--ink2);margin:0 0 28px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:18px 20px;margin-bottom:14px}
  .k{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink2);font-weight:700;margin-bottom:8px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
    background:var(--canvas);border:1px solid var(--border);border-radius:4px;padding:1px 6px}
  ul{margin:0;padding-left:18px;color:var(--ink2)}
  li{margin:3px 0}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:7px}
</style></head><body>
<div class="wrap">
  <h1>${escapeHtml(appName)}</h1>
  <p class="lede"><span class="dot"></span>v6 API is live — D1 canonical, Worker backend.</p>

  <div class="card">
    <div class="k">Status</div>
    Phase 1 (foundation) is in place: typed schema, per-entity store, REST surface, MCP tools.
    The workspace client arrives in Phase 3 — see <code>docs/v6-implementation-plan.md</code>.
  </div>

  <div class="card">
    <div class="k">Start here</div>
    <ul>
      <li><code>POST /api/bootstrap</code> — seed the default Life Areas</li>
      <li><code>GET /api/schema</code> — the object model and its vocabularies</li>
      <li><code>GET /api/home</code> — what matters now / next / needs review</li>
      <li><code>GET /api/review</code> — the guided weekly review</li>
    </ul>
  </div>

  <div class="card">
    <div class="k">Entities</div>
    <ul>
      <li><code>/api/areas</code> · <code>/api/goals</code> · <code>/api/projects</code></li>
      <li><code>/api/logs</code> · <code>/api/notes</code> · <code>/api/captures</code></li>
      <li><code>/api/tools</code> · <code>/api/sources</code> · <code>/api/content</code></li>
      <li>each also: <code>/{id}/body</code>, <code>/{id}/backlinks</code>, <code>/{id}/relations</code></li>
    </ul>
  </div>
</div>
</body></html>`;
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
