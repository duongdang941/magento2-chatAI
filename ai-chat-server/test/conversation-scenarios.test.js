import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationScenarios } from '../evals/conversation-scenarios.mjs';
import { productGroundTruthCases } from '../evals/product-ground-truth-cases.mjs';

test('provides two hundred long commerce and feature-safety conversations', () => {
    assert.equal(conversationScenarios.length, 200);
    const ids = new Set();
    const catalog = conversationScenarios.filter((scenario) => scenario.catalog_topic && typeof scenario.catalog_topic === 'object');
    const regional = catalog.filter((scenario) => typeof scenario.dialect_marker === 'string');
    const safety = conversationScenarios.filter((scenario) => scenario.catalog_topic === 'feature-safety');
    const grounded = conversationScenarios.filter((scenario) => String(scenario.id).startsWith('grounded-'));

    assert.equal(catalog.length, 80);
    // One regional fixture is intentionally replaced by a no-diacritics
    // lowest-price continuity case. The total remains 200 while coverage now
    // includes a spelling-variant product-family request.
    assert.equal(regional.length, 76);
    assert.equal(grounded.length, 100);
    assert.equal(safety.length, 20);

    for (const scenario of conversationScenarios) {
        assert.ok(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
        ids.add(scenario.id);
        assert.ok(scenario.turns.length >= scenario.requirements.min_turns, `${scenario.id} is too short`);
        assert.ok(scenario.turns.some((turn) => turn.expect.includes('memory')), `${scenario.id} lacks a memory turn`);
    }

    for (const scenario of regional) {
        assert.ok(scenario.requirements.requires_catalog_context, `${scenario.id} must check catalog memory`);
        assert.ok(scenario.requirements.requires_availability_tool, `${scenario.id} must check availability`);
        assert.ok(scenario.turns.some((turn) => turn.text.includes(scenario.dialect_marker)), `${scenario.id} lacks regional language`);
    }

    for (const scenario of safety) {
        assert.equal(scenario.requirements.must_not_expose_private_data, true, `${scenario.id} lacks privacy requirement`);
        assert.equal(scenario.requirements.must_not_mutate_without_authorization, true, `${scenario.id} lacks mutation guard`);
        const firstTurn = scenario.turns[0] || {};
        assert.ok(
            Array.isArray(firstTurn.expected_tools) || Array.isArray(firstTurn.forbidden_tools),
            `${scenario.id} lacks a first-turn canonical tool safety contract`
        );
    }

    const exactTypoScenario = conversationScenarios.find((scenario) => scenario.id === 'grounded-continuity-typo-regenschirm');
    assert.deepEqual(
        exactTypoScenario?.turns[0]?.exact_identity_skus,
        ['N021.C103'],
        'a concrete exact-product test must reject unrelated cards in the same grid'
    );

    const lowestCategoryPriceScenario = conversationScenarios.find((scenario) => scenario.id === 'commerce-category-price-continuity-vi');
    assert.equal(
        lowestCategoryPriceScenario?.turns.filter((turn) => turn.requires_lowest_category_price === true).length,
        2,
        'a low-price category scenario must verify the live Magento price order rather than only category continuity'
    );

    const unaccentedLowestCategoryScenario = conversationScenarios.find(
        (scenario) => scenario.id === 'commerce-category-price-continuity-vi-unaccented'
    );
    assert.equal(
        unaccentedLowestCategoryScenario?.turns.filter((turn) => turn.requires_lowest_category_price === true).length,
        2,
        'a spelling-variant low-price request must retain the same verified Magento category and price order'
    );

    const coveredTruthIds = new Set(grounded.map((scenario) => scenario.id.replace(/^grounded-(?:continuity|language-switch)-/, '')));
    for (const truthCase of productGroundTruthCases) {
        assert.ok(coveredTruthIds.has(truthCase.id), `grounded evaluation omitted ${truthCase.id}`);
    }
});
