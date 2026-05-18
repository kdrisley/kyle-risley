# Removed feature: catalog price filter (min/max)

A min/max price filter for `search_catalog` was added and then removed on
2026-05-18. Removed because real stores ignore it server-side — Glossier's
`/api/mcp` endpoint accepted a spec-correct `filters.price` argument and
returned out-of-range products anyway, so the UI looked broken even though
the request was valid.

The request shape itself is correct per the UCP spec and Shopify's
`search_catalog` docs — keep this if reinstating.

## What it sent

`catalog.filters.price` with `min`/`max` as integers in ISO 4217 **minor
units** (cents). The UI took major-unit input (e.g. `18`) and multiplied by
100. This assumes a 2-decimal currency — correct for USD/EUR/GBP, wrong for
JPY (0 decimals) / KWD (3). No `context.currency` was sent; the store uses
its default. Example body:

```json
"catalog": {
  "query": "eye shadow",
  "pagination": { "limit": 10 },
  "filters": { "price": { "min": 1800, "max": 1900 } }
}
```

## How to reinstate

All changes were in `explore.js` and `index.html`; no test files were
touched (the suite never asserted on the `search_catalog` request body).

1. **`explore.js` — catalog panel markup** (in the `hasSearch` panel, after
   the `.query-row` div): add a `.filter-row` with two
   `<input type="number" id="price-min|price-max" min="0" step="0.01">`
   fields and a `<span class="filter-hint" id="price-hint">`.

2. **`explore.js` — Enter-key wiring**: extend the `search-input` keydown
   listener to also cover `price-min` and `price-max` (loop over the three
   ids, call `searchCatalog()` on Enter).

3. **`explore.js` — `searchCatalog()`**: build a `catalog` object; read
   `price-min`/`price-max`, `parseFloat` them, and when `>= 0` set
   `priceFilter.min/max = Math.round(val * 100)`. Attach
   `catalog.filters = { price: priceFilter }` only when a bound is set.

4. **`explore.js` — `extractProducts()`**: also return a `currency` field
   per product (from `price_range.currency` or `price.currencyCode`) so the
   hint can show "Price range in USD" after a search.

5. **`index.html` — CSS**: add `.filter-row` (flex, gap 8px, margin-top 8px),
   `.filter-row input` (width 130px, 2px border, focus ring matching
   `.query-row input`), and `.filter-hint` (13px, `--text-tertiary`). In the
   mobile media query, make `.filter-row` wrap and inputs `flex: 1`.

See commit b27703b for the full original diff
(`git show b27703b`).

## If reinstating, also consider

The core problem was stores silently ignoring the filter. Worth pairing the
reinstatement with a client-side mismatch warning: if any returned product
falls outside the requested range, show a note that the store may not
support server-side price filtering — rather than client-side filtering the
results, which would misrepresent what the server returned.
