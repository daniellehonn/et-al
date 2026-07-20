// Notion-style block editor over the nested R2 vault. Folders are the nav tree
// (spaces/subspaces); a page's space is the folder it lives in. Blocks are the
// editing unit; markdown is always the wire format. Links are [[Title]]
// wikilinks with live autocomplete; backlinks and goal-children render inline.

export function renderApp(appName: string, schema: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(appName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;height:100vh;overflow:hidden;background:#fbfcfd;color:#1e2530;font-family:'Hanken Grotesk',system-ui,sans-serif}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:rgba(30,41,59,.14);border-radius:6px;border:3px solid #fbfcfd}
@keyframes etfade{from{opacity:0}to{opacity:1}}
@keyframes etpop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
a{color:#7c93ab}
button,input,textarea{font:inherit}
.mono{font-family:'IBM Plex Mono',monospace}
.shell{height:100vh;display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid rgba(30,41,59,.08);background:#fff;flex:none}
.brand{display:flex;align-items:center;gap:12px;cursor:pointer;border:0;background:none;padding:0}
/* The logo art sits on a 2000px square with wide padding, so this is a fixed
   window cropped to the measured glyph box (352,566 1288x714) — scaling the
   whole canvas down would render the mark about a third of its intended size. */
.brand-mark{display:block;height:18px;width:32.5px;overflow:hidden;position:relative;flex:none}
.brand-mark img{position:absolute;width:50.4px;height:50.4px;left:-8.9px;top:-14.3px}
.wordmark{font-size:16px;font-weight:600;letter-spacing:.28em;text-transform:uppercase}
.stamp{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:#93a0ae}
.search{display:flex;align-items:center;gap:8px;width:280px;padding:7px 12px;background:#f2f5f8;border:1px solid rgba(30,41,59,.07);border-radius:9px}
.search span{width:11px;height:11px;border:1.5px solid #b3bdc8;border-radius:50%;flex:none}
.search input{border:none;background:transparent;outline:none;width:100%;color:#1e2530;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
.capture-btn{display:flex;align-items:center;gap:7px;padding:8px 15px;background:#1e2530;color:#fff;border:0;border-radius:9px;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
.capture-btn:hover{background:#31404f}
.body{flex:1;display:flex;min-height:0}
aside.nav{width:250px;flex:none;padding:20px 12px;border-right:1px solid rgba(30,41,59,.08);background:#f7f9fb;display:flex;flex-direction:column;gap:8px;overflow:auto}
.nav-head{display:flex;align-items:center;justify-content:space-between;font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:#9aa6b3;padding:6px 8px 4px}
.nav-head button{border:0;background:none;color:#aeb8c3;cursor:pointer;font-size:14px;line-height:0;padding:2px 4px;border-radius:5px}
.nav-head button:hover{background:rgba(30,41,59,.06);color:#4a5563}
.trow{display:flex;align-items:center;gap:5px;padding:6px 8px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:#4a5563;text-align:left;width:100%}
.trow:hover{background:rgba(30,41,59,.05)}
.trow.active{background:#e9eef4;font-weight:600;color:#1e2530}
.trow .caret{width:14px;flex:none;color:#b3bdc8;font-size:10px;transition:transform .12s;text-align:center}
.trow .caret.open{transform:rotate(90deg)}
.trow .sdot{width:8px;height:8px;border-radius:3px;flex:none}
.trow .sname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trow .scount{font-family:'IBM Plex Mono',monospace;font-size:9px;color:#aeb8c3}
.nav-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid rgba(30,41,59,.08);font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:.12em;text-transform:uppercase;color:#9aa6b3;line-height:1.9}
main{flex:1;overflow:auto;min-width:0}
.home{max-width:900px;padding:26px 40px;display:flex;flex-direction:column;gap:22px;animation:etfade .2s}
.crumbs{display:flex;align-items:center;gap:6px;font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#93a0ae;flex-wrap:wrap}
.crumbs button{border:0;background:none;color:#93a0ae;cursor:pointer;padding:0;font:inherit;letter-spacing:inherit;text-transform:inherit}
.crumbs button:hover{color:#1e2530}
.space-title{font-size:26px;font-weight:700;letter-spacing:-.015em;margin:8px 0 0;display:flex;align-items:center;gap:10px}
.space-desc{color:#7a8794;font-size:13.5px;margin-top:4px}
.overview{background:#fff;border:1px solid rgba(30,41,59,.09);border-radius:12px;padding:16px 20px;margin-top:6px}
.sec-head{display:flex;align-items:center;justify-content:space-between;margin:6px 0 12px}
h2.sec{margin:0;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;letter-spacing:.22em;text-transform:uppercase}
.sec-meta{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae}
.mini-btn{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#7a8794;background:#fff;border:1px solid rgba(30,41,59,.14);border-radius:7px;padding:6px 10px;cursor:pointer}
.mini-btn:hover{border-color:rgba(30,41,59,.3);color:#1e2530}
.subspaces{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.subchip{display:flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid rgba(30,41,59,.1);border-radius:9px;background:#fff;cursor:pointer;font-size:12.5px;color:#4a5563}
.subchip:hover{border-color:rgba(30,41,59,.25)}
.subchip .sdot{width:8px;height:8px;border-radius:3px}
.feed{display:flex;flex-direction:column;gap:9px}
.feed-card{background:#fff;border:1px solid rgba(30,41,59,.09);border-radius:12px;padding:14px 18px;display:flex;gap:16px;cursor:pointer;text-align:left;width:100%}
.feed-card:hover{border-color:rgba(30,41,59,.2);box-shadow:0 4px 16px rgba(30,41,59,.07)}
.feed-meta{display:flex;align-items:center;gap:9px;margin-bottom:5px}
.tag{font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;border-radius:5px;border:1px solid}
.feed-title{font-size:14.5px;font-weight:600;margin-bottom:3px}
.feed-snippet{font-size:13px;color:#7a8794;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.num{font-family:'IBM Plex Mono',monospace;font-size:9px;color:#c2ccd6;letter-spacing:.1em}
.placeholder{padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#aeb8c3}
.btn-primary{padding:9px 18px;font-size:12.5px;font-weight:600;color:#fff;background:#1e2530;border:0;border-radius:9px;cursor:pointer}
.btn-primary:disabled{background:#aab6c4;cursor:not-allowed}
.btn-ghost{padding:9px 16px;font-size:12.5px;font-weight:600;color:#7a8794;background:none;border:0;cursor:pointer;border-radius:9px}
.btn-ghost:hover{background:#eef2f6}
/* editor */
.doc{display:flex;animation:etfade .2s}
.doc-main{flex:1;padding:24px 40px 120px;min-width:0;max-width:760px}
.doc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px}
.actions{display:flex;gap:16px;font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:#7a8794;flex:none}
.actions button{border:0;background:none;color:inherit;cursor:pointer;padding:0}
.actions button:hover{color:#1e2530}
.doc-title{width:100%;border:0;outline:0;background:none;font-size:30px;font-weight:700;letter-spacing:-.02em;line-height:1.2;color:#1e2530;margin:0 0 6px;padding:0;resize:none;overflow:hidden;font-family:inherit}
.doc-meta{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae;padding-bottom:16px;border-bottom:1px solid rgba(30,41,59,.08);margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.editor{display:flex;flex-direction:column}
.blk{display:flex;align-items:flex-start;gap:6px;padding:2px 0;position:relative}
.blk .handle{opacity:0;width:16px;flex:none;color:#c2ccd6;cursor:grab;font-size:13px;text-align:center;user-select:none;padding-top:4px}
.blk:hover .handle{opacity:1}
.blk .ct{flex:1;min-width:0;outline:0;line-height:1.65;font-size:15px;color:#2f3a47;padding:2px 2px;border-radius:4px;white-space:pre-wrap;word-break:break-word}
.blk .ct:empty:before{content:attr(data-ph);color:#c2ccd6}
.blk[data-type=h1] .ct{font-size:26px;font-weight:700;letter-spacing:-.015em}
.blk[data-type=h2] .ct{font-size:21px;font-weight:700;letter-spacing:-.01em}
.blk[data-type=h3] .ct{font-size:17px;font-weight:600}
.blk[data-type=quote] .ct{border-left:3px solid #d7dee6;padding-left:12px;color:#5a6675;font-style:italic}
.blk[data-type=callout]{background:#f2f5f8;border-radius:9px;padding:10px 12px;margin:3px 0}
.blk[data-type=code]{background:#1e2530;border-radius:9px;padding:12px 14px;margin:4px 0}
.blk[data-type=code] .ct{font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:#e6edf3;white-space:pre-wrap}
.blk .marker{flex:none;width:20px;text-align:center;color:#93a0ae;user-select:none;padding-top:3px;font-size:14px}
.blk[data-type=number] .marker{font-family:'IBM Plex Mono',monospace;font-size:12px;color:#aeb8c3}
.chk{flex:none;width:17px;height:17px;margin-top:4px;border:1.6px solid #c2ccd6;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;line-height:0}
.chk.on{background:#7ca88f;border-color:#7ca88f}
.blk[data-type=todo-done] .ct{color:#9aa6b3;text-decoration:line-through}
.hr{height:1px;background:rgba(30,41,59,.14);margin:8px 0;flex:1}
.wikilink{color:#5e7994;background:rgba(124,147,171,.12);border-radius:4px;padding:0 4px;cursor:pointer;white-space:nowrap;text-decoration:none}
.wikilink:hover{background:rgba(124,147,171,.22)}
.wikilink.unresolved{color:#b08968;background:none;border-bottom:1px dashed #cbb190;border-radius:0;padding:0}
.menu{position:absolute;z-index:60;background:#fff;border:1px solid rgba(30,41,59,.14);border-radius:11px;box-shadow:0 12px 40px rgba(20,26,34,.18);padding:6px;min-width:230px;max-height:300px;overflow:auto;animation:etpop .12s}
.menu .mrow{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px;color:#3a4553}
.menu .mrow.sel,.menu .mrow:hover{background:#eef2f6}
.menu .mrow .mi{width:24px;height:24px;flex:none;display:flex;align-items:center;justify-content:center;border:1px solid rgba(30,41,59,.1);border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#7a8794}
.menu .mrow .mt{font-weight:600}
.menu .mrow .md{font-size:11px;color:#9aa6b3}
.menu .mhead{font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:.16em;text-transform:uppercase;color:#aeb8c3;padding:6px 10px 4px}
aside.meta{width:252px;flex:none;padding:24px 20px;border-left:1px solid rgba(30,41,59,.08);background:#f7f9fb;display:flex;flex-direction:column;gap:18px;overflow:auto}
.meta-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9aa6b3;margin-bottom:8px}
.metasel{width:100%;font-size:12.5px;color:#3a4553;border:1px solid rgba(30,41,59,.14);border-radius:8px;padding:7px 8px;background:#fff;cursor:pointer}
.pick-inline{display:flex;flex-wrap:wrap;gap:5px}
.pick-inline button{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase;padding:5px 8px;border:1px solid rgba(30,41,59,.12);border-radius:7px;background:#fff;color:#7a8794;cursor:pointer}
.pick-inline button.on{background:#1e2530;color:#fff;border-color:#1e2530}
.tag-pill{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#4a5563;background:#e9eef4;padding:4px 9px;border-radius:20px}
.bl-row{display:block;width:100%;text-align:left;background:none;border:0;border-radius:9px;padding:9px 10px;cursor:pointer;margin-bottom:4px}
.bl-row:hover{background:#eef2f6}
.bl-title{font-size:12.5px;font-weight:600;color:#3a4553;display:flex;align-items:center;gap:7px}
.bl-ctx{font-size:11.5px;color:#93a0ae;line-height:1.4;margin-top:3px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.via{font-family:'IBM Plex Mono',monospace;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:#b1a07c}
.child-row{display:flex;align-items:center;gap:9px;padding:8px 6px;border-bottom:1px solid rgba(30,41,59,.06);cursor:pointer;background:none;border-left:0;border-right:0;border-top:0;width:100%;text-align:left}
.child-row:hover{background:#fafbfc}
.child-row .text{flex:1;font-size:13px}
.overlay{position:fixed;inset:0;background:rgba(20,26,34,.28);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;z-index:80;animation:etfade .15s}
.modal{width:520px;background:#fbfcfd;border:1px solid rgba(30,41,59,.12);border-radius:16px;box-shadow:0 24px 60px rgba(20,26,34,.24);overflow:hidden;animation:etpop .18s}
.modal-head{padding:16px 22px;border-bottom:1px solid rgba(30,41,59,.08);display:flex;align-items:center;gap:12px}
.modal-head .t{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#93a0ae;flex:1}
.modal-body{padding:22px}
.modal-body input.title{width:100%;border:none;outline:none;background:transparent;font-size:20px;font-weight:600;color:#1e2530;margin-bottom:20px}
.field-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:#9aa6b3;margin-bottom:9px}
.pick{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.pick button{font-family:'IBM Plex Mono',monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;padding:8px 13px;border:0;border-radius:8px;cursor:pointer;background:#eef2f6;color:#4a5563}
.pick button.active{background:#1e2530;color:#fff}
.modal-body select.metasel{margin-bottom:18px}
.modal-foot{display:flex;justify-content:flex-end;gap:10px;align-items:center}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e2530;color:#fff;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:10px 18px;border-radius:9px;z-index:90;animation:etpop .18s}
</style>
</head>
<body>
<div class="shell">
  <div class="topbar">
    <button class="brand" id="brand" title="et al."><span class="brand-mark"><img src="/etallogo2.png" alt="et al."></span><span class="stamp" id="stamp">VAULT</span></button>
    <div style="display:flex;align-items:center;gap:12px">
      <div class="search"><span></span><input id="search" placeholder="Search vault…" autocomplete="off"></div>
      <button class="capture-btn" id="openCapture">+&nbsp;New page</button>
    </div>
  </div>
  <div class="body">
    <aside class="nav">
      <div class="nav-head"><span>§ Spaces</span><button id="newSpaceBtn" title="New top-level space">+</button></div>
      <div id="spaceTree"></div>
      <div class="nav-foot" id="navFoot"></div>
    </aside>
    <main id="main"></main>
  </div>
</div>
<div id="modalRoot"></div>
<div id="menuRoot"></div>
<div id="toastRoot"></div>
<script>
window.onerror=function(m,s,l,c,e){document.getElementById('main').innerHTML='<div class="placeholder" style="color:#b4776f;text-align:left;font-family:monospace;font-size:12px;white-space:pre-wrap">JS ERROR: '+m+'\\n'+(e&&e.stack?e.stack:'')+'</div>';};
var SCHEMA=${JSON.stringify(schema)};
var TYPE_META={page:{label:'Page',color:'#7c93ab',border:'rgba(124,147,171,.35)'},goal:{label:'Goal',color:'#93a3b6',border:'rgba(147,163,182,.35)'},idea:{label:'Idea',color:'#7ca88f',border:'rgba(124,168,143,.35)'},task:{label:'Task',color:'#c4917c',border:'rgba(196,145,124,.35)'},link:{label:'Link',color:'#b1a07c',border:'rgba(177,160,124,.35)'}};
var TYPE_KEYS=SCHEMA.types, PALETTE=['#7c93ab','#b1a07c','#7ca88f','#c48b8b','#8a7cab','#6f8fa8','#c4917c'];

var state={view:'space',space:'',pageId:null,query:'',
  spaces:[],spaceByPath:{},pages:[],titleIndex:{},collapsed:{},
  doc:null,blocks:[],backlinks:[],children:[],overview:'',
  authed:false,loading:true,error:null,capture:null,newspace:null,unlock:null,toast:null,lastSync:null,dirty:false};

/* helpers */
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function pad(n){return String(n).padStart(3,'0');}
function pad2(n){return String(n).padStart(2,'0');}
function norm(t){return String(t||'').toLowerCase().replace(/\\s+/g,' ').trim();}
function typeOf(p){return TYPE_META[p.type]?p.type:'page';}
function hashColor(p){var h=0;for(var i=0;i<p.length;i++)h=(h*31+p.charCodeAt(i))>>>0;return PALETTE[h%PALETTE.length];}
function spaceColor(path){var s=state.spaceByPath[path];return (s&&s.color)?s.color:hashColor(path||'root');}
function spaceName(path){if(!path)return'Vault';var s=state.spaceByPath[path];return s?s.name:path.split('/').pop();}
function docSpace(d){return d?(d.space_path||''):'';}
function clock(ts){var d=new Date(ts*1000);return pad2(d.getHours())+':'+pad2(d.getMinutes());}
function stamp(ts){var diff=Date.now()/1000-ts;if(diff<3600)return Math.max(1,Math.round(diff/60))+'m';if(diff<86400)return Math.round(diff/3600)+'h';var d=new Date(ts*1000);return pad2(d.getDate())+'·'+pad2(d.getMonth()+1);}
function toast(m){state.toast=m;renderToast();clearTimeout(toast.t);toast.t=setTimeout(function(){state.toast=null;renderToast();},2000);}
function idForTitle(t){return state.titleIndex[norm(t)]||null;}
function rebuildTitleIndex(){state.titleIndex={};state.pages.forEach(function(p){if(!state.titleIndex[norm(p.title)])state.titleIndex[norm(p.title)]=p.id;});}
function childPathsOf(path){return state.spaces.filter(function(s){return s.parent_path===path;});}
function goalTitles(){return state.pages.filter(function(p){return p.type==='goal';}).map(function(p){return p.title;});}

/* block model (mirrors src/markdown.ts) */
function parseBlocks(body){
  var blocks=[],lines=String(body||'').replace(/\\n+$/,'').split('\\n'),i=0;
  while(i<lines.length){
    var line=lines[i],f=line.match(/^\\\`\\\`\\\`(\\w*)\\s*$/);
    if(f){var lang=f[1]||'',buf=[];i++;while(i<lines.length&&!/^\\\`\\\`\\\`\\s*$/.test(lines[i]))buf.push(lines[i++]);i++;blocks.push({type:'code',text:buf.join('\\n'),lang:lang});continue;}
    if(/^\\s*---\\s*$/.test(line)){blocks.push({type:'divider',text:''});i++;continue;}
    if(/^\\s*$/.test(line)){i++;continue;}
    var m;
    if((m=line.match(/^#\\s+(.*)$/)))blocks.push({type:'h1',text:m[1]});
    else if((m=line.match(/^##\\s+(.*)$/)))blocks.push({type:'h2',text:m[1]});
    else if((m=line.match(/^###\\s+(.*)$/)))blocks.push({type:'h3',text:m[1]});
    else if((m=line.match(/^\\s*[-*]\\s+\\[([ xX])\\]\\s+(.*)$/)))blocks.push({type:m[1].toLowerCase()==='x'?'todo-done':'todo',text:m[2]});
    else if((m=line.match(/^\\s*>\\s*\\[!\\w+\\]\\s*(.*)$/)))blocks.push({type:'callout',text:m[1]});
    else if((m=line.match(/^\\s*>\\s+(.*)$/)))blocks.push({type:'quote',text:m[1]});
    else if((m=line.match(/^\\s*\\d+\\.\\s+(.*)$/)))blocks.push({type:'number',text:m[1]});
    else if((m=line.match(/^\\s*[-*]\\s+(.*)$/)))blocks.push({type:'bullet',text:m[1]});
    else blocks.push({type:'paragraph',text:line});
    i++;
  }
  if(!blocks.length)blocks.push({type:'paragraph',text:''});
  return blocks;
}
function serializeBlocks(blocks){
  var out=[],n=0;
  blocks.forEach(function(b){
    if(b.type!=='number')n=0;
    if(b.type==='h1')out.push('# '+b.text);else if(b.type==='h2')out.push('## '+b.text);else if(b.type==='h3')out.push('### '+b.text);
    else if(b.type==='todo')out.push('- [ ] '+b.text);else if(b.type==='todo-done')out.push('- [x] '+b.text);
    else if(b.type==='bullet')out.push('- '+b.text);else if(b.type==='number')out.push((++n)+'. '+b.text);
    else if(b.type==='quote')out.push('> '+b.text);else if(b.type==='callout')out.push('> [!note] '+b.text);
    else if(b.type==='divider')out.push('---');else if(b.type==='code')out.push('\\\`\\\`\\\`'+(b.lang||'')+'\\n'+b.text+'\\n\\\`\\\`\\\`');
    else out.push(b.text);
    out.push('');
  });
  return out.join('\\n').replace(/\\n+$/,'')+'\\n';
}
function renderInline(text){
  var out='',re=/\\[\\[([^\\]|#]+?)(?:#[^\\]|]+)?(?:\\|([^\\]]+))?\\]\\]|\\\`([^\\\`]+)\\\`|\\*\\*([^*]+)\\*\\*/g,last=0,m;
  while((m=re.exec(text))!==null){
    out+=esc(text.slice(last,m.index));last=re.lastIndex;
    if(m[1]!==undefined){var title=m[1].trim(),label=(m[2]||title).trim(),resolved=!!idForTitle(title);
      out+='<span class="wikilink'+(resolved?'':' unresolved')+'" data-link="'+esc(title)+'">'+esc(label)+'</span>';}
    else if(m[3]!==undefined)out+='<code style="font-family:IBM Plex Mono,monospace;font-size:.9em;background:#eef2f6;padding:0 4px;border-radius:4px">'+esc(m[3])+'</code>';
    else if(m[4]!==undefined)out+='<b>'+esc(m[4])+'</b>';
  }
  out+=esc(text.slice(last));return out||'';
}

/* data */
async function loadAll(quiet){
  if(!quiet){state.loading=true;render();}
  try{
    var r=await Promise.all([fetch('/api/spaces'),fetch('/api/pages?limit=500'),fetch('/api/session',{credentials:'same-origin'})]);
    var d=await Promise.all([r[0].json(),r[1].json(),r[2].json()]);
    state.spaces=d[0].spaces||[];state.spaceByPath={};state.spaces.forEach(function(s){state.spaceByPath[s.path]=s;});
    state.pages=d[1].pages||[];state.authed=!!d[2].authenticated;rebuildTitleIndex();state.lastSync=Date.now();
  }catch(e){if(!quiet)state.error='The vault could not be loaded.';}
  finally{state.loading=false;render();}
}
async function refreshSpaces(){try{var r=await fetch('/api/spaces');if(r.ok){state.spaces=(await r.json()).spaces||[];state.spaceByPath={};state.spaces.forEach(function(s){state.spaceByPath[s.path]=s;});}}catch(e){}}
async function write(method,path,payload){
  var r=await fetch(path,{method:method,credentials:'same-origin',headers:{'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});
  var d=await r.json().catch(function(){return{};});
  if(r.status===401){state.authed=false;var e=new Error('Unlock the vault to save.');e.needsUnlock=true;throw e;}
  if(!r.ok)throw new Error(d.error||'Request failed.');
  return d;
}
function failWrite(e,retry){if(e&&e.needsUnlock){state.unlock={key:'',error:null,retry:retry};render();}else toast(e.message);}

function openSpace(path){state.view='space';state.space=path||'';state.pageId=null;state.query='';state.overview='';render();
  if(path){fetch('/api/space?path='+encodeURIComponent(path)).then(function(r){return r.ok?r.json():null;}).then(function(sp){if(sp&&state.view==='space'&&state.space===path){state.overview=sp.overview||'';render();}});}
}
async function openPage(id){
  state.view='page';state.pageId=id;state.loading=true;render();
  try{
    var doc=await(await fetch('/api/pages/'+encodeURIComponent(id))).json();
    if(doc.error){toast('Page not found');openSpace(state.space);return;}
    state.doc=doc;state.blocks=parseBlocks(doc.body);state.dirty=false;state.backlinks=[];state.children=[];
    state.loading=false;render();
    fetch('/api/pages/'+encodeURIComponent(id)+'/backlinks').then(function(r){return r.json();}).then(function(d){if(state.pageId===id){state.backlinks=d.backlinks||[];renderBacklinks();}});
    fetch('/api/pages/'+encodeURIComponent(id)+'/children').then(function(r){return r.json();}).then(function(d){if(state.pageId===id){state.children=d.children||[];renderChildren();}});
  }catch(e){state.loading=false;toast('Could not open page');openSpace(state.space);}
}

var saveTimer=null;
function scheduleSave(){state.dirty=true;clearTimeout(saveTimer);saveTimer=setTimeout(saveDoc,700);setSync('editing…');}
async function saveDoc(){
  if(!state.doc||!state.dirty)return;
  try{
    var updated=await write('PATCH','/api/pages/'+encodeURIComponent(state.doc.id),{body:serializeBlocks(state.blocks),title:state.doc.title});
    state.doc=updated;state.dirty=false;mergePage(updated);setSync('Saved '+clock(Date.now()/1000));
    fetch('/api/pages/'+encodeURIComponent(updated.id)+'/backlinks').then(function(r){return r.json();}).then(function(d){if(state.pageId===updated.id){state.backlinks=d.backlinks||[];renderBacklinks();}});
    refreshLinkStyles();
  }catch(e){failWrite(e,saveDoc);}
}
function setSync(t){var el=document.getElementById('syncState');if(el)el.textContent=t;}
function mergePage(u){var meta={id:u.id,path:u.path,space_path:u.space_path,title:u.title,type:u.type,status:u.status,tags:u.tags,parent:u.parent,due:u.due,updated_at:u.updated_at,excerpt:''};var i=state.pages.findIndex(function(p){return p.id===u.id;});if(i===-1)state.pages.unshift(meta);else state.pages[i]=meta;rebuildTitleIndex();state.lastSync=Date.now();}
async function patchMeta(updates){
  if(!state.doc)return;
  try{var u=await write('PATCH','/api/pages/'+encodeURIComponent(state.doc.id),updates);state.doc=u;mergePage(u);await refreshSpaces();render();
    fetch('/api/pages/'+encodeURIComponent(u.id)+'/children').then(function(r){return r.json();}).then(function(d){if(state.pageId===u.id){state.children=d.children||[];renderChildren();}});
    toast('Updated');}
  catch(e){failWrite(e,function(){patchMeta(updates);});}
}
async function createPageFromTitle(title,spacePath,type){
  try{var doc=await write('POST','/api/pages',{title:title,space_path:spacePath||'',type:type||'idea'});mergePage(doc);await refreshSpaces();return doc;}
  catch(e){failWrite(e,function(){createPageFromTitle(title,spacePath,type);});return null;}
}

/* render shell */
function render(){
  renderTree();
  var main=document.getElementById('main');
  if(state.loading)main.innerHTML='<div class="placeholder">Loading vault…</div>';
  else if(state.error)main.innerHTML='<div class="placeholder">'+esc(state.error)+'</div>';
  else if(state.query.trim())main.innerHTML=renderSearch();
  else if(state.view==='page'&&state.doc)renderDoc();
  else main.innerHTML=renderSpaceView();
  document.getElementById('modalRoot').innerHTML=state.unlock?renderUnlock():state.newspace?renderNewSpace():state.capture?renderCapture():'';
  document.getElementById('stamp').innerHTML='VAULT&nbsp;·&nbsp;N°'+pad(state.pages.length);
  renderToast();bindShell();
  if(state.unlock)bindUnlock();else if(state.newspace)bindNewSpace();else if(state.capture)bindCapture();
  if(state.view==='page'&&state.doc&&!state.loading&&!state.query.trim())mountEditor();
}
function renderToast(){document.getElementById('toastRoot').innerHTML=state.toast?'<div class="toast">'+esc(state.toast)+'</div>':'';}

function renderTree(){
  var tree=document.getElementById('spaceTree');
  var top=[{path:'',name:'All pages',isAll:true}].concat(state.spaces.filter(function(s){return !s.parent_path;}));
  function node(s,depth){
    var kids=s.isAll?[]:childPathsOf(s.path);
    var open=!!state.collapsed[s.path]===false&&!!s.__open;
    var isOpen=state.collapsed['open:'+s.path];
    var active=state.view==='space'&&state.space===(s.path||'');
    var count=s.isAll?state.pages.length:(s.page_count||0);
    var caret=kids.length?'<span class="caret'+(isOpen?' open':'')+'" data-toggle="'+esc(s.path)+'">▶</span>':'<span class="caret" style="opacity:0">▶</span>';
    var dot=s.isAll?'<span class="sdot" style="background:#1e2530"></span>':'<span class="sdot" style="background:'+spaceColor(s.path)+'"></span>';
    var row='<button class="trow'+(active?' active':'')+'" data-space="'+esc(s.path)+'" style="padding-left:'+(8+depth*14)+'px">'+caret+dot+'<span class="sname">'+esc(s.name)+'</span><span class="scount">'+count+'</span></button>';
    if(kids.length&&isOpen)row+=kids.map(function(k){return node(k,depth+1);}).join('');
    return row;
  }
  tree.innerHTML=top.map(function(s){return node(s,0);}).join('');
  var open=state.pages.filter(function(p){return p.status==='active'||p.status==='inbox';}).length;
  document.getElementById('navFoot').innerHTML='R2 vault · markdown<br>Pages '+pad(state.pages.length)+' · Spaces '+pad(state.spaces.length)+'<br>'+(state.lastSync?'Synced '+clock(state.lastSync/1000):'…')+' · Schema v'+SCHEMA.version;
}

function crumbs(path){
  var parts=path?path.split('/'):[];
  var acc='',html='<button data-space="">Vault</button>';
  parts.forEach(function(seg){acc=acc?acc+'/'+seg:seg;html+=' / <button data-space="'+esc(acc)+'">'+esc(spaceName(acc))+'</button>';});
  return '<div class="crumbs">'+html+'</div>';
}

function renderSpaceView(){
  var path=state.space;
  var pages=state.pages.filter(function(p){return (p.space_path||'')===path;}).sort(function(a,b){return b.updated_at-a.updated_at;});
  var subs=path?childPathsOf(path):state.spaces.filter(function(s){return !s.parent_path;});
  var sp=state.spaceByPath[path];
  var head='<div>'+crumbs(path)+'<div class="space-title">'+(path?'<span class="sdot" style="width:12px;height:12px;border-radius:4px;background:'+spaceColor(path)+'"></span>':'')+esc(path?spaceName(path):'All pages')+'</div>'+
    (sp&&sp.description?'<div class="space-desc">'+esc(sp.description)+'</div>':'')+'</div>';
  var toolbar='<div class="sec-head"><div style="display:flex;gap:8px">'+
    '<button class="mini-btn" data-newpage>+ Page</button>'+
    '<button class="mini-btn" data-newsub>+ Subspace</button>'+
    (path?'<button class="mini-btn" data-editoverview>Overview</button>':'')+
    '</div><span class="sec-meta">'+pages.length+' pages'+(subs.length?' · '+subs.length+' subspace'+(subs.length===1?'':'s'):'')+'</span></div>';
  var overview=(path&&state.overview&&state.overview.trim())?'<div class="overview"><div style="font-family:IBM Plex Mono,monospace;font-size:8.5px;letter-spacing:.16em;text-transform:uppercase;color:#aeb8c3;margin-bottom:8px">Overview</div>'+renderOverviewBody(state.overview)+'</div>':'';
  var subBlock=subs.length?'<div class="subspaces">'+subs.map(function(s){return '<button class="subchip" data-space="'+esc(s.path)+'"><span class="sdot" style="background:'+spaceColor(s.path)+'"></span>'+esc(s.name)+' <span class="num">'+(s.page_count||0)+'</span></button>';}).join('')+'</div>':'';
  var feed=pages.length?pages.map(function(p){var t=typeOf(p);
    return '<button class="feed-card" data-open="'+esc(p.id)+'"><div style="flex:1;min-width:0"><div class="feed-meta"><span class="tag" style="color:'+TYPE_META[t].color+';border-color:'+TYPE_META[t].border+'">'+esc(TYPE_META[t].label)+'</span>'+(p.parent?'<span class="sec-meta" style="text-transform:none;letter-spacing:0;color:#b1a07c">↑ '+esc(p.parent)+'</span>':'')+'<span style="flex:1"></span><span class="num">'+stamp(p.updated_at)+'</span></div><div class="feed-title">'+esc(p.title)+'</div><div class="feed-snippet">'+esc(p.excerpt||'Empty page — open to write.')+'</div></div></button>';
  }).join(''):'<div class="placeholder" style="text-transform:none;letter-spacing:0;font-family:Hanken Grotesk,sans-serif;font-size:13.5px">No pages here yet.<br><button class="btn-primary" data-newpage style="margin-top:14px">Create a page</button></div>';
  return '<div class="home">'+head+overview+subBlock+toolbar+'<div class="feed">'+feed+'</div></div>';
}
function renderOverviewBody(md){
  return parseBlocks(md).map(function(b){
    if(b.type==='h1')return '<div style="font-size:17px;font-weight:700;margin:6px 0 4px">'+renderInline(b.text)+'</div>';
    if(b.type==='h2'||b.type==='h3')return '<div style="font-size:14px;font-weight:600;margin:6px 0 3px">'+renderInline(b.text)+'</div>';
    if(b.type==='bullet'||b.type==='todo'||b.type==='todo-done')return '<div style="font-size:13px;color:#3a4553;padding-left:6px">• '+renderInline(b.text)+'</div>';
    if(b.type==='divider')return '<div class="hr"></div>';
    return '<div style="font-size:13.5px;color:#3a4553;line-height:1.6;margin-bottom:4px">'+renderInline(b.text)+'</div>';
  }).join('');
}

function renderSearch(){
  var q=state.query.trim().toLowerCase();
  var list=state.pages.filter(function(p){return (p.title+' '+(p.excerpt||'')).toLowerCase().indexOf(q)>-1&&p.status!=='archived';}).slice(0,50);
  var feed=list.length?list.map(function(p){var t=typeOf(p);
    return '<button class="feed-card" data-open="'+esc(p.id)+'"><div style="flex:1;min-width:0"><div class="feed-meta"><span class="tag" style="color:'+TYPE_META[t].color+';border-color:'+TYPE_META[t].border+'">'+esc(TYPE_META[t].label)+'</span><span class="sec-meta">'+esc(spaceName(p.space_path||''))+'</span></div><div class="feed-title">'+esc(p.title)+'</div><div class="feed-snippet">'+esc(p.excerpt||'')+'</div></div></button>';
  }).join(''):'<div class="placeholder">No matches</div>';
  return '<div class="home"><div class="sec-head"><h2 class="sec">Search</h2><span class="num">'+list.length+' results</span></div><div class="feed">'+feed+'</div></div>';
}

/* editor + doc */
function renderDoc(){
  var d=state.doc,path=docSpace(d);
  document.getElementById('main').innerHTML=
    '<div class="doc"><div class="doc-main"><div class="doc-head">'+crumbs(path)+
      '<div class="actions"><span id="syncState" class="sec-meta" style="text-transform:none;letter-spacing:0"></span><button data-act="archive">Archive</button><button data-act="delete">Delete</button></div></div>'+
      '<textarea class="doc-title" id="docTitle" rows="1" placeholder="Untitled">'+esc(d.title)+'</textarea>'+
      '<div class="doc-meta"><span>'+esc(TYPE_META[typeOf(d)].label)+'</span><span>·</span><span>'+esc(path?spaceName(path):'Vault root')+'</span><span>·</span><span>Edited '+stamp(d.updated_at)+'</span>'+(d.parent?'<span>·</span><span style="color:#b1a07c">↑ '+esc(d.parent)+'</span>':'')+'</div>'+
      '<div class="editor" id="editor"></div></div>'+renderSidebar(d)+'</div>';
}
function spaceOptions(sel){
  var opts='<option value=""'+(!sel?' selected':'')+'>Vault root</option>';
  state.spaces.slice().sort(function(a,b){return a.path<b.path?-1:1;}).forEach(function(s){
    var depth=s.path.split('/').length-1;opts+='<option value="'+esc(s.path)+'"'+(sel===s.path?' selected':'')+'>'+'  '.repeat(depth)+esc(s.name)+'</option>';});
  return opts;
}
function renderSidebar(d){
  var goals=goalTitles().filter(function(t){return norm(t)!==norm(d.title);});
  return '<aside class="meta">'+
    '<div><div class="meta-label">Type</div><div class="pick-inline">'+TYPE_KEYS.map(function(k){return '<button class="'+(d.type===k?'on':'')+'" data-mtype="'+k+'">'+esc(TYPE_META[k].label)+'</button>';}).join('')+'</div></div>'+
    '<div><div class="meta-label">Status</div><div class="pick-inline">'+SCHEMA.statuses.map(function(k){return '<button class="'+(d.status===k?'on':'')+'" data-mstatus="'+k+'">'+esc(k)+'</button>';}).join('')+'</div></div>'+
    '<div><div class="meta-label">Space (folder)</div><select class="metasel" id="spaceMove">'+spaceOptions(docSpace(d))+'</select></div>'+
    '<div><div class="meta-label">Parent goal ↑</div><select class="metasel" id="parentSel"><option value="">— none —</option>'+goals.map(function(t){return '<option value="'+esc(t)+'"'+(d.parent&&norm(d.parent)===norm(t)?' selected':'')+'>'+esc(t)+'</option>';}).join('')+'</select></div>'+
    (d.tags&&d.tags.length?'<div><div class="meta-label">Tags</div><div style="display:flex;flex-wrap:wrap;gap:6px">'+d.tags.map(function(t){return '<span class="tag-pill">'+esc(t)+'</span>';}).join('')+'</div></div>':'')+
    '<div><div class="meta-label">Breaks down into →</div><div id="childrenBox"><div class="sec-meta">…</div></div></div>'+
    '<div><div class="meta-label">Linked mentions ←</div><div id="backlinksBox"><div class="sec-meta">…</div></div></div>'+
  '</aside>';
}
function renderChildren(){
  var box=document.getElementById('childrenBox');if(!box)return;
  var kids=state.children||[];
  box.innerHTML=kids.length?kids.map(function(c){var isDone=c.status==='done';
    return '<button class="child-row" data-open="'+esc(c.id)+'"><span class="chk'+(isDone?' on':'')+'">'+(isDone?'✓':'')+'</span><span class="text'+(isDone?'':'')+'" style="'+(isDone?'color:#9aa6b3;text-decoration:line-through':'')+'">'+esc(c.title)+'</span><span class="tag" style="color:'+TYPE_META[typeOf(c)].color+';border-color:'+TYPE_META[typeOf(c)].border+'">'+esc(TYPE_META[typeOf(c)].label)+'</span></button>';
  }).join(''):'<div class="sec-meta" style="text-transform:none;letter-spacing:0">Nothing yet. Add a page and set this goal as its parent.</div>';
  box.querySelectorAll('[data-open]').forEach(function(el){el.onclick=function(){openPage(el.dataset.open);};});
}
function renderBacklinks(){
  var box=document.getElementById('backlinksBox');if(!box)return;
  var bl=state.backlinks||[];
  box.innerHTML=bl.length?bl.map(function(b){return '<button class="bl-row" data-open="'+esc(b.id)+'"><span class="bl-title">'+(b.kind==='parent'?'<span class="via">↑ child</span>':'')+esc(b.title)+'</span><div class="bl-ctx">'+esc(b.context||'')+'</div></button>';}).join(''):'<div class="sec-meta" style="text-transform:none;letter-spacing:0">No mentions yet.</div>';
  box.querySelectorAll('[data-open]').forEach(function(el){el.onclick=function(){openPage(el.dataset.open);};});
}

var editorEl=null;
function mountEditor(){
  editorEl=document.getElementById('editor');if(!editorEl)return;
  var title=document.getElementById('docTitle');autosize(title);
  title.oninput=function(){autosize(title);state.doc.title=title.value;scheduleSave();};
  document.querySelectorAll('[data-act]').forEach(function(el){el.onclick=function(){docAction(el.dataset.act);};});
  document.querySelectorAll('[data-mtype]').forEach(function(el){el.onclick=function(){patchMeta({type:el.dataset.mtype});};});
  document.querySelectorAll('[data-mstatus]').forEach(function(el){el.onclick=function(){patchMeta({status:el.dataset.mstatus});};});
  var sm=document.getElementById('spaceMove');if(sm)sm.onchange=function(){patchMeta({space_path:sm.value});};
  var ps=document.getElementById('parentSel');if(ps)ps.onchange=function(){patchMeta({parent:ps.value||null});};
  buildEditor();renderBacklinks();renderChildren();
}
function autosize(t){if(!t)return;t.style.height='auto';t.style.height=t.scrollHeight+'px';}
function buildEditor(){editorEl.innerHTML='';state.blocks.forEach(function(b,i){editorEl.appendChild(blockEl(b,i));});editorEl.onmousedown=function(e){var w=e.target.closest('.wikilink');if(w){e.preventDefault();handleLinkClick(w.dataset.link);}};}
function blockEl(b,i){
  var wrap=document.createElement('div');wrap.className='blk';wrap.dataset.type=b.type;wrap.dataset.i=i;
  var handle=document.createElement('div');handle.className='handle';handle.textContent='⋮⋮';wrap.appendChild(handle);
  if(b.type==='divider'){var hr=document.createElement('div');hr.className='hr';wrap.appendChild(hr);return wrap;}
  if(b.type==='todo'||b.type==='todo-done'){var chk=document.createElement('div');chk.className='chk'+(b.type==='todo-done'?' on':'');chk.innerHTML=b.type==='todo-done'?'✓':'';chk.onclick=function(e){e.stopPropagation();toggleTodo(i);};wrap.appendChild(chk);}
  else if(b.type==='bullet'){var mk=document.createElement('div');mk.className='marker';mk.textContent='•';wrap.appendChild(mk);}
  else if(b.type==='number'){var mk2=document.createElement('div');mk2.className='marker';mk2.textContent=numberOf(i)+'.';wrap.appendChild(mk2);}
  else if(b.type==='callout'){var mk3=document.createElement('div');mk3.className='marker';mk3.textContent='◆';wrap.appendChild(mk3);}
  var ct=document.createElement('div');ct.className='ct';ct.contentEditable='true';ct.dataset.i=i;ct.dataset.ph=placeholderFor(b.type);
  ct.innerHTML=renderInline(b.text)||'';
  ct.addEventListener('focus',function(){onBlockFocus(ct);});
  ct.addEventListener('blur',function(){onBlockBlur(ct);});
  ct.addEventListener('input',function(){onBlockInput(ct);});
  ct.addEventListener('keydown',function(e){onBlockKey(e,ct);});
  wrap.appendChild(ct);return wrap;
}
function numberOf(i){var n=0;for(var j=0;j<=i;j++){if(state.blocks[j].type==='number')n++;else if(j<i)n=0;}return n;}
function placeholderFor(t){if(t==='h1')return'Heading 1';if(t==='h2')return'Heading 2';if(t==='h3')return'Heading 3';if(t==='todo'||t==='todo-done')return'To-do';if(t==='quote')return'Quote';if(t==='code')return'Code';if(t==='callout')return'Callout';return"Type '/' for commands, [[ to link";}
function ctIndex(ct){return parseInt(ct.dataset.i,10);}
function onBlockFocus(ct){var i=ctIndex(ct);if(ct.dataset.raw!=='1'){ct.textContent=state.blocks[i].text;ct.dataset.raw='1';setCaretEnd(ct);}}
function onBlockBlur(ct){var i=ctIndex(ct);state.blocks[i].text=ct.textContent;ct.innerHTML=renderInline(state.blocks[i].text)||'';ct.dataset.raw='0';}
function onBlockInput(ct){var i=ctIndex(ct);state.blocks[i].text=ct.textContent;if(maybeShortcut(i))return;if(maybeSlash(ct,i))return;else closeSlash();if(maybeLinkAutocomplete(ct,i))return;else closeLinkMenu();scheduleSave();}
function maybeShortcut(i){
  if(state.blocks[i].type!=='paragraph')return false;var t=state.blocks[i].text;
  var map=[[/^#\\s(.*)$/,'h1'],[/^##\\s(.*)$/,'h2'],[/^###\\s(.*)$/,'h3'],[/^[-*]\\s(.*)$/,'bullet'],[/^\\d+\\.\\s(.*)$/,'number'],[/^\\[\\]\\s(.*)$/,'todo'],[/^\\[ \\]\\s(.*)$/,'todo'],[/^>\\s(.*)$/,'quote']];
  for(var k=0;k<map.length;k++){var m=t.match(map[k][0]);if(m){setBlockType(i,map[k][1],m[1],0);return true;}}return false;
}
function maybeSlash(ct,i){var m=state.blocks[i].text.match(/^\\/(\\w*)$/);if(m){openSlashMenu(ct,i,m[1]);return true;}return false;}
function maybeLinkAutocomplete(ct,i){var off=getCaretOffset(ct);var before=state.blocks[i].text.slice(0,off);var m=before.match(/\\[\\[([^\\]]*)$/);if(m){openLinkMenu(ct,i,m[1],off);return true;}return false;}
function onBlockKey(e,ct){
  var i=ctIndex(ct);
  if(menu.kind){if(['ArrowDown','ArrowUp','Enter','Tab','Escape'].indexOf(e.key)>-1){menuKey(e);return;}}
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();splitBlock(i,ct);}
  else if(e.key==='Backspace'){var off=getCaretOffset(ct);if(off===0&&window.getSelection().isCollapsed){e.preventDefault();backspaceStart(i);}}
  else if(e.key==='ArrowUp'){if(getCaretOffset(ct)===0){e.preventDefault();focusBlock(i-1,'end');}}
  else if(e.key==='ArrowDown'){if(getCaretOffset(ct)===state.blocks[i].text.length){e.preventDefault();focusBlock(i+1,'start');}}
}
function splitBlock(i,ct){
  state.blocks[i].text=ct.textContent;var off=getCaretOffset(ct);var text=state.blocks[i].text;var before=text.slice(0,off),after=text.slice(off),type=state.blocks[i].type;
  if((type==='bullet'||type==='number'||type==='todo'||type==='todo-done')&&text===''){setBlockType(i,'paragraph','',0);return;}
  state.blocks[i].text=before;var nt=(type==='bullet'||type==='number')?type:(type==='todo'||type==='todo-done')?'todo':'paragraph';
  state.blocks.splice(i+1,0,{type:nt,text:after});scheduleSave();buildEditor();focusBlock(i+1,'start');
}
function backspaceStart(i){var type=state.blocks[i].type;if(type!=='paragraph'){setBlockType(i,'paragraph',state.blocks[i].text,0);return;}if(i===0)return;var prevLen=state.blocks[i-1].text.length;state.blocks[i-1].text+=state.blocks[i].text;state.blocks.splice(i,1);scheduleSave();buildEditor();focusBlock(i-1,prevLen);}
function setBlockType(i,type,text,caret){state.blocks[i].type=type;if(text!==undefined)state.blocks[i].text=text;scheduleSave();buildEditor();focusBlock(i,caret!==undefined?caret:'end');}
function toggleTodo(i){state.blocks[i].type=state.blocks[i].type==='todo-done'?'todo':'todo-done';scheduleSave();buildEditor();}
function focusBlock(i,pos){if(i<0||i>=state.blocks.length)return;var wrap=editorEl.querySelector('.blk[data-i="'+i+'"]');var ct=wrap&&wrap.querySelector('.ct');if(!ct)return;ct.focus();var off=pos==='end'?state.blocks[i].text.length:pos==='start'?0:pos;setCaret(ct,off);}
function refreshLinkStyles(){if(!editorEl)return;state.blocks.forEach(function(b,i){var wrap=editorEl.querySelector('.blk[data-i="'+i+'"]');if(!wrap)return;var ct=wrap.querySelector('.ct');if(ct&&ct.dataset.raw!=='1')ct.innerHTML=renderInline(b.text)||'';});}
function handleLinkClick(title){var id=idForTitle(title);if(id){openPage(id);}else{createPageFromTitle(title,docSpace(state.doc),'page').then(function(doc){if(doc)openPage(doc.id);});}}
function docAction(a){var d=state.doc;if(!d)return;
  if(a==='archive'){patchMeta({status:'archived'});openSpace(docSpace(d));return;}
  if(a==='delete'){if(!confirm('Delete "'+d.title+'"? Pages linking here become unresolved links.'))return;write('DELETE','/api/pages/'+encodeURIComponent(d.id)).then(function(){state.pages=state.pages.filter(function(p){return p.id!==d.id;});rebuildTitleIndex();refreshSpaces();openSpace(docSpace(d));toast('Page deleted');}).catch(function(e){failWrite(e,function(){docAction('delete');});});}
}
function getCaretOffset(el){var s=window.getSelection();if(!s.rangeCount)return 0;var r=s.getRangeAt(0);var pre=r.cloneRange();pre.selectNodeContents(el);pre.setEnd(r.endContainer,r.endOffset);return pre.toString().length;}
function setCaret(el,off){el.focus();var node=el.firstChild;if(!node)return;var len=(node.textContent||'').length;off=Math.max(0,Math.min(off,len));var r=document.createRange();r.setStart(node,off);r.collapse(true);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}
function setCaretEnd(el){var r=document.createRange();r.selectNodeContents(el);r.collapse(false);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}

/* menus */
var menu={kind:null,ct:null,i:0,items:[],sel:0,caretOff:0};
var SLASH_ITEMS=[{t:'paragraph',mi:'¶',mt:'Text'},{t:'h1',mi:'H1',mt:'Heading 1'},{t:'h2',mi:'H2',mt:'Heading 2'},{t:'h3',mi:'H3',mt:'Heading 3'},{t:'todo',mi:'☑',mt:'To-do'},{t:'bullet',mi:'•',mt:'Bulleted list'},{t:'number',mi:'1.',mt:'Numbered list'},{t:'quote',mi:'"',mt:'Quote'},{t:'callout',mi:'◆',mt:'Callout'},{t:'code',mi:'</>',mt:'Code'},{t:'divider',mi:'—',mt:'Divider'}];
function closeMenus(){if(menu.kind){menu.kind=null;document.getElementById('menuRoot').innerHTML='';return true;}return false;}
function closeSlash(){if(menu.kind==='slash')closeMenus();}
function closeLinkMenu(){if(menu.kind==='link')closeMenus();}
function openSlashMenu(ct,i,query){menu.kind='slash';menu.ct=ct;menu.i=i;var q=query.toLowerCase();menu.items=SLASH_ITEMS.filter(function(it){return !q||it.mt.toLowerCase().indexOf(q)>-1||it.t.indexOf(q)>-1;});menu.sel=0;drawMenu(ct,'Blocks');}
function openLinkMenu(ct,i,query,caretOff){menu.kind='link';menu.ct=ct;menu.i=i;menu.caretOff=caretOff;var q=query.toLowerCase();var m=state.pages.filter(function(p){return p.status!=='archived'&&p.title.toLowerCase().indexOf(q)>-1;}).slice(0,6).map(function(p){return {label:p.title,id:p.id};});if(query.trim()&&!m.some(function(x){return x.label.toLowerCase()===q;}))m.push({label:query.trim(),create:true});menu.items=m;menu.sel=0;drawMenu(ct,'Link to');}
function drawMenu(ct,head){
  var rect=caretRect(ct)||ct.getBoundingClientRect();if(!menu.items.length){closeMenus();return;}
  var html='<div class="menu" style="left:'+Math.round(rect.left)+'px;top:'+Math.round(rect.bottom+6)+'px"><div class="mhead">'+head+'</div>'+
    menu.items.map(function(it,idx){if(menu.kind==='slash')return '<div class="mrow'+(idx===menu.sel?' sel':'')+'" data-mi="'+idx+'"><span class="mi">'+esc(it.mi)+'</span><span class="mt">'+esc(it.mt)+'</span></div>';
      return '<div class="mrow'+(idx===menu.sel?' sel':'')+'" data-mi="'+idx+'"><span class="mi">'+(it.create?'+':'↦')+'</span><span><span class="mt">'+esc(it.label)+'</span>'+(it.create?' <span class="md">New page</span>':'')+'</span></div>';}).join('')+'</div>';
  var root=document.getElementById('menuRoot');root.innerHTML=html;
  root.querySelectorAll('[data-mi]').forEach(function(el){el.onmousedown=function(e){e.preventDefault();menu.sel=parseInt(el.dataset.mi,10);chooseMenu();};});
}
function caretRect(ct){var s=window.getSelection();if(s.rangeCount){var rects=s.getRangeAt(0).getClientRects();if(rects.length)return rects[0];}return null;}
function menuKey(e){
  if(e.key==='Escape'){e.preventDefault();closeMenus();return;}
  if(e.key==='ArrowDown'){e.preventDefault();menu.sel=(menu.sel+1)%menu.items.length;drawMenu(menu.ct,menu.kind==='slash'?'Blocks':'Link to');return;}
  if(e.key==='ArrowUp'){e.preventDefault();menu.sel=(menu.sel-1+menu.items.length)%menu.items.length;drawMenu(menu.ct,menu.kind==='slash'?'Blocks':'Link to');return;}
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();chooseMenu();return;}
}
function chooseMenu(){
  var it=menu.items[menu.sel];if(!it){closeMenus();return;}var i=menu.i;
  if(menu.kind==='slash'){if(it.t==='divider'){state.blocks[i]={type:'divider',text:''};state.blocks.splice(i+1,0,{type:'paragraph',text:''});closeMenus();scheduleSave();buildEditor();focusBlock(i+1,'start');return;}closeMenus();setBlockType(i,it.t,'',0);return;}
  var title=it.label;if(it.create)createPageFromTitle(title,docSpace(state.doc),'page');
  var text=state.blocks[i].text,off=menu.caretOff;var before=text.slice(0,off).replace(/\\[\\[([^\\]]*)$/,'[['+title+']]'),after=text.slice(off);
  state.blocks[i].text=before+after;closeMenus();buildEditor();focusBlock(i,before.length);scheduleSave();
}

/* modals */
function renderCapture(){
  var c=state.capture;
  return '<div class="overlay" id="overlay"><div class="modal" id="modal"><div class="modal-head"><span class="t">New page</span><button class="crumb" id="closeCapture" style="border:0;background:none;font-family:IBM Plex Mono,monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#93a0ae;cursor:pointer">esc</button></div>'+
    '<div class="modal-body"><input class="title" id="capTitle" placeholder="Title…" value="'+esc(c.title)+'" autofocus>'+
    '<div class="field-label">Type</div><div class="pick">'+TYPE_KEYS.map(function(k){return '<button data-cap-type="'+k+'" class="'+(c.type===k?'active':'')+'">'+esc(TYPE_META[k].label)+'</button>';}).join('')+'</div>'+
    '<div class="field-label">Space (folder)</div><select class="metasel" id="capSpace">'+spaceOptions(c.space||'')+'</select>'+
    '<div class="modal-foot"><button class="btn-ghost" id="cancelCapture">Cancel</button><button class="btn-primary" id="submitCapture"'+(c.title.trim()?'':' disabled')+'>Create &amp; open</button></div></div></div></div>';
}
function bindCapture(){
  var overlay=document.getElementById('overlay'),modal=document.getElementById('modal');
  overlay.onclick=function(){state.capture=null;render();};modal.onclick=function(e){e.stopPropagation();};
  document.getElementById('closeCapture').onclick=function(){state.capture=null;render();};
  document.getElementById('cancelCapture').onclick=function(){state.capture=null;render();};
  var t=document.getElementById('capTitle');t.oninput=function(){state.capture.title=t.value;document.getElementById('submitCapture').disabled=!t.value.trim();};t.onkeydown=function(e){if(e.key==='Enter')submitCapture();};t.focus();
  document.querySelectorAll('[data-cap-type]').forEach(function(el){el.onclick=function(){state.capture.type=el.dataset.capType;render();};});
  var cs=document.getElementById('capSpace');cs.onchange=function(){state.capture.space=cs.value;};
  document.getElementById('submitCapture').onclick=submitCapture;
}
async function submitCapture(){
  var c=state.capture;if(!c||!c.title.trim())return;
  try{var doc=await write('POST','/api/pages',{title:c.title.trim(),type:c.type,space_path:c.space||'',status:c.type==='goal'?'active':'inbox'});state.capture=null;mergePage(doc);await refreshSpaces();openPage(doc.id);toast('Page created');}
  catch(e){failWrite(e,submitCapture);}
}
function renderNewSpace(){
  var n=state.newspace;
  return '<div class="overlay" id="nsOverlay"><div class="modal" id="nsModal" style="width:440px"><div class="modal-head"><span class="t">'+(n.parent?'New subspace in '+esc(spaceName(n.parent)):'New top-level space')+'</span></div>'+
    '<div class="modal-body"><input class="title" id="nsName" placeholder="Space name…" value="'+esc(n.name)+'" autofocus>'+
    '<div class="field-label">Description (optional)</div><input class="metasel" id="nsDesc" placeholder="What lives here" style="margin-bottom:18px">'+
    '<div class="modal-foot"><button class="btn-ghost" id="nsCancel">Cancel</button><button class="btn-primary" id="nsCreate"'+(n.name.trim()?'':' disabled')+'>Create space</button></div></div></div></div>';
}
function bindNewSpace(){
  document.getElementById('nsOverlay').onclick=function(){state.newspace=null;render();};
  document.getElementById('nsModal').onclick=function(e){e.stopPropagation();};
  var nm=document.getElementById('nsName');nm.oninput=function(){state.newspace.name=nm.value;document.getElementById('nsCreate').disabled=!nm.value.trim();};nm.onkeydown=function(e){if(e.key==='Enter')submitNewSpace();};nm.focus();
  document.getElementById('nsCancel').onclick=function(){state.newspace=null;render();};
  document.getElementById('nsCreate').onclick=submitNewSpace;
}
async function submitNewSpace(){
  var n=state.newspace;if(!n||!n.name.trim())return;var desc=document.getElementById('nsDesc').value;
  try{var sp=await write('POST','/api/spaces',{name:n.name.trim(),parent_path:n.parent||'',description:desc||null});state.newspace=null;await refreshSpaces();if(n.parent)state.collapsed['open:'+n.parent]=true;openSpace(sp.path);toast('Space created');}
  catch(e){failWrite(e,submitNewSpace);}
}
function renderUnlock(){
  var p=state.unlock;
  return '<div class="overlay" id="unlockOverlay"><div class="modal" id="unlockModal" style="width:420px"><div class="modal-head"><span class="t">Unlock vault</span></div>'+
    '<div class="modal-body"><div style="font-size:13.5px;color:#7a8794;line-height:1.6;margin-bottom:18px">Enter your key once — this browser stays signed in.</div>'+
    '<input class="title mono" id="unlockKey" type="password" placeholder="API key" style="font-size:15px" value="'+esc(p.key)+'">'+
    (p.error?'<div class="field-label" style="color:#b4776f">'+esc(p.error)+'</div>':'')+
    '<div class="modal-foot"><button class="btn-ghost" id="cancelUnlock">Cancel</button><button class="btn-primary" id="submitUnlock">Unlock</button></div></div></div></div>';
}
function bindUnlock(){
  var input=document.getElementById('unlockKey');input.oninput=function(){state.unlock.key=input.value;};input.onkeydown=function(e){if(e.key==='Enter')submitUnlock();};input.focus();
  document.getElementById('unlockOverlay').onclick=function(){state.unlock=null;render();};
  document.getElementById('unlockModal').onclick=function(e){e.stopPropagation();};
  document.getElementById('cancelUnlock').onclick=function(){state.unlock=null;render();};
  document.getElementById('submitUnlock').onclick=submitUnlock;
}
async function submitUnlock(){
  var p=state.unlock;if(!p||!p.key.trim())return;
  try{var r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:p.key.trim()})});if(!r.ok)throw new Error('That key was not accepted.');state.authed=true;var retry=p.retry;state.unlock=null;render();if(retry)retry();}
  catch(e){p.error=e.message;render();}
}

/* overview editing (simple prompt-free inline via a page-like modal is overkill; use a textarea modal) */
async function editOverview(){
  var current=state.overview||'';
  var next=window.prompt('Space overview (markdown). Shown at the top of the space.',current);
  if(next===null)return;
  try{await write('PATCH','/api/space?path='+encodeURIComponent(state.space),{overview:next});state.overview=next;render();toast('Overview saved');}
  catch(e){failWrite(e,editOverview);}
}

/* events */
function bindShell(){
  document.querySelectorAll('[data-space]').forEach(function(el){el.onclick=function(){openSpace(el.dataset.space);};});
  document.querySelectorAll('[data-toggle]').forEach(function(el){el.onclick=function(e){e.stopPropagation();var p=el.dataset.toggle;state.collapsed['open:'+p]=!state.collapsed['open:'+p];renderTree();bindShell();};});
  document.querySelectorAll('[data-open]').forEach(function(el){el.onclick=function(){openPage(el.dataset.open);};});
  document.querySelectorAll('[data-newpage]').forEach(function(el){el.onclick=function(){state.capture={title:'',type:'idea',space:state.space||''};render();};});
  document.querySelectorAll('[data-newsub]').forEach(function(el){el.onclick=function(){state.newspace={name:'',parent:state.space||''};render();};});
  document.querySelectorAll('[data-editoverview]').forEach(function(el){el.onclick=editOverview;});
}
document.getElementById('brand').onclick=function(){openSpace('');};
document.getElementById('newSpaceBtn').onclick=function(){state.newspace={name:'',parent:''};render();};
document.getElementById('openCapture').onclick=function(){state.capture={title:'',type:'idea',space:state.space||''};render();};
document.getElementById('search').oninput=function(e){state.query=e.target.value;render();};
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){if(state.unlock){state.unlock=null;render();}else if(state.newspace){state.newspace=null;render();}else if(state.capture){state.capture=null;render();}else if(closeMenus()){}else if(state.view==='page'){openSpace(docSpace(state.doc));}}
  else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();document.getElementById('search').focus();}
});
window.addEventListener('focus',function(){if(state.loading||state.capture||state.newspace||state.unlock||state.view==='page')return;loadAll(true);});
loadAll();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
