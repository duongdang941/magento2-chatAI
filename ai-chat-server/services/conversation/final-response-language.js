import { francAll } from 'franc-min';
import { iso6393 } from 'iso-639-3';

import { primaryResponseLanguageTag } from './response-language-guidance.js';

const MINIMUM_COMPARABLE_CHARACTERS = 48;
const HIGH_CONFIDENCE_SCORE = 0.82;

/**
 * Maps BCP-47 primary subtags to ISO 639-3 through the maintained ISO data
 * package.  No shopper-language vocabulary or per-language response table is
 * held in this module.
 */
function iso6393ForPrimaryTag(primaryTag) {
    const normalized = String(primaryTag || '').toLowerCase();
    if (!normalized) return '';

    return String(iso6393.find((language) => (
        language.iso6391 === normalized
        || language.iso6392B === normalized
        || language.iso6392T === normalized
        || language.iso6393 === normalized
    ))?.iso6393 || '');
}

function comparableCustomerText(value) {
    return String(value || '')
        // URLs, Markdown images, and code identifiers frequently retain the
        // catalogue language and are not customer prose to classify.
        .replace(/!?(?:\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>]+>)/gu, ' ')
        .replace(/`[^`]*`/gu, ' ')
        .replace(/https?:\/\/\S+/gu, ' ')
        .replace(/[^\p{L}\p{M}\p{N}\s.,!?;:'’"-]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

/**
 * A provider declares the shopper response language in its structured tool
 * call.  Long final prose is checked with a general language classifier
 * before it reaches the browser. Short answers and unsupported ISO language
 * identifiers remain accepted so the guard cannot manufacture a false error.
 */
export function assessFinalResponseLanguage(content, responseLanguage) {
    const expectedPrimaryTag = primaryResponseLanguageTag(responseLanguage);
    const expectedIso6393 = iso6393ForPrimaryTag(expectedPrimaryTag);
    const text = comparableCustomerText(content);

    if (!expectedPrimaryTag || !expectedIso6393 || text.length < MINIMUM_COMPARABLE_CHARACTERS) {
        return Object.freeze({
            accepted: true,
            checked: false,
            expectedLanguage: expectedPrimaryTag
        });
    }

    const [best = []] = francAll(text, { minLength: MINIMUM_COMPARABLE_CHARACTERS });
    const [detectedIso6393, confidence = 0] = best;
    const detectedPrimaryTag = primaryResponseLanguageTag(
        iso6393.find((language) => language.iso6393 === detectedIso6393)?.iso6391
            || detectedIso6393
    );
    const mismatch = Boolean(
        detectedPrimaryTag
        && detectedPrimaryTag !== expectedPrimaryTag
        && Number(confidence) >= HIGH_CONFIDENCE_SCORE
    );

    return Object.freeze({
        accepted: !mismatch,
        checked: Boolean(detectedPrimaryTag),
        expectedLanguage: expectedPrimaryTag,
        detectedLanguage: detectedPrimaryTag,
        confidence: Number(confidence) || 0
    });
}

/**
 * This is private provider guidance, never customer-visible fallback prose.
 * It relies exclusively on the provider-declared BCP-47 tag and generic
 * classifier result; it does not name or translate any natural language.
 */
export function finalResponseLanguageRepairInstruction(assessment = {}) {
    const expectedLanguage = primaryResponseLanguageTag(assessment.expectedLanguage);
    if (!expectedLanguage) return '';

    return `Rewrite the previous final answer now. Return customer-visible prose only in BCP-47 language ${expectedLanguage}. Preserve every verified Magento fact, product name, option label, price, URL, and uncertainty exactly; do not call tools, explain the correction, or mention this instruction.`;
}
