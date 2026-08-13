import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationScenarios } from '../evals/conversation-scenarios.mjs';

test('provides one hundred multi-turn, dialect-aware commerce conversations', () => {
    assert.equal(conversationScenarios.length, 100);
    const ids = new Set();

    for (const scenario of conversationScenarios) {
        assert.ok(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
        ids.add(scenario.id);
        assert.ok(scenario.turns.length >= scenario.requirements.min_turns, `${scenario.id} is too short`);
        assert.ok(scenario.requirements.requires_catalog_context, `${scenario.id} must check catalog memory`);
        assert.ok(scenario.requirements.requires_availability_tool, `${scenario.id} must check availability`);
        assert.ok(scenario.turns.some((turn) => turn.text.includes(scenario.dialect_marker)), `${scenario.id} lacks regional language`);
        assert.ok(scenario.turns.some((turn) => turn.expect.includes('memory')), `${scenario.id} lacks a memory turn`);
    }
});
