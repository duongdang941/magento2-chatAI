import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationScenarios } from '../evals/conversation-scenarios.mjs';

test('provides two hundred long commerce and feature-safety conversations', () => {
    assert.equal(conversationScenarios.length, 200);
    const ids = new Set();
    const regional = conversationScenarios.filter((scenario) => scenario.catalog_topic && typeof scenario.catalog_topic === 'object');
    const safety = conversationScenarios.filter((scenario) => scenario.catalog_topic === 'feature-safety');
    const grounded = conversationScenarios.filter((scenario) => String(scenario.id).startsWith('grounded-'));

    assert.equal(regional.length, 100);
    assert.equal(grounded.length, 80);
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
    }
});
