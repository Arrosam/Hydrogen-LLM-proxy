# Log export — requirements

> Status: drafted 2026-09-06, awaiting sign-off. Targets **v2.0.0b**.
> Independent of `server-side-tools.md`; they share only the release.

## Problem

Diagnosing a bad answer means reading the full request, the translated upstream
request, and the response. Today that is one row at a time in the Logs detail
panel: `GET /admin/api/logs` returns summaries only, and payloads come from
`/logs/:id` singly. There is no way to hand an agent a corpus — "every 429 from
this key last Tuesday", or "these six requests that all went wrong the same way".

The existing filters are also thinner than the data. `LogQuery`
(`persistence/requestLogRepo.ts:43`) covers `tokenId`, `serviceId`, `status`,
`errorsOnly`, `from`, `to`; the UI wires up only three of those. There is no
filter on the model that actually served the request, and no search on error text
— which are the two things you reach for first when something is wrong.

## Behavior

1. **Export produces one JSON file, downloaded by the browser.** No new
   server-side API surface for pulling conversations out; the export rides the
   existing admin session, exactly like every other log read. Admin-only, same
   as `/logs`.

2. **Two ways to choose what goes in, and they are exclusive:**
   - **By filter** — everything matching the current Logs filters.
   - **By selection** — rows the operator hand-picked with per-row checkboxes in
     the list. The button states which one it will do and how many rows.

3. **Full payloads are included**: request body, translated upstream body,
   response body, attempt path, usage, timings, error. This is the point of the
   feature — a metadata-only dump cannot diagnose a wrong answer.

4. **New filters, all also usable by the export:**
   - time span (`from`/`to` already exist in `LogQuery`, unexposed in the UI)
   - **served model** — the model that actually answered, not the requested
     service. Both are worth filtering on and they are different questions, so
     the service filter stays and this is added beside it.
   - **error message** — substring match on the `error` column.

5. **No row cap.** The export streams: the repo yields matching rows in id pages
   and the response is written incrementally, so memory stays flat whether the
   result is 6 rows or 60,000. Capping would be the proxy substituting its
   judgement for the operator's; streaming makes the cap unnecessary rather than
   merely generous. The UI still shows the matching row count before the click,
   so a 40,000-row export is a decision rather than a surprise.

6. **Redaction is already handled at write time.** `serializeForLog` replaces
   credential-named keys before a payload is ever stored, so an export cannot
   leak a key that the log viewer would not already show. Nothing extra is
   applied, and nothing extra is needed.

7. **File shape** — one object, so the export is self-describing:

```json
{
  "exportedAt": "2026-09-06T08:00:00.000Z",
  "hydrogenVersion": "2.0.0b",
  "selection": { "mode": "filter", "filters": { "...": "..." } },
  "count": 42,
  "logs": [ { "id": 123, "...": "every column, payloads included" } ]
}
```

   Filename `hydrogen-logs-<ISO timestamp>.json`.

## Non-goals

- No unauthenticated or token-authenticated export endpoint — session only.
- No CSV, NDJSON or archive format. One JSON file.
- No scheduled or recurring export.
- No server-side retention of generated files; the response is streamed and
  never written to disk.
- No new redaction layer.

## Done when

1. Filtering the Logs tab to one API key and a two-hour window, then exporting,
   yields a file whose `logs[]` contains exactly the rows the list showed, each
   with its full request and response payloads.
2. Ticking six unrelated rows and exporting yields exactly those six.
3. Filtering by served model returns only rows that model answered; filtering by
   an error substring returns only rows whose error contains it.
4. An export of a filter matching tens of thousands of rows completes without
   the server's memory climbing with the row count.
5. A non-admin cannot reach the export at all.

## Build notes

- `LogQuery` gains `servedModel`, `errorContains`, and `ids`.
- `LogSummary` gains `servedModel`/`servedProvider` so the list can show and
  filter them; both columns already exist on the table, so **no migration**.
- A new repo method streams full rows for a query rather than reusing `query()`,
  whose 500-row clamp is right for a list and wrong for an export.
- The served-model filter needs a distinct-values source for its dropdown.
- `Logs.tsx` gains date inputs, a model dropdown, an error-text input, per-row
  checkboxes with select-all-on-page, and the Export button.
- Every new label lands in `web/src/lib/i18n.tsx` in **en and zh**; icons are
  Bootstrap Icons only.

## Open

- Does "select by dedicated entries" mean per-row checkboxes in the list, as
  specified above, or entering log ids directly? Assumed checkboxes.
- Should selection survive paging (tick rows on page 1, page to 2, export both)?
  Assumed yes — selection is held by id, not by row position.
