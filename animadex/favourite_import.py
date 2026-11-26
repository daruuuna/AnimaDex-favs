"""Read a favourites list back in from an export file.

Understood on input -- and produced by ``/api/favourites/export`` -- are
two layouts:

CSV   a header row plus one row per entry. An entry is identified from
      its ``url`` column when there is one, falling back to the
      ``type``/``kind`` column plus ``slug``.

TXT   entries separated by blank lines, one of which carries a URL.

Either way the URL is the primary key for deciding *what* an entry is,
so one rule covers both files and both hosts:

    /c/<slug>                       -> a character
    /?mode=artists&artist=<slug>    -> an artist

The host is ignored, so a file exported from animadex.net and one
exported from your own install parse identically.

**Order matters.** Both the hosted site and this app export newest
first, so the importer hands out descending timestamps rather than
letting everything land on the same second. Without that, "Recently
Added" would collapse into alphabetical order and the list you carefully
built would come back shuffled.
"""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

from . import db

# Slug characters we never want to swallow: whitespace ends the match in a
# text file, a comma or double-quote ends it in a CSV row, '&' ends a query
# string and '#' a fragment. Everything else stays in, because real slugs
# carry parens ("saria_(zelda)"), apostrophes ("shin'yashiki") and colons
# ("2b_(nier:automata)"). Leaving the apostrophe out is a quiet data-loss
# bug: it truncates every one of those entries to "shin".
_SLUG = r"""[^\s,&"\\#]+"""

ARTIST_URL = re.compile(r'[?&]artist=(' + _SLUG + r')')
CHARACTER_URL = re.compile(r'/c/(' + _SLUG + r')')

# `type` / `kind` spellings from the hosted export and from our own.
KIND_BY_LABEL = {
    'character': 'characters', 'characters': 'characters',
    'artist': 'artists', 'artists': 'artists',
}

MAX_BYTES = 5 * 1024 * 1024      # a 196-entry export is ~18 KB; be generous


def classify_url(url: str) -> tuple[str | None, str | None]:
    """(kind, slug) from an export URL, or (None, None) if unrecognised.

    The slug comes back exactly as it is spelled in the file. Decoding is
    deferred to :func:`resolve_slug`, because the hosted site writes slugs
    raw -- so a slug that genuinely contains "%20" has to be matched as
    written before anything is unescaped.
    """
    if not url:
        return None, None
    m = ARTIST_URL.search(url)
    if m:
        return 'artists', m.group(1)
    m = CHARACTER_URL.search(url)
    if m:
        return 'characters', m.group(1)
    return None, None


def resolve_slug(conn, kind: str, slug: str) -> str | None:
    """The slug as written, its percent-decoded form, or None.

    Two spelling conventions have to work: the hosted site's raw one and
    this app's percent-encoded one (see ``images.entry_url``).
    """
    if slug in ('', None) or kind not in db.FAV_TABLES:
        return None
    if db.fav_entity_exists(conn, kind, slug):
        return slug
    decoded = unquote(slug)
    if decoded != slug and db.fav_entity_exists(conn, kind, decoded):
        return decoded
    return None


def _decode(raw: bytes | str) -> str:
    if isinstance(raw, str):
        text = raw
    else:
        text = raw.decode('utf-8-sig', errors='replace')   # drops a BOM
    return text.replace('\r\n', '\n').replace('\r', '\n')


def _looks_like_csv(text: str) -> bool:
    """A CSV is a comma-separated header naming at least one column we know."""
    for line in text.split('\n'):
        if not line.strip():
            continue
        cells = [c.strip().lower() for c in next(
            csv.reader([line], strict=False), [])]
        return bool({'url', 'slug', 'type', 'kind'} & set(cells))
    return False


def _entries_from_csv(text: str) -> list[tuple[str | None, str, str]]:
    reader = csv.DictReader(io.StringIO(text))
    fields = {(f or '').strip().lower(): f for f in (reader.fieldnames or [])}

    def col(row, *names):
        for n in names:
            src = fields.get(n)
            if src is not None and (row.get(src) or '').strip():
                return (row[src] or '').strip()
        return ''

    out = []
    for row in reader:
        if not any((v or '').strip() for v in row.values()):
            continue
        kind, slug = classify_url(col(row, 'url'))
        if kind is None:
            label = col(row, 'type', 'kind').lower()
            kind = KIND_BY_LABEL.get(label)
            slug = slug or col(row, 'slug')
        name = col(row, 'name')
        out.append((kind, slug, name))
    return out


def _entries_from_txt(text: str) -> list[tuple[str | None, str, str]]:
    out = []
    # Entries are separated by one or more blank lines.
    for block in re.split(r'\n[ \t]*\n', text):
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if not lines:
            continue
        kind, slug = None, None
        name = lines[0]
        url_line = next((ln for ln in lines
                         if '/c/' in ln or 'artist=' in ln), '')
        if url_line:
            kind, slug = classify_url(url_line)
        if kind is None:
            # No URL: a hand-written block may still label itself, e.g.
            # "Artist: Watanabe Akio" followed by the slug on its own line.
            label = re.match(r'(character|artist)s?\s*[:\-]\s*(.*)',
                             lines[0], re.I)
            if label and len(lines) > 1:
                kind = KIND_BY_LABEL.get(label.group(1).lower())
                slug = lines[1].strip()
                name = label.group(2).strip()
        out.append((kind, slug or '', name))
    return out


def detect_format(raw: bytes | str) -> str:
    """'csv' or 'txt' -- used only to tell the user what was recognised."""
    return 'csv' if _looks_like_csv(_decode(raw)) else 'txt'


def parse_export(raw: bytes | str) -> list[tuple[str | None, str, str]]:
    """Turn export file contents into (kind, slug, name) in file order.

    ``kind`` is None for anything we could not classify; the importer
    counts those rather than guessing.
    """
    text = _decode(raw)
    if not text.strip():
        return []
    if _looks_like_csv(text):
        return _entries_from_csv(text)
    return _entries_from_txt(text)


def import_entries(conn, entries, replace=False, now=None) -> dict:
    """Heart everything in `entries`, newest first.

    Timestamps step backwards one second per row from `now`, which is
    what preserves the export's ordering under the "Recently Added" sort.
    Entries whose slug is not in this install's catalogue are reported
    as `unknown` instead of being stored, so the list can never grow
    rows that render as blanks.
    """
    now = now or datetime.now(timezone.utc)
    summary = {'added': 0, 'existing': 0, 'duplicate': 0,
               'unknown': 0, 'unknown_slugs': [], 'total': 0}

    with conn:                          # one transaction for the whole import
        if replace:
            conn.execute('DELETE FROM favourites')

        seen = set()
        for offset, (kind, slug, _name) in enumerate(entries):
            if kind not in db.FAV_TABLES or not slug:
                summary['unknown'] += 1
                if len(summary['unknown_slugs']) < 10:
                    summary['unknown_slugs'].append(slug or 'unrecognised text')
                continue
            known = resolve_slug(conn, kind, slug)
            if known is None:
                summary['unknown'] += 1
                if len(summary['unknown_slugs']) < 10:
                    summary['unknown_slugs'].append(f'{slug} (not in catalogue)')
                continue
            key = (kind, known)
            if key in seen:
                summary['duplicate'] += 1
                continue
            seen.add(key)
            if db.is_favourite(conn, *key):
                summary['existing'] += 1
                continue
            stamp = (now - timedelta(seconds=offset)).strftime(
                '%Y-%m-%dT%H:%M:%S')
            conn.execute(
                'INSERT INTO favourites(kind, slug, created_at) '
                'VALUES(?, ?, ?)', (kind, known, stamp))
            summary['added'] += 1

        summary['total'] = conn.execute(
            'SELECT COUNT(*) FROM favourites').fetchone()[0]
    return summary
