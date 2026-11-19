#!/usr/bin/env python3
"""Split the whole-site CJK font into WOFF2 slices selected by unicode-range.

The browser downloads only the slices a page's text needs, so a page no longer pulls the 4.7 MB TTF.
Slices (disjoint, together covering every glyph in the font, so nothing is lost):
  ui      Latin, punctuation and every non-ASCII character used in src/ and index.html
  common  Big5 level 1 (the 5,401 most common Traditional Chinese characters)
  rest-N  every other glyph in the font, chunked by code point

It also converts the storybook's Latin accent font (Patrick Hand) to a Latin-only WOFF2.

Every output name carries an 8-hex content hash (e.g. jf-openhuninn-ui-1a2b3c4d.woff2), so server/http.js can
cache fonts for a year as immutable: a changed font gets a new URL.

Requires: pip install fonttools brotli
Usage:    python scripts/subset-fonts.py
Writes assets/fonts/jf-openhuninn-*.woff2 and assets/storybook/fonts/PatrickHand-*.woff2, and rewrites line 1 of
src/styles.css and src/storybook-host.css (their @font-face blocks).
"""
import hashlib, pathlib, sys
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_FONT = ROOT / 'fonts-src/jf-openhuninn-2.1.ttf'
SRC_ACCENT = ROOT / 'fonts-src/PatrickHand-Regular.ttf'
OUT = ROOT / 'assets/fonts'
ACCENT_OUT = ROOT / 'assets/storybook/fonts'
FAMILY = 'jf open \u7c89\u5713'
REST_CHUNK = 2500

font = TTFont(SRC_FONT)
available = set(font.getBestCmap())
font.close()

def used_chars():
    chars = set()
    files = list((ROOT / 'src').rglob('*.*')) + [ROOT / 'index.html']
    for f in files:
        if f.suffix.lower() not in {'.js', '.css', '.html', '.json', '.svg', '.mjs'}:
            continue
        try:
            chars.update(ord(c) for c in f.read_text(encoding='utf-8'))
        except (UnicodeDecodeError, OSError):
            pass
    return chars

def big5_level1():
    out = set()
    for lead in range(0xA4, 0xC7):
        for trail in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            if lead == 0xC6 and trail > 0x7E:
                continue
            try:
                s = bytes([lead, trail]).decode('big5')
            except UnicodeDecodeError:
                continue
            if len(s) == 1:
                out.add(ord(s))
    return out

ui = {c for c in range(0x20, 0x2FF + 1)} | {c for c in range(0x2000, 0x206F + 1)}
ui |= {c for c in used_chars() if c > 0x7F}
ui = {c for c in ui if c in available} - {0xFEFF}
common = (big5_level1() & available) - ui
rest = sorted(available - ui - common - {c for c in range(0, 0x20)})

slices = [('ui', sorted(ui)), ('common', sorted(common))]
for i in range(0, len(rest), REST_CHUNK):
    slices.append((f'rest-{i // REST_CHUNK + 1}', rest[i:i + REST_CHUNK]))

def ranges(cps):
    cps = sorted(cps); out = []; start = prev = cps[0]
    for c in cps[1:]:
        if c == prev + 1:
            prev = c; continue
        out.append((start, prev)); start = prev = c
    out.append((start, prev))
    return ','.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in out)

def build(src, cps, out_dir, stem):
    """Subset src to cps, save as WOFF2 named <stem>-<hash8>.woff2 and return the file name."""
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']
    opts.hinting = False
    opts.notdef_outline = True
    opts.name_IDs = ['*']
    opts.glyph_names = False
    f = subset.load_font(str(src), opts)
    s = subset.Subsetter(opts)
    s.populate(unicodes=cps)
    s.subset(f)
    tmp = out_dir / f'{stem}.tmp.woff2'
    subset.save_font(f, str(tmp), opts)
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()[:8]
    target = out_dir / f'{stem}-{digest}.woff2'
    tmp.replace(target)
    print(f'{target.name}: {len(cps)} chars, {target.stat().st_size / 1024:.0f} KB')
    return target.name

def rewrite_line1(path, css):
    lines = path.read_text(encoding='utf-8').split('\n')
    if not lines[0].startswith('@font-face'):
        sys.exit(f'{path} line 1 is not the @font-face block; refusing to overwrite')
    # Line 1 holds only the font-face rules (possibly several slices on a re-run); replace it with the new block.
    lines[0] = ''.join(css)
    path.write_text('\n'.join(lines), encoding='utf-8', newline='')

for old in list(OUT.glob('jf-openhuninn-*.woff2')) + list(ACCENT_OUT.glob('PatrickHand-*.woff2')):
    old.unlink()

css = []
for name, cps in slices:
    file = build(SRC_FONT, cps, OUT, f'jf-openhuninn-{name}')
    css.append(
        f'@font-face{{font-family:"{FAMILY}";src:url("./assets/fonts/{file}") format("woff2");'
        f'font-weight:400;font-style:normal;font-display:swap;unicode-range:{ranges(cps)}}}')
rewrite_line1(ROOT / 'src/styles.css', css)
print(f'Total woff2: {sum(p.stat().st_size for p in OUT.glob("jf-openhuninn-*.woff2")) / 1024:.0f} KB')

# Patrick Hand: Latin, Latin Extended, combining marks and general punctuation. Other characters fall back to the
# next font in each font-family list (jf open 粉圓 or sans-serif).
accent_font = TTFont(SRC_ACCENT)
accent_available = set(accent_font.getBestCmap())
accent_font.close()
accent = sorted(c for c in accent_available
                if 0x20 <= c <= 0x24F or 0x300 <= c <= 0x36F or 0x2000 <= c <= 0x206F or c in (0x20AC, 0x2122))
accent_file = build(SRC_ACCENT, accent, ACCENT_OUT, 'PatrickHand')
rewrite_line1(ROOT / 'src/storybook-host.css', [
    f"@font-face{{font-family:'Patrick Hand';src:url('/assets/storybook/fonts/{accent_file}') format('woff2');"
    f"font-display:swap;unicode-range:{ranges(accent)}}}"])
