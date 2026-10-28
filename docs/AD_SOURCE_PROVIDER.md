# Ad source provider contract

`AdSourceProvider` isolates the product from collection vendors.

```ts
interface AdSourceProvider {
  collect(context: Readonly<AdCollectionContext>): Promise<CollectedAd[]>
}
```

Providers are registered by the trusted composition root under a stable namespace. Callers select a registered namespace; provider-returned metadata cannot choose or override it. `AdLibraryService` passes a frozen tenant-context snapshot to the adapter and validates the complete returned batch before one atomic repository write.

Current implementation:

- `ManualMetaAdsProvider` — accepts manually supplied/mock Meta records, validates them, and returns normalized records.
- `ApifyMetaAdsProvider` — runs `curious_coder/facebook-ads-library-scraper`, the Actor used by Muppets, through a fixed Apify API endpoint.

The Apify adapter sends the credential only in `Authorization: Bearer …`. It rejects redirects, non-JSON responses, malformed records, duplicate provider IDs, oversized bodies and batches, and requests exceeding one end-to-end deadline (queue wait, headers, and body). Actor runs are never retried automatically. A shared gate bounds active runs and admits at most twice the configured concurrency as queued work; overload fails closed. Concurrent requests for the same competitor are coalesced within one server process. A PostgreSQL-backed per-organization cooldown is claimed only after the shared gate grants an execution slot and is timestamped with the database clock immediately before the Actor request; it permits at most one paid Apify Actor start per 60 seconds across server processes. Rejected attempts return the fixed `409 Resource conflict` response. The complete normalized batch is validated before one PostgreSQL transaction writes it under the trusted `apify-meta-ads` namespace.

`POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/apify-meta/sync` uses the competitor's configured Meta page URL. The endpoint requires an active product and competitor, organization membership, and server-side Apify configuration; browser clients never receive the Apify credential.

Other adapters can implement the same contract:

- `SocialPetaProvider`;
- an official Meta endpoint if access and permitted scope are available;
- a private first-party collector.

Provider adapters are responsible only for fetching and source-specific normalization. They must not write to storage directly. `AdLibraryService` owns tenant validation, deduplication, persistence, and import statistics.

## Ingestion analytics snapshots

Every successful manual or scheduled provider import captures analytics in the same PostgreSQL transaction as ad upserts, complete-snapshot retirement, and (for scheduled work) run success. Any ad, retirement, snapshot, or ledger failure rolls the whole transaction back; provider/validation failures happen before it and write neither ads nor analytics.

- **Grain, scope, and concurrency:** one row per `(organization_id, competitor_id, UTC database day)`, using the existing primary key. An import for one active competitor recomputes every active competitor in that product because `scale_score` is product-relative. Manual and scheduled imports acquire the same transaction-scoped product advisory lock after authorization and before any ad mutation; concurrent imports for different competitors in one product therefore aggregate the preceding committed import instead of overwriting product-relative metrics from split transaction snapshots. Snapshot rows are written in `competitor_id` order. Archived products/competitors cannot trigger capture, and the composite tenant/product/competitor relationships remain database-enforced.
- **Clock:** one `clock_timestamp()` value supplies every window boundary, activity duration, `captured_at`, and the UTC `snapshot_date`. Application or worker clocks do not date ingestion snapshots.
- **Idempotency and replay:** the daily key is upserted, not appended. A same-day provider retry, duplicate reimport, scheduled retry, or replay refreshes the row from current durable ad state without creating history duplicates. A later UTC day creates the next historical row.
- **Complete versus partial:** both successful forms capture the resulting durable state. A trusted complete Apify snapshot first retires missing ads only within its exact canonical provider scope; a partial/manual snapshot never infers absence and never retires missing ads. Analytics is captured after that decision, so it reflects the committed state.
- **Fencing and privileges:** scheduled capture requires the same live run ID, lease owner, fence token, unexpired lease, enabled schedule, active scope, and authorized admin as scheduled ad mutation. A reclaimed/stale worker cannot write snapshots. The worker has no direct analytics-table privilege; it can invoke only the fenced `SECURITY DEFINER` capability. Runtime capture still requires tenant membership, and normal snapshot reads retain RLS.

The analytics GET endpoint remains compatible: it computes and returns the same public-library momentum proxy and refreshes the same daily rows.

Before enabling a network collector, it must include:

- bounded pagination and item limits;
- timeouts and an explicit retry policy (Actor starts are not retried);
- explicit rate limits;
- source provenance;
- raw snapshot retention policy;
- terms-of-service and data-use review;
- secret management outside source control;
- idempotent provider IDs;
- observability without logging credentials or personal data.
