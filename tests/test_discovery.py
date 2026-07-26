"""Gamma payload parsing and market filtering.

Gamma is inconsistent about types (JSON-encoded arrays, numbers as strings), so
these tests pin the coercion behaviour. The YES/NO mapping tests are the critical
ones: getting that backwards would make the bot buy the same side twice and record
it as a hedged pair.
"""

import pytest

from polyarb.config import DiscoveryConfig, Settings
from polyarb.discovery import filter_markets, infer_category, parse_market


def gamma_market(**overrides):
    """A payload shaped like Gamma's, with arrays as JSON strings."""
    base = {
        "conditionId": "0xabc",
        "question": "Will X happen?",
        "slug": "will-x-happen",
        "clobTokenIds": '["111", "222"]',
        "outcomes": '["Yes", "No"]',
        "orderPriceMinTickSize": "0.01",
        "orderMinSize": "5",
        "negRisk": False,
        "closed": False,
        "liquidityNum": 25000.5,
        "volume24hr": "1234.5",
        "events": [{"slug": "geopolitics-thing", "tags": [{"slug": "geopolitics"}]}],
    }
    base.update(overrides)
    return base


class TestParseMarket:
    def test_parses_a_normal_market(self):
        m = parse_market(gamma_market())
        assert m is not None
        assert m.condition_id == "0xabc"
        assert m.yes_token_id == "111"
        assert m.no_token_id == "222"
        assert m.tick_size == pytest.approx(0.01)
        assert m.min_order_size == pytest.approx(5.0)
        assert m.liquidity == pytest.approx(25000.5)
        assert m.volume_24h == pytest.approx(1234.5)
        assert m.category == "geopolitics"

    def test_maps_yes_no_by_label_not_position(self):
        # Outcomes reversed: YES must follow the label, not index 0.
        m = parse_market(gamma_market(outcomes='["No", "Yes"]'))
        assert m.yes_token_id == "222"
        assert m.no_token_id == "111"

    def test_handles_real_arrays_not_just_json_strings(self):
        m = parse_market(gamma_market(clobTokenIds=["111", "222"], outcomes=["Yes", "No"]))
        assert m.yes_token_id == "111"

    def test_case_insensitive_outcome_labels(self):
        m = parse_market(gamma_market(outcomes='["YES", "no"]'))
        assert m is not None
        assert m.yes_token_id == "111"

    def test_snake_case_field_aliases(self):
        raw = {
            "condition_id": "0xdef",
            "question": "Q",
            "slug": "q",
            "clob_token_ids": '["7", "8"]',
            "outcomes": '["Yes", "No"]',
            "order_price_min_tick_size": "0.001",
            "order_min_size": "10",
        }
        m = parse_market(raw)
        assert m is not None
        assert m.tick_size == pytest.approx(0.001)
        assert m.min_order_size == pytest.approx(10.0)

    def test_neg_risk_string_true(self):
        assert parse_market(gamma_market(negRisk="true")).neg_risk is True
        assert parse_market(gamma_market(negRisk=False)).neg_risk is False

    def test_defaults_when_fields_missing(self):
        raw = gamma_market()
        del raw["orderPriceMinTickSize"]
        del raw["orderMinSize"]
        m = parse_market(raw)
        assert m.tick_size == pytest.approx(0.01)
        assert m.min_order_size == pytest.approx(5.0)

    def test_bad_tick_size_falls_back(self):
        assert parse_market(gamma_market(orderPriceMinTickSize="0")).tick_size == pytest.approx(0.01)
        assert parse_market(gamma_market(orderPriceMinTickSize="junk")).tick_size == pytest.approx(0.01)


class TestParseMarketRejections:
    """Anything ambiguous is dropped rather than guessed at."""

    def test_rejects_missing_condition_id(self):
        raw = gamma_market()
        del raw["conditionId"]
        assert parse_market(raw) is None

    def test_rejects_non_binary_markets(self):
        assert parse_market(gamma_market(
            clobTokenIds='["1","2","3"]', outcomes='["A","B","C"]')) is None

    def test_rejects_mismatched_token_and_outcome_counts(self):
        assert parse_market(gamma_market(clobTokenIds='["1"]')) is None

    def test_rejects_non_yes_no_outcomes(self):
        # Scalar or named-outcome markets are not complement pairs.
        assert parse_market(gamma_market(outcomes='["Trump", "Biden"]')) is None

    def test_rejects_unparseable_arrays(self):
        assert parse_market(gamma_market(clobTokenIds="not json")) is None


class TestInferCategory:
    def test_from_top_level_category(self):
        assert infer_category({"category": "Crypto"}) == "crypto"

    def test_from_tag_dicts(self):
        assert infer_category({"tags": [{"slug": "nba"}]}) == "sports"

    def test_from_plain_string_tags(self):
        assert infer_category({"tags": ["Politics"]}) == "politics"

    def test_from_nested_event_tags(self):
        raw = {"events": [{"tags": [{"label": "Bitcoin"}]}]}
        assert infer_category(raw) == "crypto"

    def test_substring_match_on_compound_slugs(self):
        assert infer_category({"tags": [{"slug": "nba-finals-2026"}]}) == "sports"

    def test_unknown_returns_empty(self):
        assert infer_category({"tags": [{"slug": "zzz-unmapped"}]}) == ""

    def test_unknown_category_prices_at_the_worst_rate(self):
        # The whole point of returning "" — an unrecognised market must never be
        # assumed cheap, or the bot will trade it on fees it isn't paying.
        s = Settings()
        assert s.fee_rate_for("") == pytest.approx(0.07)
        assert s.fee_rate_for("totally-unknown") == pytest.approx(0.07)
        assert s.fee_rate_for("geopolitics") == 0.0


class TestFilterMarkets:
    def make(self, **kw):
        return parse_market(gamma_market(**kw))

    def test_filters_by_category(self):
        cfg = DiscoveryConfig(categories=["geopolitics"], min_liquidity=0)
        geo = self.make()
        crypto = self.make(conditionId="0x2", events=[{"tags": [{"slug": "crypto"}]}])
        out = filter_markets([geo, crypto], cfg)
        assert [m.condition_id for m in out] == ["0xabc"]

    def test_empty_category_list_allows_all(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=0)
        assert len(filter_markets([self.make(), self.make(conditionId="0x2")], cfg)) == 2

    def test_filters_by_liquidity(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=50_000)
        assert filter_markets([self.make()], cfg) == []

    def test_excludes_closed(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=0)
        assert filter_markets([self.make(closed=True)], cfg) == []

    def test_excludes_neg_risk_by_default(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=0)
        assert filter_markets([self.make(negRisk=True)], cfg) == []
        cfg2 = DiscoveryConfig(categories=[], min_liquidity=0, exclude_neg_risk=False)
        assert len(filter_markets([self.make(negRisk=True)], cfg2)) == 1

    def test_ranks_cheap_fee_categories_first(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=0)
        crypto = self.make(conditionId="0xc", events=[{"tags": [{"slug": "crypto"}]}],
                           liquidityNum=999_999)
        geo = self.make(conditionId="0xg", liquidityNum=1.0)
        out = filter_markets([crypto, geo], cfg)
        # Fee-free beats deep-but-expensive.
        assert [m.condition_id for m in out] == ["0xg", "0xc"]

    def test_liquidity_breaks_ties_within_a_category(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=0)
        thin = self.make(conditionId="0x1", liquidityNum=100)
        deep = self.make(conditionId="0x2", liquidityNum=100_000)
        assert [m.condition_id for m in filter_markets([thin, deep], cfg)] == ["0x2", "0x1"]

    def test_respects_max_markets(self):
        cfg = DiscoveryConfig(categories=[], min_liquidity=0, max_markets=2)
        markets = [self.make(conditionId=f"0x{i}") for i in range(10)]
        assert len(filter_markets(markets, cfg)) == 2
