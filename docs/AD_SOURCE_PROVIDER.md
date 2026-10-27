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

Planned adapters can implement the same contract:

- `ApifyMetaAdsProvider`;
- `SocialPetaProvider`;
- an official Meta endpoint if access and permitted scope are available;
- a private first-party collector.

Provider adapters are responsible only for fetching and source-specific normalization. They must not write to storage directly. `AdLibraryService` owns tenant validation, deduplication, persistence, and import statistics.

Before enabling a network collector, it must include:

- bounded pagination and item limits;
- timeouts and retries;
- explicit rate limits;
- source provenance;
- raw snapshot retention policy;
- terms-of-service and data-use review;
- secret management outside source control;
- idempotent provider IDs;
- observability without logging credentials or personal data.
