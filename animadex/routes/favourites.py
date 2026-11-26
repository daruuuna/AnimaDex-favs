"""Personal favourites: heart a character or artist, find it again later.

AnimaDex is single-user by design (self-hosted, LAN/Tailscale), so there
is no account table -- one list per install, stored in the same SQLite
file as the catalogue.

The gallery's own /api/<mode>/search responses are cacheable and carry
no per-user state, so the heart status is served separately from
/api/favourites and applied to the tiles in the browser.
"""

from __future__ import annotations

import csv
import io

from flask import (Blueprint, Response, abort, current_app, g, jsonify,
                   request)

from .. import db, favourite_import
from ..images import entry_url

favourites_bp = Blueprint('favourites', __name__)


def _no_store(resp):
    """Favourites are private to this install; don't let a shared cache
    hand them to anybody else."""
    resp.headers['Cache-Control'] = 'no-store'
    return resp


def _writable():
    """A read-write connection. The per-request g.db is opened with
    `PRAGMA query_only`, so writes get their own -- the same arrangement
    the contact form uses."""
    return db.connect_rw(current_app.config['ANIMADEX'].paths.database)


@favourites_bp.route('/api/favourites')
def api_favourites():
    """Every favourited slug, so the browser can stamp the tiles."""
    data = db.favourite_kinds(g.db)
    return _no_store(jsonify(
        characters=sorted(data['characters']),
        artists=sorted(data['artists']),
        total=db.count_favourites(g.db),
    ))


@favourites_bp.route('/api/favourites/toggle', methods=['POST'])
def api_favourite_toggle():
    data = request.get_json(silent=True) or {}
    kind = data.get('kind')
    slug = (data.get('slug') or '').strip()
    if kind not in db.FAV_TABLES:
        return jsonify(ok=False, error='Unknown kind.'), 400
    if not slug:
        return jsonify(ok=False, error='Missing slug.'), 400

    conn = _writable()
    try:
        with conn:
            if not db.fav_entity_exists(conn, kind, slug):
                return jsonify(ok=False, error='Not in the catalogue.'), 404
            on = db.toggle_favourite(conn, kind, slug)
            total = db.count_favourites(conn)
    finally:
        conn.close()
    return _no_store(jsonify(ok=True, favourited=on, kind=kind, slug=slug,
                             total=total))


# ---- backup download --------------------------------------------------

KIND_LABELS = {'characters': 'Character', 'artists': 'Artist'}
# `url` is last so an existing spreadsheet keeps its column order, and it
# is what lets a downloaded file be fed straight back to /import.
EXPORT_COLUMNS = ('kind', 'name', 'slug', 'trigger', 'copyright',
                  'count', 'added_at', 'url')


def _export_rows(conn):
    for r in db.list_favourites(conn):
        yield {
            'kind':      KIND_LABELS.get(r['kind'], r['kind']),
            'name':      r['name'],
            'slug':      r['slug'],
            'trigger':   r['trigger'],
            'copyright': r['copyright'],
            'count':     r['count'],
            'added_at':  r['fav_created'],
            'url':       entry_url(r['kind'], r['slug']),
        }


def _export_csv(conn):
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=EXPORT_COLUMNS,
                            extrasaction='ignore')
    writer.writeheader()
    for row in _export_rows(conn):
        writer.writerow(row)
    return buf.getvalue()


def _export_text(conn):
    """One entry per block: the trigger plus its prompt tags, ready to
    paste straight into a generator, with the URL that identifies the
    entry so the file can be imported back."""
    out = []
    for r in db.list_favourites(conn):
        tags = ', '.join(t.strip()
                         for t in (r['core_tags'] or '').split(',')
                         if t.strip())
        out.append(f'{KIND_LABELS.get(r["kind"], r["kind"])}: {r["name"]}\n'
                   f'{r["trigger"]}' + (f'\n{tags}' if tags else '') +
                   f'\nURL: {entry_url(r["kind"], r["slug"])}\n')
    return '\n'.join(out)


@favourites_bp.route('/api/favourites/import', methods=['POST'])
def api_favourites_import():
    """Heart everything in an exported favourites file.

    Accepts the hosted site's `animadex-favourites.csv` /
    `.txt` as well as this app's own downloads, in either direction.
    """
    upload = request.files.get('file')
    if upload is None or not (upload.filename or '').strip():
        return jsonify(ok=False,
                       error='Choose a .csv or .txt file to import.'), 400

    raw = upload.read()
    if len(raw) > favourite_import.MAX_BYTES:
        return jsonify(ok=False, error='That file is too large.'), 413

    entries = favourite_import.parse_export(raw)
    if not entries:
        return jsonify(ok=False,
                       error='No favourites found in that file.'), 400

    replace = (request.form.get('mode') or '').strip().lower() == 'replace'
    conn = _writable()
    try:
        summary = favourite_import.import_entries(conn, entries,
                                                  replace=replace)
    finally:
        conn.close()

    summary['filename'] = upload.filename
    summary['format'] = favourite_import.detect_format(raw)
    return _no_store(jsonify(ok=True, **summary))


@favourites_bp.route('/api/favourites/export')
def api_favourites_export():
    fmt = (request.args.get('format') or 'csv').strip().lower()
    # bare mimetypes -- Flask appends `; charset=utf-8` itself, and
    # saying it twice here would put it in the header twice.
    body, mime, ext = {
        'csv': (_export_csv,  'text/csv',   'csv'),
        'txt': (_export_text, 'text/plain', 'txt'),
    }.get(fmt, (None, None, None))
    if body is None:
        abort(400, description='format must be csv or txt')

    text = body(g.db)           # a read is fine on the shared read-only conn

    resp = Response(text, mimetype=mime)
    resp.headers['Content-Disposition'] = \
        f'attachment; filename="animadex-favourites.{ext}"'
    return _no_store(resp)
