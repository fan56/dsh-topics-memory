/**
 * Bundle relationship graph visualization (ADR 0005 graph-shaped bundle).
 *
 * `buildGraph` turns the roster into nodes + edges (`depends` + body links);
 * `renderGraphHtml` emits a fully self-contained HTML page — hand-rolled
 * force-directed SVG, zero external scripts, works offline in any browser.
 * The graph JSON is embedded as `application/json` with `<` escaped so a
 * topic title can never break out of the script tag.
 *
 * @module viz
 */

import type { RetrievableTopic } from './retrieval.ts'
import { unwrapTopicRef } from './okf.ts'

export interface VizNode {
  id: string
  title: string
  status: string
  tags: string[]
  degree: number
}

export interface VizEdge {
  from: string
  to: string
  via: 'depends' | 'link'
}

export interface VizGraph {
  nodes: VizNode[]
  edges: VizEdge[]
}

/** Build the relationship graph: depends edges + body-link edges, no self-loops. */
export function buildGraph(roster: readonly RetrievableTopic[]): VizGraph {
  const bySlug = new Set(roster.map((r) => r.slug))
  const degree = new Map<string, number>()
  const bump = (slug: string): void => {
    degree.set(slug, (degree.get(slug) ?? 0) + 1)
  }
  const edges: VizEdge[] = []
  const seen = new Set<string>()
  const addEdge = (from: string, to: string, via: 'depends' | 'link'): void => {
    if (from === to || !bySlug.has(to)) return
    const key = `${from}->${to}:${via}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, via })
    bump(from)
    bump(to)
  }
  for (const topic of roster) {
    for (const dep of topic.depends) {
      // unwrapTopicRef, not a single strip: pre-repair bundles can carry
      // multi-wrapped depends entries, which would render a dead node here.
      const target = unwrapTopicRef(dep)
      addEdge(topic.slug, target, 'depends')
    }
    for (const link of topic.links ?? []) addEdge(topic.slug, link, 'link')
  }
  const nodes: VizNode[] = roster.map((r) => ({
    id: r.slug,
    title: r.title,
    status: r.status,
    tags: r.tags,
    degree: degree.get(r.slug) ?? 0,
  }))
  return { nodes, edges }
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Embed JSON safely inside a <script> tag. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-topics-memory 关系图</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #101418; color: #d7dee6; font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; overflow: hidden; }
  #bar { position: fixed; top: 0; left: 0; right: 0; z-index: 5; display: flex; gap: 14px; align-items: center; padding: 10px 16px; background: rgba(16,20,24,.92); border-bottom: 1px solid #232b33; flex-wrap: wrap; }
  #bar h1 { font-size: 14px; font-weight: 600; color: #8ec7ff; margin-right: 6px; }
  #bar input, #bar select { background: #1a2129; color: #d7dee6; border: 1px solid #2c3742; border-radius: 6px; padding: 4px 10px; font-size: 13px; }
  #bar input { width: 200px; }
  .legend { display: flex; gap: 10px; font-size: 12px; color: #8a97a3; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; }
  #meta { color: #66737f; font-size: 12px; }
  svg { display: block; width: 100vw; height: 100vh; cursor: grab; }
  svg.dragging { cursor: grabbing; }
  line.edge { stroke: #3a4652; stroke-opacity: .55; }
  line.edge.via-link { stroke-dasharray: 5 4; }
  line.edge.hot { stroke: #f5a623; stroke-opacity: .95; }
  line.edge.dim { stroke-opacity: .08; }
  g.node circle { stroke: #101418; stroke-width: 1.5; cursor: pointer; }
  g.node text { fill: #aeb9c4; font-size: 11px; text-anchor: middle; pointer-events: none; paint-order: stroke; stroke: #101418; stroke-width: 3px; }
  g.node.hot circle { stroke: #f5a623; stroke-width: 2.5; }
  g.node.hot text { fill: #ffd27a; }
  g.node.dim { opacity: .12; }
  #tip { position: fixed; z-index: 9; display: none; max-width: 340px; background: #1c242d; border: 1px solid #33404c; border-radius: 8px; padding: 10px 12px; pointer-events: none; box-shadow: 0 6px 24px rgba(0,0,0,.5); }
  #tip b { color: #8ec7ff; }
  #tip .s { color: #9aa7b3; font-size: 12px; }
  #tip .c { color: #c4cdd6; font-size: 12px; margin-top: 4px; white-space: pre-wrap; }
  #tip .tags { color: #6f8fae; font-size: 11px; margin-top: 4px; }
</style>
</head>
<body>
<div id="bar">
  <h1>dsh-topics-memory 关系图</h1>
  <input id="q" type="search" placeholder="搜索标题 / slug…">
  <select id="tag"><option value="">全部标签</option></select>
  <div class="legend">
    <span><i style="background:#4caf7d"></i>stable</span>
    <span><i style="background:#e0a63f"></i>draft</span>
    <span><i style="background:#6b7682"></i>deprecated</span>
    <span style="color:#66737f">实线=depends · 虚线=正文链接 · 拖拽节点 · 悬停看详情</span>
  </div>
  <span id="meta"></span>
</div>
<svg id="view"></svg>
<div id="tip"></div>
<script type="application/json" id="graph-data">__GRAPH_JSON__</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('graph-data').textContent);
  var svg = document.getElementById('view');
  var NS = 'http://www.w3.org/2000/svg';
  var W = window.innerWidth, H = window.innerHeight;
  var nodes = data.nodes.map(function (n, i) {
    var a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    return { id: n.id, title: n.title, status: n.status, tags: n.tags, degree: n.degree,
             x: W / 2 + Math.cos(a) * Math.min(W, H) * 0.32, y: H / 2 + Math.sin(a) * Math.min(W, H) * 0.32,
             vx: 0, vy: 0, el: null };
  });
  var byId = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  var edges = data.edges.filter(function (e) { return byId[e.from] && byId[e.to]; });

  var STATUS_FILL = { stable: '#4caf7d', draft: '#e0a63f', deprecated: '#6b7682' };

  var defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = '<marker id="arrow" viewBox="0 0 8 8" refX="14" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#3a4652"/></marker>';
  svg.appendChild(defs);

  var edgeEls = edges.map(function (e) {
    var l = document.createElementNS(NS, 'line');
    l.setAttribute('class', 'edge' + (e.via === 'link' ? ' via-link' : ''));
    if (e.via === 'depends') l.setAttribute('marker-end', 'url(#arrow)');
    l.dataset.from = e.from; l.dataset.to = e.to;
    svg.appendChild(l);
    return l;
  });
  var nodeEls = nodes.map(function (n) {
    var g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'node');
    var r = 6 + Math.min(10, n.degree * 2);
    var c = document.createElementNS(NS, 'circle');
    c.setAttribute('r', r);
    c.setAttribute('fill', STATUS_FILL[n.status] || '#4a90d9');
    var t = document.createElementNS(NS, 'text');
    t.setAttribute('y', r + 13);
    t.textContent = n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title;
    g.appendChild(c); g.appendChild(t);
    n.el = g; n.circle = c;
    g.dataset.id = n.id;
    svg.appendChild(g);
    return g;
  });
  document.getElementById('meta').textContent = nodes.length + ' 节点 · ' + edges.length + ' 边';

  var tagSel = document.getElementById('tag');
  var tagSet = {};
  nodes.forEach(function (n) { n.tags.forEach(function (t) { tagSet[t] = 1; }); });
  Object.keys(tagSet).sort().forEach(function (t) {
    var o = document.createElement('option'); o.value = t; o.textContent = '#' + t; tagSel.appendChild(o);
  });

  // force simulation: charge repulsion + edge springs + gentle centering
  var alpha = 1;
  function tick() {
    var i, j, a, b, dx, dy, d2;
    for (i = 0; i < nodes.length; i++) {
      for (j = i + 1; j < nodes.length; j++) {
        a = nodes[i]; b = nodes[j];
        dx = a.x - b.x; dy = a.y - b.y;
        d2 = dx * dx + dy * dy + 0.01;
        var f = 2600 / d2 * alpha;
        var d = Math.sqrt(d2);
        a.vx += dx / d * f; a.vy += dy / d * f;
        b.vx -= dx / d * f; b.vy -= dy / d * f;
      }
    }
    edges.forEach(function (e) {
      a = byId[e.from]; b = byId[e.to];
      dx = b.x - a.x; dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 1;
      var want = 130;
      var k = (d - want) * 0.012 * alpha;
      a.vx += dx / d * k * d * 0.01; a.vy += dy / d * k * d * 0.01;
      b.vx -= dx / d * k * d * 0.01; b.vy -= dy / d * k * d * 0.01;
    });
    nodes.forEach(function (n) {
      n.vx += (W / 2 - n.x) * 0.0015 * alpha;
      n.vy += (H / 2 - n.y) * 0.0015 * alpha;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += Math.max(-14, Math.min(14, n.vx));
      n.y += Math.max(-14, Math.min(14, n.vy));
      n.x = Math.max(24, Math.min(W - 24, n.x));
      n.y = Math.max(52, Math.min(H - 30, n.y));
    });
    alpha *= 0.995;
  }
  function draw() {
    edges.forEach(function (e, i) {
      var a = byId[e.from], b = byId[e.to], l = edgeEls[i];
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.y);
      l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
    });
    nodes.forEach(function (n) { n.el.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')'); });
  }
  (function loop() { if (alpha > 0.02) { tick(); } draw(); requestAnimationFrame(loop); })();

  // pan + drag
  var viewBox = { x: 0, y: 0, w: W, h: H };
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var dragNode = null, panning = false, px = 0, py = 0;
  svg.addEventListener('pointerdown', function (ev) {
    var g = ev.target.closest ? ev.target.closest('g.node') : null;
    if (g) {
      dragNode = byId[g.dataset.id];
      svg.classList.add('dragging');
    } else { panning = true; px = ev.clientX; py = ev.clientY; svg.classList.add('dragging'); }
  });
  window.addEventListener('pointermove', function (ev) {
    if (dragNode) {
      dragNode.x = viewBox.x + ev.clientX / viewBox.w * W;
      dragNode.y = viewBox.y + ev.clientY / viewBox.h * H;
      dragNode.vx = dragNode.vy = 0; draw(); return;
    }
    if (panning) {
      viewBox.x -= (ev.clientX - px) * viewBox.w / W;
      viewBox.y -= (ev.clientY - py) * viewBox.h / H;
      px = ev.clientX; py = ev.clientY;
      svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
    }
  });
  window.addEventListener('pointerup', function () { dragNode = null; panning = false; svg.classList.remove('dragging'); });
  svg.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var k = ev.deltaY > 0 ? 1.1 : 0.9;
    viewBox.w *= k; viewBox.h *= k;
    svg.setAttribute('viewBox', viewBox.x + ' ' + viewBox.y + ' ' + viewBox.w + ' ' + viewBox.h);
  }, { passive: false });

  // hover: highlight neighbors + tooltip (pointermove — synthetic and real
  // pointers both dispatch it; pointerover alone misses programmatic moves)
  var tip = document.getElementById('tip');
  var hotId = null;
  function setHot(id) {
    var hot = {};
    if (id) {
      hot[id] = 1;
      edges.forEach(function (e) {
        if (e.from === id) hot[e.to] = 1;
        if (e.to === id) hot[e.from] = 1;
      });
    }
    edges.forEach(function (e, i) {
      var on = id && (e.from === id || e.to === id);
      edgeEls[i].classList.toggle('hot', !!on);
    });
    nodeEls.forEach(function (g) { g.classList.toggle('hot', id ? !!hot[g.dataset.id] : false); });
  }
  svg.addEventListener('pointermove', function (ev) {
    var g = ev.target && ev.target.closest ? ev.target.closest('g.node') : null;
    if (!g) {
      if (hotId !== null) { setHot(null); tip.style.display = 'none'; hotId = null; }
      return;
    }
    if (g.dataset.id === hotId) return; // already showing this node
    hotId = g.dataset.id;
    var n = byId[hotId];
    setHot(n.id);
    var conclusion = n.conclusion || '';
    tip.innerHTML = '<b>' + n.title.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</b>' +
      '<div class="s">' + n.id + ' · ' + n.status + '</div>' +
      (conclusion ? '<div class="c">' + conclusion.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 260) + '</div>' : '') +
      (n.tags.length ? '<div class="tags">#' + n.tags.join(' #') + '</div>' : '');
    tip.style.display = 'block';
    tip.style.left = Math.min(window.innerWidth - 360, ev.clientX + 16) + 'px';
    tip.style.top = (ev.clientY + 12) + 'px';
  });
  svg.addEventListener('pointerleave', function () { setHot(null); tip.style.display = 'none'; hotId = null; });

  // search + tag filter → dim non-matches
  function applyFilter() {
    var q = document.getElementById('q').value.trim().toLowerCase();
    var tag = tagSel.value;
    nodeEls.forEach(function (g) {
      var n = byId[g.dataset.id];
      var okQ = !q || n.title.toLowerCase().indexOf(q) >= 0 || n.id.indexOf(q) >= 0;
      var okT = !tag || n.tags.indexOf(tag) >= 0;
      g.classList.toggle('dim', !okQ || !okT);
    });
    var any = !q && !tag;
    edges.forEach(function (e, i) {
      if (any) { edgeEls[i].classList.remove('dim'); return; }
      var a = byId[e.from], b = byId[e.to];
      var okQ = !q || [a, b].some(function (n) { return n.title.toLowerCase().indexOf(q) >= 0 || n.id.indexOf(q) >= 0; });
      var okT = !tag || [a, b].some(function (n) { return n.tags.indexOf(tag) >= 0; });
      edgeEls[i].classList.toggle('dim', !(okQ && okT));
    });
  }
  document.getElementById('q').addEventListener('input', applyFilter);
  tagSel.addEventListener('change', applyFilter);
})();
</script>
</body>
</html>
`

export function renderGraphHtml(graph: VizGraph, opts: { conclusions?: Record<string, string> } = {}): string {
  // Tooltip conclusions ride on the nodes (kept out of VizGraph for typing
  // clarity at the command layer).
  const nodes = graph.nodes.map((n) => ({ ...n, conclusion: opts.conclusions?.[n.id] ?? '' }))
  return PAGE.replace('__GRAPH_JSON__', embedJson({ nodes, edges: graph.edges }))
}
