#!/usr/bin/env python3
"""Crea dist/solco.html: tutta l'app in un unico file (per provarla in un browser senza installare nulla)."""
import base64, re, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / 'web'
html = (WEB / 'index.html').read_text(encoding='utf-8')

css = (WEB / 'css/app.css').read_text(encoding='utf-8')
def font_uri(m):
    data = (WEB / 'fonts' / m.group(1)).read_bytes()
    return "url('data:font/woff;base64," + base64.b64encode(data).decode() + "')"
css = re.sub(r"url\('\.\./fonts/([^']+)'\)", font_uri, css)
html = html.replace('<link rel="stylesheet" href="css/app.css">', '<style>\n' + css + '\n</style>')
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', '')
icon = base64.b64encode((WEB / 'icons/icon-192.png').read_bytes()).decode()
html = html.replace('<link rel="icon" href="icons/icon-192.png">', '<link rel="icon" href="data:image/png;base64,' + icon + '">')

def js(name):
    s = (WEB / 'js' / name).read_text(encoding='utf-8')
    assert '</script' not in s.lower(), name
    return s

raw = ('<script type="text/plain" id="src-worklet">\n' + js('worklet.js') + '\n</script>\n'
       '<script type="text/plain" id="src-analysis">\n' + js('analysis.js') + '\n</script>\n')
def inline(m):
    return '<script>\n' + js(m.group(1)) + '\n</script>'
html = re.sub(r'<script src="js/([a-z]+\.js)"></script>', inline, html)
html = html.replace('<script>\n' + js('worklet.js'), raw + '<script>\n' + js('worklet.js'), 1)
out = ROOT / 'dist' / 'solco.html'
out.write_text(html, encoding='utf-8')
print(out, round(out.stat().st_size / 1024), 'KB')
