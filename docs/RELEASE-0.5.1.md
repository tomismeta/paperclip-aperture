# paperclip-aperture 0.5.1

`0.5.1` is a patch release focused on concurrent reconciliation reads.

## Highlights

- coalesces concurrent cache-eligible reconciliation loads by company and cache key
- coalesces concurrent host-value cache misses without serializing unrelated companies or resources
- clears successful and rejected in-flight loads so later requests can retry normally
- prevents invalidated or superseded host loads from restoring stale cache entries
- refreshes the reconciled-candidate flight key after candidate-cache expiry

## Contributor

- Thanks to [@lusoris](https://github.com/lusoris) for raising [PR #6](https://github.com/tomismeta/paperclip-aperture/pull/6), which introduced the concurrent reconciliation read coalescing work.

## Validation

- `pnpm release:check`
- `pnpm pack:check`
- deterministic candidate-cache-expiry concurrency regression
- issue-intelligence evaluation
- production build and bundle-size checks
