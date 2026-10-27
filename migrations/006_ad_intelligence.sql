BEGIN;

ALTER TABLE competitor_ads
  ADD COLUMN page_id text,
  ADD COLUMN headline text,
  ADD COLUMN description text,
  ADD COLUMN display_format text,
  ADD COLUMN ad_type text,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN publisher_platforms jsonb,
  ADD COLUMN impressions_lower_bound numeric,
  ADD COLUMN impressions_upper_bound numeric,
  ADD COLUMN spend_lower_bound numeric,
  ADD COLUMN spend_upper_bound numeric,
  ADD COLUMN currency text,
  ADD COLUMN media jsonb;

ALTER TABLE competitor_ads
  ADD CONSTRAINT competitor_ads_page_id_length
    CHECK (page_id IS NULL OR length(page_id) BETWEEN 1 AND 256) NOT VALID,
  ADD CONSTRAINT competitor_ads_headline_length
    CHECK (headline IS NULL OR length(headline) BETWEEN 1 AND 500) NOT VALID,
  ADD CONSTRAINT competitor_ads_description_length
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 2000) NOT VALID,
  ADD CONSTRAINT competitor_ads_display_format_length
    CHECK (display_format IS NULL OR length(display_format) BETWEEN 1 AND 100) NOT VALID,
  ADD CONSTRAINT competitor_ads_ad_type
    CHECK (ad_type IS NULL OR ad_type IN ('image', 'video', 'carousel', 'text')) NOT VALID,
  ADD CONSTRAINT competitor_ads_ended_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at) NOT VALID,
  ADD CONSTRAINT competitor_ads_impressions_lower_nonnegative
    CHECK (impressions_lower_bound IS NULL OR impressions_lower_bound >= 0) NOT VALID,
  ADD CONSTRAINT competitor_ads_impressions_upper_nonnegative
    CHECK (impressions_upper_bound IS NULL OR impressions_upper_bound >= 0) NOT VALID,
  ADD CONSTRAINT competitor_ads_impressions_ordered
    CHECK (impressions_upper_bound IS NULL OR impressions_upper_bound >= impressions_lower_bound) NOT VALID,
  ADD CONSTRAINT competitor_ads_spend_lower_nonnegative
    CHECK (spend_lower_bound IS NULL OR spend_lower_bound >= 0) NOT VALID,
  ADD CONSTRAINT competitor_ads_spend_upper_nonnegative
    CHECK (spend_upper_bound IS NULL OR spend_upper_bound >= 0) NOT VALID,
  ADD CONSTRAINT competitor_ads_spend_ordered
    CHECK (spend_upper_bound IS NULL OR spend_upper_bound >= spend_lower_bound) NOT VALID,
  ADD CONSTRAINT competitor_ads_currency_length
    CHECK (currency IS NULL OR length(currency) = 3) NOT VALID;

COMMIT;

ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_page_id_length;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_headline_length;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_description_length;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_display_format_length;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_ad_type;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_ended_after_start;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_impressions_lower_nonnegative;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_impressions_upper_nonnegative;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_impressions_ordered;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_spend_lower_nonnegative;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_spend_upper_nonnegative;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_spend_ordered;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_currency_length;
