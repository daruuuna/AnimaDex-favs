# Favourites

Heart the ♡ in the corner of any character or artist tile and it is
saved to this install, so you can keep a shortlist of the Anima entries
you actually use without bookmarks or an account.

## Using it

- **Heart a tile.** The button sits top-left on the thumbnail. It is
  hidden until you hover, stays visible once hearted, and is always
  visible on touch screens.
- **Open the list.** Click **♥ Favourites** in the top bar, between the
  search box and the sort control. It is an ordinary link
  (`/?mode=favourites`), so Ctrl/middle-click opens it in its own tab
  and the browser's back button works.
- **Un-heart from the list.** The tiles there carry hearts too, so you
  can prune without hunting the entry down again.
- **Filter by type.** The toolbar above the grid has two checkboxes,
  **Characters** and **Artists**, each showing how many you have. Tick
  one to see only that half of your list.
- **Back it up.** The same toolbar links to
  `/api/favourites/export?format=csv` (spreadsheet) and `?format=txt`
  (trigger words and prompt tags, one entry per block, ready to paste
  into a generator).
- **Import a list.** The **Import…** button in that toolbar takes a file
  in the same two formats — including the ones the hosted site exports —
  so a list built over there can be brought here. See
  [Importing a list](#importing-a-list).

## Filtering by type

A favourites list quickly mixes the two datasets, and they are usually
wanted separately: artists drive *who drew it*, characters drive *what*
*was drawn*. The two checkboxes narrow the list in place — no page
change, and the grid updates under your cursor.

The choice lives in the address bar as a `kind` parameter, exactly like
the search and filter controls elsewhere in the app:

| Ticked | Address bar | Shows |
| --- | --- | --- |
| both | *(nothing written)* | the whole list |
| Characters | `&kind=characters` | 62 of them, say |
| Artists | `&kind=artists` | the rest |
| neither | `&kind=` | nothing, with a note saying why |

Both ticked writes nothing so the common case keeps a clean URL, and
`kind=` with no value means "nothing" rather than "no filter" — which is
what makes an empty toolbar show an honest empty list instead of
silently falling back to everything.

Because it is a URL parameter, a filtered view can be bookmarked, pasted
into a chat, or reached with the back button. Leaving the favourites page
clears the filter, and coming back shows the whole list again.

Sort options on the favourites page are **Recently Added** (default),
**Image Count**, **A–Z** and **⚄ Random**. Search works as it does
elsewhere: comma-separated terms are AND-ed within one entry.

## How it differs from "likes"

The hosted site at animadex.net shows both. They are not the same thing:

| | What it is | Needs an account? |
| --- | --- | --- |
| **Favourites** (♥) | Your own bookmark list | No — this is what AnimaDex stores |
| **Times favourited** (♥ *n*) | How many site users favourited it, i.e. popularity | Yes |
| **Likes** (👍/👎) | A crowd vote on whether the AI render actually resembles the character | Yes |
| **Collections** (📁) | User-made folders | Yes |

AnimaDex implements only the first. The other three are per-account
data, and a self-hosted single-user install has nobody to compare with.

## Storage

One table in the same SQLite file as the catalogue — no second database,
no setup step:

```sql
CREATE TABLE favourites (
    kind       TEXT NOT NULL,     -- 'characters' | 'artists'
    slug       TEXT NOT NULL,
    created_at TEXT NOT NULL,     -- drives "Recently Added"
    PRIMARY KEY (kind, slug)
) WITHOUT ROWID;
```

`kind` is part of the key because characters and artists keep separate
slug spaces, so the same slug can legitimately appear twice — once per
dataset.

`schema.sql` is re-applied on every startup and every statement is
`CREATE ... IF NOT EXISTS`, so an existing install picks the table up
automatically on the next `./run.sh`. Nothing has to be migrated.

On startup, `app.py` also calls `db.prune_favourites()`, which deletes
favourites whose character or artist is no longer in the dataset. Without
it, re-importing a trimmed CSV would leave the list showing a count of
items it can no longer display.

## Importing a list

`Import…` opens a small panel under the toolbar. Choose a `.csv` or
`.txt` file, optionally tick **Replace my list**, and press Import. The
file can be one this install exported, one the hosted site exported, or
hand-edited between the two.

**Merge** (the default) keeps what you have and appends the rest, so an
import can never destroy work. **Replace** empties the table first —
that is the option for moving from one machine to another, because it
also brings the original *order* across, not just the membership.

Within a merge, everything already hearted is left exactly where it is
rather than bumped to the top, so re-running an import is safe and
changes nothing. Entries the file lists twice are counted once.

Anything in the file that is not in this catalogue is skipped and
reported — the panel says how many, and names the first ten in the
browser console. A file is never half-applied because of an unknown
name, since those names are usually just an entry this version of the
catalogue does not have.

The same importer is available on the command line, which is the way to
load a large list before the server has ever run:

```bash
.venv/bin/python -m animadex import-favourites ~/favs.csv --dry-run
.venv/bin/python -m animadex import-favourites ~/favs.csv
.venv/bin/python -m animadex import-favourites ~/favs.csv --replace
```

`--dry-run` reports the counts without writing, and prints the first ten
unrecognised names, so it doubles as a check on a hand-edited file.

> Not to be confused with [`import-from-site.md`](import-from-site.md),
> which loads the *catalogue* itself. This one only loads your shortlist.

## HTTP API

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/favourites` | Every favourited slug, split by kind, plus the total |
| `POST /api/favourites/toggle` | `{kind, slug}` → `{ok, favourited, total}` |
| `GET /api/favourites/export?format=csv\|txt` | Backup download |
| `POST /api/favourites/import` | `multipart/form-data` upload → counts |
| `GET /api/favourites/search` | The list as a gallery page (search, sort, `kind`, paging) |
| `GET /api/favourites/facets` | `{"total": n, "facets": {}}` — no facets by design |

`kind` must be `characters` or `artists`, and the slug has to exist in
that dataset, so a stale or hand-crafted request cannot accumulate junk
rows.

Two design notes:

- **The heart status is not part of `/api/<mode>/search`.** Those
  responses are cacheable and identical for everyone; folding a personal
  flag into them would force the whole catalogue API to `no-store`.
  Instead the browser loads `/api/favourites` once and stamps the tiles
  itself, before the first paint.
- **Favourites responses are `no-store`**, so a shared cache in front of
  the install can never serve your list to someone else.

## Code map

```
animadex/
  schema.sql              the favourites table
  db.py                   FAV_TABLES, toggle_favourite, search_favourites,
                          favourite_kinds, prune_favourites, list_favourites
  images.py               serialize_favourite, export URLs
  favourite_import.py     reading an exported list: parse_favourites_csv,
                          parse_favourites_txt, import_favourites
  routes/favourites.py    /api/favourites*, incl. the upload endpoint
  routes/api_gallery.py   'favourites' joins the other gallery datasets
  __main__.py             the import-favourites command
  static/app.js           favs set, favBtnHTML, toggleFavourite,
                          appendFavKinds, MODES.favourites, the top-bar
                          pill and the toolbar
  static/style.css        .tile-fav-btn, .fav-btn, .badge-kind, .favbar
  templates/index.html    the top-bar pill + the favourites toolbar
```

Because favourites are registered as a fourth gallery *mode* rather than
a separate page, they reuse the existing tile markup, lazy thumbnails,
pagination and search — a favourited tile looks and behaves exactly like
the tile you hearted.

## Round trip

Export and import are deliberately symmetric: both carry the same seven
fields (kind, name, slug, trigger words, copyright holder, image count,
when it was added) plus a link back to the entry, and the importer
recognises either layout whichever way the file was produced. So
`export → import` returns the list to the same state, including order,
and reports every entry as *already hearted* rather than duplicating it.

The importer also reads the hosted site's own exports, whose links are
absolute (`https://animadex.net/?mode=artists&artist=buriki`) rather than
relative, and whose text layout puts the URL on its own line. Slugs are
taken from the link's `artist=` or `char=` parameter — never from the
filename or the display name — because slugs contain `&`, `#`, `'`,
parentheses and the occasional literal `%20`.
