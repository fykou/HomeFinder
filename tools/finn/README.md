# finn-favorites

Turns the FINN.no favorite list into `boliger.html` at the repo root — a single
self-contained page for comparing apartments (table, cards, viewing calendar,
side-by-side compare, image carousel).

Two things on that page live in the browser, not in the file, and therefore
survive a regeneration but not a change of browser: the loan assumptions behind
the **Kr/mnd** column, and the per-apartment notes. The page's "Kopier notatene"
/ "Lim inn notater" buttons move notes between browsers — including between the
local file and the published artifact, which are separate origins.

## Setup, once

```bash
cd _tools/finn
npm install      # also downloads the Chromium build Playwright needs
npm run login    # sign in to FINN yourself; the session is kept in .browser-profile/
```

## Commands

```bash
npm run sync     # scrape the list + every ad, rewrite boliger.html
npm run login    # again whenever the session expires
```

Flags on `node finn-favorites.mjs`:

| Flag | Effect |
| --- | --- |
| `--login` | Opens a real Chrome window to sign in; the session is stored in `.browser-profile/` |
| `--list <id>` | Overrides `config.json`'s `listId` |
| `--shared <token,…>` | Shared lists (`/sharedfavoritelist/<token>`); a full pasted URL works too |
| `--ids a,b,c` | Skips the login step and scrapes exactly these ad ids |
| `--deactivated a,b` | Marks ids as deactivated (only needed with `--ids`) |
| `--headed` | Runs the list scrape with a visible browser, for debugging |
| `--json` | Prints the parsed ads to stdout instead of writing the page |

## Lists

`config.json` holds the user's own list (`listId`) and any number of shared
lists (`sharedLists`, the token from `/sharedfavoritelist/<token>`). Every list
is scraped in one browser session and merged by ad id, so an ad in two lists
appears once. **Shared lists need login as well** — they are not public.

## Why two steps

Only the favorite lists are behind login. Ad pages are public, so:

1. **Lists** — Playwright with a persistent profile loads each list page and
   reads the ad ids plus the `Deaktivert` badge. That badge exists **only** on
   the list page; nothing on the ad page distinguishes a withdrawn ad from a
   live one.
2. **Ads** — plain `fetch` (6 at a time, 3 tries each) against
   `finn.no/realestate/homes/ad.html?finnkode=<id>`. No browser, no auth.

There is no public JSON API for a favorite list; the page is server-rendered
Remix with no `_data` route exposed.

## Where the fields come from

| Source | Fields |
| --- | --- |
| `data-testid="pricing-*"` / `info-*` `<dt>/<dd>` pairs | prices, felleskostnader, eieform, etasje, soverom, areal, byggeår |
| Ad-targeting JSON blob (`{"key":"facilities","value":[…]}`) | facility list — the only structured **heis** signal |
| `og:` meta tags | title, teaser, image (swap `/dynamic/<n>w/` for any width) |
| `data-testid="viewings-N"` blocks | viewing date and time; the absolute start is read from the `.ics` link's `iCalendarFrom` stamp |

`heisNevntITekst` is a fallback: true when the ad text mentions a lift but the
facility is not tagged. The page shows those as `Heis?` rather than claiming
either way.

## When it breaks

- **`Not logged in. Run once with --login.`** — the stored session expired. Run
  `npm run login`.
- **Chrome profile is locked** — close any Chrome started from
  `.browser-profile/`, or delete the directory and log in again.
- **Empty list** — the run aborts rather than writing an empty page.
- **Markup changed** — run with `--json` and check which fields came back
  `null`; the `data-testid` names in `parseAd` are the things that move.
