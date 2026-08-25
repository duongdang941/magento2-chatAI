import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createToolActivityId,
    createToolActivityContinuationKey,
    createToolExecutionFingerprint,
    createToolActivityPresentation,
    emitToolActivity,
    hasCompleteToolActivityPresentation,
    withoutToolActivityPresentation
} from '../services/orchestration/tool-activity.js';

test('creates one opaque continuation key from the semantic tool operation, not its label', () => {
    const first = createToolActivityContinuationKey({
        toolName: 'searchProducts',
        args: {
            query: ' Áo  màu   đen ',
            categoryId: 0,
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['tôi muốn'],
            limit: 5,
            page: 1,
            activityPresentation: { runningLabel: 'Đang tìm sản phẩm' }
        }
    });
    const repeated = createToolActivityContinuationKey({
        toolName: 'searchProducts',
        args: {
            query: 'áo màu đen',
            categoryId: 0,
            exactIdentity: false,
            responseLanguage: 'en',
            responseLanguageEvidence: ['show me'],
            limit: 10,
            page: 2,
            activityPresentation: { runningLabel: 'Searching for products' }
        }
    });
    const differentQuery = createToolActivityContinuationKey({
        toolName: 'searchProducts',
        args: { query: 'áo màu trắng', categoryId: 0, exactIdentity: false }
    });
    const differentScope = createToolActivityContinuationKey({
        toolName: 'searchProducts',
        args: { query: 'áo màu đen', categoryId: 44, exactIdentity: false }
    });

    assert.match(first, /^activity-[a-f0-9]{24}$/);
    assert.equal(first, repeated);
    assert.notEqual(first, differentQuery);
    assert.notEqual(first, differentScope);
});

test('keeps an image SVG fallback in one visible action while preserving its separate execution', () => {
    const nativeAttempt = {
        prompt: 'Một bức ảnh chú chó dễ thương',
        activityPresentation: { completedLabel: 'Đã hoàn thành tạo hình ảnh chú chó' }
    };
    const svgFallback = {
        ...nativeAttempt,
        svg_content: '<svg viewBox="0 0 1 1"><circle cx=".5" cy=".5" r=".5" /></svg>'
    };

    assert.equal(
        createToolActivityContinuationKey({ toolName: 'generateImage', args: nativeAttempt }),
        createToolActivityContinuationKey({ toolName: 'generateImage', args: svgFallback })
    );
    assert.notEqual(
        createToolExecutionFingerprint({ toolName: 'generateImage', args: nativeAttempt }),
        createToolExecutionFingerprint({ toolName: 'generateImage', args: svgFallback })
    );
});

test('emits a customer-safe running and completed tool timeline event', () => {
    const sent = [];
    const ws = { send: (message) => sent.push(JSON.parse(message)) };
    const activityId = createToolActivityId('catalog-1', 'searchProducts');

    emitToolActivity(ws, {
        activityId,
        toolName: 'searchProducts',
        state: 'running'
    });
    emitToolActivity(ws, {
        activityId,
        toolName: 'searchProducts',
        state: 'completed',
        result: { data: [{ id: 1 }, { id: 2 }] }
    });

    assert.deepEqual(sent, [
        {
            type: 'tool_activity',
            activity_id: 'tool-catalog-1',
            tool: 'searchProducts',
            state: 'running'
        },
        {
            type: 'tool_activity',
            activity_id: 'tool-catalog-1',
            tool: 'searchProducts',
            state: 'completed',
            result_count: 2
        }
    ]);
});

test('does not expose raw tool payloads in an activity event', () => {
    const sent = [];
    emitToolActivity({ send: (message) => sent.push(JSON.parse(message)) }, {
        activityId: 'tool-safe',
        toolName: 'getProductAvailability',
        state: 'failed',
        result: { error: 'internal endpoint https://example.test/?token=secret' }
    });

    assert.deepEqual(sent[0], {
        type: 'tool_activity',
        activity_id: 'tool-safe',
        tool: 'getProductAvailability',
        state: 'failed'
    });
});

test('relays only an opaque continuation key, never tool arguments or labels', () => {
    const sent = [];
    emitToolActivity({ send: (message) => sent.push(JSON.parse(message)) }, {
        activityId: 'tool-safe',
        continuationKey: 'activity-4d8a9c0be4b565e25b696e5a',
        toolName: 'searchProducts',
        state: 'running',
        presentation: { label: 'Tìm áo màu đen' }
    });

    assert.deepEqual(sent[0], {
        type: 'tool_activity',
        activity_id: 'tool-safe',
        tool: 'searchProducts',
        state: 'running',
        continuation_key: 'activity-4d8a9c0be4b565e25b696e5a',
        label: 'Tìm áo màu đen'
    });
});

test('relays dynamic activity labels in an arbitrary shopper language', () => {
    const args = {
        categoryId: 44,
        activityPresentation: {
            language: 'es-MX',
            runningLabel: 'Buscando productos en {category}',
            completedLabel: 'Productos recuperados de {category}',
            failedLabel: 'No se pudieron recuperar productos de {category}',
            runningSummary: 'Trabajo en curso: {duration}',
            completedSummary: 'Trabajo finalizado en {duration}'
        }
    };

    const running = createToolActivityPresentation({
        toolName: 'searchProducts',
        args,
        knownCategoryName: 'Textilien',
        state: 'running'
    });
    const completed = createToolActivityPresentation({
        toolName: 'searchProducts',
        args,
        knownCategoryName: 'Textilien',
        state: 'completed'
    });

    assert.deepEqual(running, {
        displayKey: 'catalog-search-category-44',
        language: 'es-MX',
        label: 'Buscando productos en Textilien',
        turnSummary: 'Trabajo en curso: {duration}'
    });
    assert.deepEqual(completed, {
        displayKey: 'catalog-search-category-44',
        language: 'es-MX',
        label: 'Productos recuperados de Textilien',
        turnSummary: 'Trabajo finalizado en {duration}'
    });
});

test('requires a complete dynamic activity contract for product search', () => {
    const complete = {
        query: 'áo đen',
        activityPresentation: {
            language: 'vi',
            runningLabel: 'Đang tìm sản phẩm {scope}',
            completedLabel: 'Đã tìm xong sản phẩm {scope}',
            failedLabel: 'Không thể tìm sản phẩm {scope}',
            runningSummary: 'Đang xử lý trong {duration}',
            completedSummary: 'Đã xử lý trong {duration}',
            searchScope: 'trong toàn bộ cửa hàng'
        }
    };

    assert.equal(hasCompleteToolActivityPresentation({ toolName: 'searchProducts', args: complete }), true);
    assert.equal(hasCompleteToolActivityPresentation({
        toolName: 'searchProducts',
        args: { query: 'áo đen', activityPresentation: { language: 'vi' } }
    }), false);
});

test('uses a model-localized verified search scope for the whole store and a category', () => {
    const storeSearch = createToolActivityPresentation({
        toolName: 'searchProducts',
        args: {
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Đang tìm sản phẩm màu đen {scope}',
                completedLabel: 'Đã tìm xong sản phẩm màu đen {scope}',
                failedLabel: 'Không thể tìm sản phẩm màu đen {scope}',
                runningSummary: 'Đang xử lý trong {duration}',
                completedSummary: 'Đã xử lý trong {duration}',
                searchScope: 'trong cửa hàng'
            }
        },
        state: 'running'
    });
    const categorySearch = createToolActivityPresentation({
        toolName: 'searchProducts',
        args: {
            categoryId: 44,
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Đang tìm sản phẩm màu đen {scope}',
                completedLabel: 'Đã tìm xong sản phẩm màu đen {scope}',
                failedLabel: 'Không thể tìm sản phẩm màu đen {scope}',
                runningSummary: 'Đang xử lý trong {duration}',
                completedSummary: 'Đã xử lý trong {duration}',
                searchScope: 'trong danh mục {category}'
            }
        },
        knownCategoryName: 'Áo thun & Áo Polo',
        state: 'running'
    });

    assert.equal(storeSearch.label, 'Đang tìm sản phẩm màu đen trong cửa hàng');
    assert.equal(categorySearch.label, 'Đang tìm sản phẩm màu đen trong danh mục Áo thun & Áo Polo');
});

test('removes a search-only placeholder leaked into a non-search action label', () => {
    const presentation = createToolActivityPresentation({
        toolName: 'listCategories',
        args: {
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Đang xem các nhóm sản phẩm trong {scope}',
                completedLabel: 'Đã xem xong các nhóm sản phẩm trong {scope}',
                failedLabel: 'Không thể xem các nhóm sản phẩm trong {scope}',
                runningSummary: 'Đang xử lý trong {duration}',
                completedSummary: 'Đã xử lý trong {duration}'
            }
        },
        state: 'running'
    });

    assert.equal(presentation.label, 'Đang xem các nhóm sản phẩm');
});

test('keeps the total-work header generic and rejects category-specific text', () => {
    const presentation = createToolActivityPresentation({
        toolName: 'searchProducts',
        args: {
            categoryId: 99,
            activityPresentation: {
                language: 'en',
                runningLabel: 'Searching products in {category}',
                completedLabel: 'Retrieved products in {category}',
                failedLabel: 'Could not retrieve products in {category}',
                runningSummary: 'Fetching T-Shirts & Polohemden in {duration}',
                completedSummary: 'Fetched T-Shirts & Polohemden in {duration}'
            }
        },
        knownCategoryName: 'T-Shirts & Polohemden',
        state: 'completed'
    });

    assert.deepEqual(presentation, {
        displayKey: 'catalog-search-category-99',
        language: 'en',
        label: 'Retrieved products in T-Shirts & Polohemden'
    });
});

test('does not fall back to hard-coded activity copy when metadata is invalid', () => {
    const presentation = createToolActivityPresentation({
        toolName: 'searchProducts',
        args: {
            activityPresentation: {
                language: 'ja',
                runningLabel: 'searchProducts を実行中',
                completedLabel: 'https://internal.example.test/',
                failedLabel: 'x'
            }
        },
        state: 'running'
    });

    assert.deepEqual(presentation, {
        displayKey: 'catalog-search-store',
        language: 'ja'
    });
});

test('removes presentation metadata before the commerce tool executes', () => {
    assert.deepEqual(withoutToolActivityPresentation({
        query: 'shirts',
        activityPresentation: { language: 'en', runningLabel: 'Searching products' },
        activity_presentation: { language: 'fr', runningLabel: 'Recherche de produits' }
    }), { query: 'shirts' });
});
