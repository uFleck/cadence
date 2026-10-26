import re
from pathlib import Path

root = Path(__file__).parent

VARIANTS = [
    ("frontend-design", "Tuning Room", "frontend-design skill",
     "Dark, tuner dial and rising bars, serif rewrites"),
    ("ui-ux-pro-max", "Quiet Study", "ui-ux-pro-max skill",
     "Warm paper, ink and amber, soft editorial"),
    ("design-taste-frontend", "The Proof Desk", "design-taste-frontend skill",
     "Dark editor's desk, mint fixes, wavy amber flags"),
    ("unspecified", "Night Metronome", "no skill specified",
     "Calm dark ink, amber accent, serif hero rewrite"),
]


def parts(name):
    html = (root / f"{name}.html").read_text(encoding="utf-8")
    css = re.search(r"<style>(.*?)</style>", html, re.S).group(1)
    # drop the standalone page's unscoped body rule; the gallery shell centres instead
    css = re.sub(r"^\s*body\s*\{[^}]*\}\s*$", "", css, flags=re.M)
    body = re.search(r"<body[^>]*>(.*?)<script>", html, re.S).group(1)
    js = re.search(r"<script>(.*?)</script>", html, re.S).group(1)
    return css, body, js


SHELL_CSS = """
.gx-root{--gx-bg:#0e0f13;--gx-line:#2a2d38;--gx-text:#eceae4;--gx-muted:#9a9eae;--gx-accent:#f2b84b;
  font-family:"Segoe UI Variable","Segoe UI",system-ui,sans-serif;color:var(--gx-text);background:var(--gx-bg);min-height:100vh}
.gx-root *{box-sizing:border-box}
.gx-bar{position:sticky;top:0;z-index:50;display:flex;align-items:stretch;gap:8px;padding:10px 16px;background:#0e0f13f2;border-bottom:1px solid var(--gx-line)}
.gx-title{display:flex;flex-direction:column;justify-content:center;padding-right:16px;margin-right:4px;border-right:1px solid var(--gx-line)}
.gx-title b{font-size:14px;letter-spacing:.02em}
.gx-title span{font-size:11px;color:var(--gx-muted)}
.gx-tab{appearance:none;border:1px solid var(--gx-line);background:transparent;color:var(--gx-text);text-align:left;
  padding:7px 14px;border-radius:10px;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:1px;min-width:180px}
.gx-tab:hover{border-color:#4a4f60}
.gx-tab:focus-visible{outline:2px solid var(--gx-accent);outline-offset:2px}
.gx-tab[aria-selected="true"]{border-color:var(--gx-accent);background:#f2b84b14}
.gx-tab .n{font-size:13px;font-weight:600}
.gx-tab .n i{font-style:normal;color:var(--gx-accent);margin-right:6px;font-variant-numeric:tabular-nums}
.gx-tab .s{font-size:11px;color:var(--gx-muted)}
.gx-hint{margin-left:auto;align-self:center;font-size:11px;color:var(--gx-muted)}
.gx-stage{display:flex;justify-content:center;padding:24px 16px 40px;overflow:auto}
.gx-panel[hidden]{display:none}
.gx-note{max-width:1100px;margin:0 auto 12px;font-size:12px;color:var(--gx-muted);text-align:center}
"""

SHELL_JS = """
(function () {
  var root = document.querySelector('.gx-root');
  var tabs = Array.prototype.slice.call(root.querySelectorAll('.gx-tab'));
  var panels = Array.prototype.slice.call(root.querySelectorAll('.gx-panel'));
  var note = root.querySelector('.gx-note');
  function show(i) {
    tabs.forEach(function (t, j) { t.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
    panels.forEach(function (p, j) { p.hidden = j !== i; });
    note.textContent = tabs[i].getAttribute('data-note');
    try { history.replaceState(null, '', '#' + tabs[i].getAttribute('data-id')); } catch (e) {}
  }
  tabs.forEach(function (t, i) { t.addEventListener('click', function () { show(i); }); });
  document.addEventListener('keydown', function (e) {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= tabs.length) show(n - 1);
  });
  var start = 0;
  var h = location.hash.slice(1);
  tabs.forEach(function (t, i) { if (t.getAttribute('data-id') === h) start = i; });
  show(start);
})();
"""

css_all, tabs_html, panels_html, js_all = [], [], [], []
for i, (name, persona, how, blurb) in enumerate(VARIANTS):
    css, body, js = parts(name)
    css_all.append(f"/* ---- {name} ---- */{css}")
    tabs_html.append(
        f'<button class="gx-tab" role="tab" data-id="{name}" data-note="{persona}: {blurb}" aria-selected="false">'
        f'<span class="n"><i>{i + 1}</i>{persona}</span><span class="s">{how}</span></button>'
    )
    panels_html.append(f'<section class="gx-panel" data-id="{name}" hidden>{body}</section>')
    js_all.append(f"<script>\n/* ---- {name} ---- */\n{js}\n</script>")

# duplicate ids across variants would break getElementById-style lookups
ids = re.findall(r'\bid="([^"]+)"', "".join(panels_html))
dupes = sorted({x for x in ids if ids.count(x) > 1})
print("duplicate ids:", dupes or "none")

out = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cadence: design directions</title>
<style>
body{{margin:0;background:#0e0f13}}
{SHELL_CSS}
{"".join(css_all)}
</style>
</head>
<body>
<div class="gx-root">
  <header class="gx-bar">
    <div class="gx-title"><b>Cadence</b><span>Design directions</span></div>
    <nav role="tablist" style="display:flex;gap:8px">{"".join(tabs_html)}</nav>
    <span class="gx-hint">Keys 1-4 switch</span>
  </header>
  <main class="gx-stage"><div>
    <p class="gx-note"></p>
    {"".join(panels_html)}
  </div></main>
</div>
<script>
{SHELL_JS}
</script>
{"".join(js_all)}
</body>
</html>
"""
(root / "index.html").write_text(out, encoding="utf-8")
print("wrote", root / "index.html", len(out), "bytes")
