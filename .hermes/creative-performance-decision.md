# Roadmap 8 — first-party Creative Performance decision

## Verdict

**Honestly deferred; no production slice added.**

First-party Creative Performance is a real capability gap relative to the inspected reference, but the target cannot currently link imported first-party results to an honest target-native creative/campaign/ad identity. Adding metrics now would either attach first-party results to `competitor_ads` (which are explicitly public competitor-library observations) or treat a planning artifact such as `creative_briefs` as a deployed ad. Both would be misleading.

## Comparison boundary

- Target: `/root/.hermes/profiles/teacher/projects/creative-intelligence`, Git `35fbd945922779fba8666ea4cb6ecb38f829efaf` plus the complete dirty working tree (89 pre-existing dirty entries observed before this decision file was created).
- Reference: read-only tree `/root/.hermes/profiles/teacher/cache/scratch/muppets-audit/muppets`; observable routes, services, components, tests, and types were inspected. It is not a Git checkout. A path + per-file-content manifest over 1,852 non-`node_modules` files (56,637,160 bytes) was `00acc689a39cdfcc63f13e054feeb9525a4c65c2588103979a8d912a1f59374d`.
- Scope: roadmap point 8 only. Public competitor-library analytics, generation billing/cost, product analytics, and AI-tag governance are not first-party ad performance.

## Layer-by-layer audit

| Layer | Reference evidence | Target evidence | Verdict |
|---|---|---|---|
| Durable source/model | `lib/services/creative-performance.ts` reads first-party daily Meta rows from `creative_performance_meta` and `meta_marketing_api`, keyed by platform ad/campaign/ad-set names and IDs. | The 24 created tables contain products, competitors, `competitor_ads`, briefs, analyses, public-library snapshots, winning references, and inspiration records. There is no first-party creative, campaign, ad, account, deployment, or metric fact. | Real gap; no honest join target. |
| Metric grain/semantics | Reference queries constrain `cost_date`/`date_start`, aggregate supplied spend, impressions, clicks, video milestones, installs, subscriptions, purchases, and revenue, then derive rates with safe division. | `competitor_ads` stores nullable public-library impression/spend bounds; `competitor_analytics_snapshots` stores a daily **public momentum proxy**, not daily first-party facts. No timezone, currency-per-fact, attribution window, or correction policy exists for first-party results. | Existing values cannot be relabeled. |
| Domain computation | Reference computes CTR/CPC/CPM, hook/hold rates, CPI/CPT/CPS/CPP, CVR and ROAS from warehouse facts. | `src/analytics/scale-metrics.ts` explicitly labels its output `Public Ad Library momentum proxy`; docs and UI say it is not verified spend, revenue, conversion, or ROAS. | Keep domains separate. |
| Import/orchestration | Reference depends on pre-existing proprietary warehouse tables and separately enriches rows with creative tagging. Its generic `/api/analytics` service is mostly usage/activity scoring, not this dashboard. | Provider-neutral competitor import exists, but only under competitor/product ownership. No manual first-party metric import contract, import run, correction ledger, or first-party external-ID namespace exists. | A metric-only importer would create orphan or falsely linked facts. |
| API | Reference exposes `/api/creative-performance` plus preview routes and validates dashboard filters. | Target OpenAPI exposes public competitor analytics and competitor creative workflows only. | Missing, but an API should follow a valid aggregate. |
| UI | Reference has `/dashboard/creative-performance` list/detail pages, filters, summary/table/card views, daily trends, demographic/retention views, and provenance via warehouse/Meta identifiers. The older `/analytics` page is a zero-data placeholder. | Target Analytics is deliberately a public-library proxy; no first-party performance page or import workflow exists. | Real user-visible gap, unsafe to imitate without data identity. |
| Tenancy/operations | Reference accepts an organization parameter for access/tag enrichment, while its fixed BigQuery tables are the factual source. | Target requires PostgreSQL RLS/FORCE RLS and tenant-safe aggregates. There is no tenant-owned first-party source account or mapping on which to enforce those invariants. | Prerequisite missing. |

## Why a manual/mock slice is not yet meaningful

A provider-neutral, deterministic manual import is the correct first adapter **after** the target has a first-party identity to receive it. Today:

1. `competitor_ads` requires a competitor and represents observed public-library ads.
2. `creative_briefs.source_ad_id` points back to `competitor_ads`; a brief is a versioned planning/production handoff, not proof of publication.
3. `winning_ads` snapshots a competitor ad reference (`source_ad_id`, source provider/platform/external ID).
4. `inspiration_items.source_kind` is only `competitor_ad` or `winning_ad`.
5. No entity records that an organization published a specific creative as a provider campaign/ad, and no stable organization-scoped provider namespace + external campaign/ad identity exists.

Creating a free-floating metric row keyed only by arbitrary external strings would not support an honest creative aggregate. Mapping it to any existing entity would fabricate identity or provenance. Therefore no RED→GREEN production cycle was started and no schema/API/UI/OpenAPI change was made.

## Prerequisites to resume

1. Define a tenant-owned first-party creative asset/revision identity distinct from competitor ads, including its relationship (if any) to a brief or produced artifact.
2. Define tenant-owned provider account, campaign, ad set (if applicable), and ad/deployment identities with stable provider namespace plus organization-scoped external IDs.
3. Define an explicit mapping workflow from a deployed first-party ad to the target creative revision; unresolved mappings must remain unresolved, never guessed by name.
4. Choose factual semantics for each supported metric: daily reporting timezone, ISO currency, attribution window/model, source report grain, null/unknown handling, and whether values are additive daily facts or non-additive rolling windows.
5. Define bounded, idempotent manual import with immutable import provenance, correction/upsert rules, duplicate detection, and rejection of overlapping rolling windows. No credentials or live adapter are needed for the first slice.
6. Then build with strict vertical RED→GREEN TDD: constraints and FORCE RLS; cross-tenant isolation; import idempotency/corrections; bounded tenant-safe API; strict OpenAPI and browser decoders; provenance/freshness UI; and real PostgreSQL tests.

## Non-negotiable boundary

Public reach/impression/spend bounds, ad activity, first/last-seen dates, AI tags, brief status, hook usage, and public-library momentum scores must not be renamed or used as observed first-party spend, revenue, conversions, ROAS, CTR, CPA, or campaign results. AI output must not make performance claims.
