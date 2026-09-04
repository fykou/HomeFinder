# HomeFinder

Apartment hunt in Oslo. FINN favorite lists are the source of truth; this repo
turns them into one browsable comparison page.

**Live page:** https://fykou.github.io/HomeFinder/

## What the page does

| View | For |
| --- | --- |
| Tabell | Sort on any column; kr/m² bars show value against the cheapest and dearest in the list |
| Kort | Photo grid |
| Visninger | Open houses by day, with clashing times flagged |
| Kart | All flats plotted from their real coordinates, with distance rings from any one of them |

Pick two or more with the checkboxes to compare side by side. Click anything to
open the detail panel: full image gallery, cost breakdown, facilities, map, and
a free-text note.

**Kr/mnd** is an annuity on `totalpris − fellesgjeld` (the cash purchase) minus
your equity, plus felleskostnader. Fellesgjeld is excluded from the loan because
the borettslag repays it through the felleskostnader — counting it twice would
make andel look worse than it is. That is what makes andel and selveier
comparable.

Loan assumptions and notes are stored in your browser, not in the page, so
regenerating never destroys them. They are also per-origin: notes written on
the GitHub Pages site are not the same as notes written on a local copy. The
buttons under the table copy them between the two.

## Updating

Add or remove favorites on FINN, then:

```bash
cd tools/finn
npm install      # first time only; also fetches the browser Playwright needs
npm run login    # first time, or when the session expires
npm run sync     # rewrites index.html
git commit -am "chore: refresh listings" && git push
```

GitHub Pages serves `index.html` from the default branch, so a push is the
deploy.

A new list — your own (`/favoritelist?favListId=…`) or one shared with you
(`/sharedfavoritelist/<token>`) — goes into `listId` / `sharedLists` in
[tools/finn/config.json](tools/finn/config.json). Both kinds need a login;
neither is public.

Details of how the scraping works, and what breaks it, are in
[tools/finn/README.md](tools/finn/README.md).
