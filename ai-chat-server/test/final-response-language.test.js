import test from 'node:test';
import assert from 'node:assert/strict';

import {
    assessFinalResponseLanguage,
    finalResponseLanguageRepairInstruction
} from '../services/conversation/final-response-language.js';

test('accepts long final prose in the model-declared shopper language', () => {
    const assessment = assessFinalResponseLanguage(
        'Sản phẩm này hiện còn hàng. Bạn có thể chọn kích thước phù hợp trên trang sản phẩm trước khi đặt hàng.',
        'vi-VN'
    );

    assert.equal(assessment.accepted, true);
    assert.equal(assessment.checked, true);
    assert.equal(assessment.expectedLanguage, 'vi');
    assert.equal(assessment.detectedLanguage, 'vi');
});

test('rejects a high-confidence final-language mismatch without a phrase dictionary', () => {
    const assessment = assessFinalResponseLanguage(
        'Il modello deve verificare la disponibilità prima di rispondere. Questo messaggio è scritto interamente in italiano per il cliente.',
        'vi'
    );

    assert.equal(assessment.accepted, false);
    assert.equal(assessment.checked, true);
    assert.equal(assessment.expectedLanguage, 'vi');
    assert.notEqual(assessment.detectedLanguage, assessment.expectedLanguage);
    assert.match(finalResponseLanguageRepairInstruction(assessment), /BCP-47 language vi/i);
});

test('does not reject short or unknown-language final prose', () => {
    assert.deepEqual(assessFinalResponseLanguage('OK', 'vi'), {
        accepted: true,
        checked: false,
        expectedLanguage: 'vi'
    });
    assert.equal(assessFinalResponseLanguage('A sufficiently long arbitrary answer.', 'x-custom').accepted, true);
});
