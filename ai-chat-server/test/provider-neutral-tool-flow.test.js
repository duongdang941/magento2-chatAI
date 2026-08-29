import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createProviderNeutralToolFlow
} from '../services/orchestration/provider-neutral-tool-flow.js';
import {
    FINAL_SYNTHESIS_INSTRUCTION,
    isFinalSynthesisTurn
} from '../services/orchestration/tool-rounds.js';
import { CATALOG_AGENT_GUIDANCE } from '../services/catalog/catalog-agent-guidance.js';

test('uses the same initial catalogue policy regardless of provider protocol', () => {
    for (const provider of ['gemini', 'openai', 'cockpit', 'openrouter', '9router']) {
        const flow = createProviderNeutralToolFlow({
            provider,
            currentUserMessage: { text: 'Tôi muốn mua một chiếc áo.' }
        });
        // Tool selection is semantic model work. The shared gateway flow must
        // not infer shopping intent (or force a tool) from the shopper text.
        assert.equal(flow.shouldForceProductSearch(), false, provider);
    }
});

test('turns a body-fit profile into a verified size-constrained product search', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: {
            text: 'Toi cao 1m6 va nang 90 kg cua hang co ao khoac nao phu hop voi ngoai hinh cua toi khong?'
        },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'listCategories') {
                    return { data: [{ id: 101, name: 'Jacken & Westen', product_count: 5, parent_id: 2, level: 3 }] };
                }
                if (name === 'listVariantAttributes') {
                    return { data: [{ code: 'size', label: 'Größe', values: ['XL', 'XXL', '3XL'] }] };
                }
                return {
                    data: [{
                        id: 311,
                        sku: '022.F001',
                        name: 'Softshelljacke bestickt',
                        variant_options: [{ code: 'size', label: 'Größe', values: ['XXL', '3XL'] }]
                    }],
                    html: '<div class="product-card">Softshelljacke</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });

    const unconstrained = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'ao khoac',
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Toi', 'cua hang'],
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Dang tim san pham {scope}',
                completedLabel: 'Da tim xong san pham {scope}',
                failedLabel: 'Khong the tim san pham {scope}',
                runningSummary: 'Dang xu ly trong {duration}',
                completedSummary: 'Da xu ly trong {duration}',
                searchScope: 'trong toan bo cua hang'
            }
        }
    });

    assert.equal(unconstrained.blocked, true);
    assert.equal(unconstrained.outcome.content.reason, 'body_fit_size_constraint_required');
    assert.equal(unconstrained.visibleProducts, false);
    assert.deepEqual(calls, []);

    const categories = await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery',
            requiresVariantAttribute: true,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Toi', 'cua hang']
        }
    });
    assert.equal(categories.blocked, false);

    const attributes = await flow.execute({
        name: 'listVariantAttributes',
        args: { categoryId: 101, responseLanguage: 'vi', responseLanguageEvidence: ['Toi', 'cua hang'] }
    });
    assert.equal(attributes.blocked, false);
    assert.equal(flow.shouldForceProductSearch(), true);

    const wrongBodyFitConstraint = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'ao khoac', catalogIntent: 'product_search', categoryId: 101, exactIdentity: false, requiresVariantAttribute: true,
            requiredVariantAttributeCode: 'size', requiredVariantOptionValues: ['XL'],
            responseLanguage: 'vi', responseLanguageEvidence: ['Toi', 'cua hang'],
            activityPresentation: {
                language: 'vi', runningLabel: 'Dang tim san pham {scope}', completedLabel: 'Da tim xong san pham {scope}', failedLabel: 'Khong the tim san pham {scope}',
                runningSummary: 'Dang xu ly trong {duration}', completedSummary: 'Da xu ly trong {duration}', searchScope: 'trong danh muc {category}'
            }
        }
    });
    assert.equal(wrongBodyFitConstraint.blocked, true);
    assert.equal(wrongBodyFitConstraint.outcome.content.reason, 'body_fit_verified_size_constraint_required');
    assert.deepEqual(calls.map(call => call.name), ['listCategories', 'listVariantAttributes']);

    const constrained = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'ao khoac', catalogIntent: 'product_search', categoryId: 101, exactIdentity: false, requiresVariantAttribute: true,
            requiredVariantAttributeCode: 'size', requiredVariantOptionValues: ['XXL', '3XL'],
            responseLanguage: 'vi', responseLanguageEvidence: ['Toi', 'cua hang'],
            activityPresentation: {
                language: 'vi', runningLabel: 'Dang tim san pham {scope}', completedLabel: 'Da tim xong san pham {scope}', failedLabel: 'Khong the tim san pham {scope}',
                runningSummary: 'Dang xu ly trong {duration}', completedSummary: 'Da xu ly trong {duration}', searchScope: 'trong danh muc {category}'
            }
        }
    });
    assert.equal(constrained.blocked, false);
    assert.equal(constrained.visibleProducts, true);
    assert.equal(flow.shouldForceProductSearch(), false);
    assert.deepEqual(calls.map(call => call.name), ['listCategories', 'listVariantAttributes', 'searchProducts']);
    assert.equal(calls.at(-1).args.requiredVariantAttributeCode, 'size');
    assert.deepEqual(calls.at(-1).args.requiredVariantOptionValues, ['XXL', '3XL']);
});

test('forces the final Magento search after verified variant-attribute discovery', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'openai',
        currentUserMessage: { text: 'Show me a blue T-shirt.' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'listCategories') {
                    return { data: [{ id: 12, parent_id: 2, level: 3, name: 'T-Shirts', product_count: 4 }] };
                }
                if (name === 'listVariantAttributes') {
                    return { data: [{ code: 'color', label: 'Color', values: ['blue', 'red'] }] };
                }
                if (name === 'searchProducts') {
                    return {
                        data: [{ id: 12, sku: 'SHIRT-BLUE', name: 'Blue T-shirt' }],
                        html: '<div class="product-card">Blue T-shirt</div>',
                        meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                    };
                }
                throw new Error(`Unexpected tool ${name}`);
            }
        }
    });

    await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery',
            requiresVariantAttribute: true,
            responseLanguage: 'en',
            responseLanguageEvidence: ['Show', 'me', 'blue']
        }
    });
    await flow.execute({
        name: 'listVariantAttributes',
        args: {
            categoryId: 12,
            responseLanguage: 'en',
            responseLanguageEvidence: ['Show', 'me', 'blue']
        }
    });

    assert.equal(flow.shouldForceProductSearch(), true);

    const search = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'T-shirt',
            catalogIntent: 'product_search',
            exactIdentity: false,
            requiresVariantAttribute: true,
            requiredVariantAttributeCode: 'color',
            requiredVariantOptionValues: ['blue'],
            responseLanguage: 'en',
            responseLanguageEvidence: ['Show', 'me', 'blue'],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Looking up products',
                completedLabel: 'Finished looking up products',
                failedLabel: 'Could not look up products',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}',
                searchScope: 'in the store'
            }
        }
    });

    assert.equal(search.blocked, false);
    assert.equal(search.visibleProducts, true);
    assert.equal(flow.shouldForceProductSearch(), false);
    assert.deepEqual(calls.map(call => call.name), ['listCategories', 'listVariantAttributes', 'searchProducts']);
});

test('defers category discovery for a product request until a product search has run', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Muéstrame artículos de esta categoría.' }
    });

    const result = await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery',
            responseLanguage: 'es-MX',
            responseLanguageEvidence: ['Muéstrame', 'artículos'],
            activityPresentation: {
                language: 'es-MX',
                runningLabel: 'Revisando categorías de productos',
                completedLabel: 'Categorías de productos revisadas',
                failedLabel: 'No se pudieron revisar las categorías',
                runningSummary: 'Procesando durante {duration}',
                completedSummary: 'Proceso completado en {duration}'
            }
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'catalog_product_search_required');
    assert.match(result.modelContext.instruction, /call searchProducts first/i);
    assert.deepEqual(frames, []);
});

test('requires a verified category scope after zero-result taxonomy discovery', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Cho toi 1 vai san pham trong Dụng cụ viết' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'searchProducts' && !args.categoryId) {
                    return {
                        data: [],
                        html: '',
                        meta: { pagination: { total: 0, page: 1, page_size: 5, returned: 0, has_more: false } }
                    };
                }
                if (name === 'listCategories') {
                    return {
                        data: [{ id: 93, parent_id: 92, level: 3, name: 'Schreibgeräte', product_count: 8 }]
                    };
                }
                if (name === 'searchProducts' && args.categoryId === 93) {
                    return {
                        data: [{ id: 1, sku: 'N021.F101', name: 'Bleistift' }],
                        html: '<div class="product-card">Bleistift</div>',
                        meta: {
                            pagination: { total: 8, page: 1, page_size: 5, returned: 1, has_more: true },
                            scope: { category_id: 93, category_name: 'Schreibgeräte' }
                        }
                    };
                }
                throw new Error(`Unexpected tool ${name}`);
            }
        }
    });
    const productActivity = (searchScope) => ({
        language: 'vi',
        runningLabel: 'Đang tìm sản phẩm {scope}',
        completedLabel: 'Đã tìm xong sản phẩm {scope}',
        failedLabel: 'Không thể tìm sản phẩm {scope}',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope
    });

    const firstSearch = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Dụng cụ viết', catalogIntent: 'product_search', exactIdentity: false,
            responseLanguage: 'vi', responseLanguageEvidence: ['Cho toi', 'san pham'],
            activityPresentation: productActivity('trong cửa hàng')
        }
    });
    assert.equal(firstSearch.blocked, false);
    assert.equal(firstSearch.visibleProducts, false);
    assert.equal(flow.shouldForceProductSearch(), true);

    const repeatOriginalSearch = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Dụng cụ viết', catalogIntent: 'product_search', exactIdentity: false,
            responseLanguage: 'vi', responseLanguageEvidence: ['Cho toi', 'san pham'],
            activityPresentation: productActivity('trong cửa hàng')
        }
    });
    assert.equal(repeatOriginalSearch.blocked, true);
    assert.equal(repeatOriginalSearch.outcome.content.reason, 'catalog_query_refinement_required');

    const refinedSearch = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Schreibgeräte', catalogIntent: 'product_search', exactIdentity: false,
            responseLanguage: 'vi', responseLanguageEvidence: ['Cho toi', 'san pham'],
            activityPresentation: productActivity('trong cửa hàng')
        }
    });
    assert.equal(refinedSearch.blocked, false);
    assert.equal(refinedSearch.visibleProducts, false);
    assert.equal(flow.shouldForceProductSearch(), false);

    const categories = await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery', responseLanguage: 'vi', responseLanguageEvidence: ['Cho toi', 'san pham']
        }
    });
    assert.equal(categories.blocked, false);
    assert.equal(flow.getState().categoryScopeRequiredAfterDiscovery, true);

    const unscopedRetry = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Kugelschreiber', catalogIntent: 'product_search', exactIdentity: false,
            responseLanguage: 'vi', responseLanguageEvidence: ['Cho toi', 'san pham'],
            activityPresentation: productActivity('trong cửa hàng')
        }
    });
    assert.equal(unscopedRetry.blocked, true);
    assert.equal(unscopedRetry.outcome.content.reason, 'category_scope_required_after_discovery');
    assert.match(unscopedRetry.modelContext.instruction, /categoryId/i);
    assert.deepEqual(calls.map(call => call.name), ['searchProducts', 'searchProducts', 'listCategories']);

    const scopedRetry = await flow.execute({
        name: 'searchProducts',
        args: {
            query: '', categoryId: 93, catalogIntent: 'product_search', exactIdentity: false,
            responseLanguage: 'vi', responseLanguageEvidence: ['Cho toi', 'san pham'],
            activityPresentation: productActivity('trong danh mục {category}')
        }
    });
    assert.equal(scopedRetry.blocked, false);
    assert.equal(scopedRetry.visibleProducts, true);
    assert.deepEqual(calls.map(call => call.name), ['searchProducts', 'searchProducts', 'listCategories', 'searchProducts']);
    assert.equal(calls.at(-1).args.categoryId, 93);
    assert.equal(calls.at(-1).args.query, '');
});

test('finishes a general store overview from taxonomy without selecting an arbitrary product category', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Cửa hàng có những sản phẩm nào?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'listCategories') {
                    return {
                        data: [
                            { id: 101, name: 'Textilien', product_count: 29, parent_id: 2, level: 2 },
                            { id: 102, name: 'T-Shirts & Polohemden', product_count: 10, parent_id: 101, level: 3 }
                        ]
                    };
                }
                throw new Error(`Unexpected tool ${name}`);
            }
        }
    });

    const overview = await flow.execute({
        id: 'store-overview',
        name: 'listCategories',
        args: {
            lookupPurpose: 'taxonomy_question',
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Cửa hàng', 'sản phẩm nào']
        }
    });

    assert.equal(overview.blocked, false);
    assert.equal(overview.visibleProducts, false);
    assert.equal(overview.modelContext.categories.length, 2);
    assert.match(overview.modelContext.instruction, /general store overview/i);
    assert.equal(flow.getState().taxonomyOverviewResolved, true);

    const productSearch = await flow.execute({
        id: 'unwanted-category-search',
        name: 'searchProducts',
        args: {
            query: '',
            categoryId: 102,
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Cửa hàng', 'sản phẩm nào'],
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Đang tìm sản phẩm',
                completedLabel: 'Đã tìm xong sản phẩm',
                failedLabel: 'Không thể tìm sản phẩm',
                runningSummary: 'Đang xử lý trong {duration}',
                completedSummary: 'Đã xử lý trong {duration}',
                searchScope: 'trong danh mục {category}'
            }
        }
    });

    assert.equal(productSearch.blocked, true);
    assert.equal(productSearch.outcome.content.reason, 'taxonomy_overview_complete');
    assert.deepEqual(calls.map(call => call.name), ['listCategories']);
});

test('does not execute a product search that omits localized action metadata', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Cửa hàng có sản phẩm màu đen không?' }
    });

    const result = await flow.execute({
        id: 'missing-product-activity',
        name: 'searchProducts',
        args: {
            query: 'áo màu đen',
            catalogIntent: 'product_search',
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['cửa hàng có']
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'activity_presentation_required');
    assert.equal(frames.some(frame => frame.type === 'tool_activity'), false);
});

test('uses a structured whole-store sample without inventing a fallback search term', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Cho tôi xem vài sản phẩm hiện có trong cửa hàng.' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [{ id: 701, sku: 'SKU-701', name: 'Current product' }],
                    html: '<div class="product-card">Current product</div>',
                    meta: { pagination: { total: 1, total_is_verified: true, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });
    const activityPresentation = {
        language: 'vi',
        runningLabel: 'Đang chọn sản phẩm {scope}',
        completedLabel: 'Đã chọn sản phẩm {scope}',
        failedLabel: 'Không thể chọn sản phẩm {scope}',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trong toàn bộ cửa hàng'
    };

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: '',
            catalogIntent: 'store_sample',
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Cho tôi xem', 'hiện có', 'trong cửa hàng'],
            activityPresentation
        }
    });

    assert.equal(result.blocked, false);
    assert.equal(result.visibleProducts, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'searchProducts');
    assert.equal(calls[0].args.query, '');
    assert.equal(calls[0].args.browseAll, true);
    assert.equal(calls[0].args.exactIdentity, false);
    assert.equal(Object.hasOwn(calls[0].args, 'catalogIntent'), false);
});

test('rejects a filtered whole-store sample before Magento execution', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Cho tôi xem vài sản phẩm hiện có trong cửa hàng.' },
        options: { executeMagentoTool: async (...args) => calls.push(args) }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'fallback',
            catalogIntent: 'store_sample',
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Cho tôi xem', 'hiện có', 'trong cửa hàng'],
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Đang chọn sản phẩm {scope}',
                completedLabel: 'Đã chọn sản phẩm {scope}',
                failedLabel: 'Không thể chọn sản phẩm {scope}',
                runningSummary: 'Đang xử lý trong {duration}',
                completedSummary: 'Đã xử lý trong {duration}',
                searchScope: 'trong toàn bộ cửa hàng'
            }
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'store_sample_unfiltered_required');
    assert.deepEqual(calls, []);
});

test('rejects an empty unfiltered product search before it can pivot into a category', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Cho tôi xem vài sản phẩm hiện có trong cửa hàng.' },
        options: { executeMagentoTool: async (...args) => calls.push(args) }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: '',
            catalogIntent: 'product_search',
            exactIdentity: false,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Cho tôi xem', 'hiện có', 'trong cửa hàng'],
            activityPresentation: {
                language: 'vi',
                runningLabel: 'Đang tìm sản phẩm {scope}',
                completedLabel: 'Đã tìm sản phẩm {scope}',
                failedLabel: 'Không thể tìm sản phẩm {scope}',
                runningSummary: 'Đang xử lý trong {duration}',
                completedSummary: 'Đã xử lý trong {duration}',
                searchScope: 'trong toàn bộ cửa hàng'
            }
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'product_search_constraint_required');
    assert.deepEqual(calls, []);
});

test('keeps the model-selected language internally consistent without matching language text', async () => {
    const calls = [];
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'A shopper request in any language.' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return { data: [{ id: 11, name: 'Jacken & Westen', product_count: 5 }] };
            }
        }
    });
    const mismatchedPresentation = {
        language: 'de',
        runningLabel: 'Kategorie wird geprüft',
        completedLabel: 'Kategorie wurde geprüft',
        failedLabel: 'Kategorie konnte nicht geprüft werden',
        runningSummary: 'Bearbeitung seit {duration}',
        completedSummary: 'Bearbeitet in {duration}'
    };
    const blocked = await flow.execute({
        id: 'mixed-language-category',
        name: 'listCategories',
        args: {
            lookupPurpose: 'taxonomy_question',
            responseLanguage: 'en',
            activityPresentation: mismatchedPresentation
        }
    });

    assert.equal(blocked.blocked, true);
    assert.equal(blocked.outcome.content.reason, 'response_language_mismatch');
    assert.deepEqual(calls, []);
    assert.deepEqual(frames, []);

    const englishPresentation = {
        language: 'en-US',
        runningLabel: 'Looking up product categories',
        completedLabel: 'Finished looking up product categories',
        failedLabel: 'Could not look up product categories',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}'
    };
    const retried = await flow.execute({
        id: 'english-category-retry',
        name: 'listCategories',
        args: {
            lookupPurpose: 'taxonomy_question',
            responseLanguage: 'en',
            activityPresentation: englishPresentation
        }
    });

    assert.equal(retried.blocked, false);
    assert.deepEqual(calls.map(call => call.name), ['listCategories']);
    assert.equal(calls[0].args.activityPresentation, undefined);
    assert.deepEqual(
        frames.filter(frame => frame.type === 'tool_activity').map(frame => [frame.state, frame.language, frame.label]),
        [['running', 'en-US', 'Looking up product categories']]
    );

    const changedLanguage = await flow.execute({
        id: 'changed-language',
        name: 'listCategories',
        args: {
            lookupPurpose: 'taxonomy_question',
            responseLanguage: 'vi',
            activityPresentation: {
                ...englishPresentation,
                language: 'vi'
            }
        }
    });
    assert.equal(changedLanguage.blocked, true);
    assert.equal(changedLanguage.outcome.content.reason, 'response_language_mismatch');
    assert.deepEqual(calls.map(call => call.name), ['listCategories']);
});

test('requires a verified option value before executing an attribute-constrained product search', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Có áo màu đỏ không?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'searchProducts') return {
                    data: [{ id: 17, sku: 'shirt-blue', name: 'Blue shirt', url: 'https://shop.test/blue-shirt.html' }],
                    html: '<div class="product-card">Blue shirt</div>',
                    meta: {
                        pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false },
                        scope: { category_id: 101, category_name: 'Textilien' }
                    }
                };
                if (name === 'listCategories') return {
                    data: [{ id: 101, name: 'Textilien', product_count: 29, parent_id: 2, level: 2 }]
                };
                if (name === 'listVariantAttributes') return {
                    data: [{ code: 'farbe', label: 'Farbe', values: ['blau', 'schwarz', 'weiß'], sampled_product_count: 6 }],
                    meta: { scope: { category_id: 101, category_name: 'Textilien' } }
                };
                throw new Error(`Unexpected tool ${name}`);
            }
        }
    });

    const earlyDiscovery = await flow.execute({
        name: 'listVariantAttributes',
        args: { categoryId: 101, responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'] }
    });
    assert.equal(earlyDiscovery.blocked, true);
    assert.equal(earlyDiscovery.outcome.content.reason, 'catalog_product_search_required');

    const unstructuredSearch = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'áo màu đỏ', exactIdentity: false, requiresVariantAttribute: true, responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'],
            activityPresentation: {
                language: 'vi', runningLabel: 'Đang tìm sản phẩm', completedLabel: 'Đã tìm xong sản phẩm', failedLabel: 'Không thể tìm sản phẩm',
                runningSummary: 'Đang xử lý trong {duration}', completedSummary: 'Đã xử lý trong {duration}', searchScope: 'trong cửa hàng'
            }
        }
    });
    assert.equal(unstructuredSearch.blocked, true);
    assert.equal(unstructuredSearch.outcome.content.reason, 'variant_option_constraint_required');

    const categoryLookup = await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery',
            requiresVariantAttribute: true,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['Có áo màu đỏ']
        }
    });
    assert.equal(categoryLookup.blocked, false);
    const discovery = await flow.execute({
        name: 'listVariantAttributes',
        args: { categoryId: 101, responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'] }
    });

    assert.equal(discovery.blocked, false);
    assert.deepEqual(discovery.modelContext.attributes, [{
        code: 'farbe', label: 'Farbe', values: ['blau', 'schwarz', 'weiß'], sampled_product_count: 6
    }]);
    assert.match(discovery.modelContext.instruction, /not a product result/i);
    const constrainedSearch = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'áo', catalogIntent: 'product_search', categoryId: 101, exactIdentity: false, requiresVariantAttribute: true,
            requiredVariantAttributeCode: 'farbe', requiredVariantOptionValues: ['blau'],
            responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'],
            activityPresentation: {
                language: 'vi', runningLabel: 'Đang tìm sản phẩm {scope}', completedLabel: 'Đã tìm xong sản phẩm {scope}', failedLabel: 'Không thể tìm sản phẩm {scope}',
                runningSummary: 'Đang xử lý trong {duration}', completedSummary: 'Đã xử lý trong {duration}', searchScope: 'trong danh mục {category}'
            }
        }
    });
    assert.equal(constrainedSearch.blocked, false);
    assert.equal(constrainedSearch.modelContext.product_cards_rendered, true);
    assert.deepEqual(calls.map(call => call.name), ['listCategories', 'listVariantAttributes', 'searchProducts']);
    assert.deepEqual(calls.at(-1).args.requiredVariantOptionValues, ['blau']);
});

test('refreshes live availability after a configurable single-card follow-up without reopening category discovery', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'The no co size XXXL khong?' },
        options: {
            singleProductAnchor: { productRef: 'product:986', sku: 'N042.A104' },
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'getProductAvailability') {
                    return {
                        data: [{
                            sku: 'N042.A104',
                            product_type: 'configurable',
                            availability: 'in_stock',
                            matching_variants: 1,
                            available_variants: 1,
                            salable_qty: 4
                        }]
                    };
                }
                if (name !== 'searchProducts') throw new Error(`Unexpected tool ${name}`);
                return {
                    data: [{
                        id: 986,
                        sku: 'N042.A104',
                        name: 'T-Shirt "2. Wahl"',
                        variant_options: [{ code: 'size', label: 'Size', values: ['XL', '3XL'] }]
                    }],
                    html: '<div class="product-card">T-Shirt</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });
    const activityPresentation = {
        language: 'vi',
        runningLabel: 'Đang kiểm tra sản phẩm {scope}',
        completedLabel: 'Đã kiểm tra sản phẩm {scope}',
        failedLabel: 'Không thể kiểm tra sản phẩm {scope}',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trong toàn bộ cửa hàng'
    };

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'áo size XXXL',
            catalogIntent: 'product_search',
            exactIdentity: false,
            catalogContextDecision: 'follow_up',
            followUpProductRef: 'product:986',
            requiresVariantAttribute: true,
            responseLanguage: 'vi',
            responseLanguageEvidence: ['The', 'no co', 'khong'],
            activityPresentation
        }
    });

    assert.equal(result.blocked, false);
    assert.equal(result.modelContext.product_cards_rendered, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'searchProducts');
    assert.equal(calls[0].args.query, 'N042.A104');
    assert.equal(calls[0].args.exactIdentity, true);
    assert.equal(calls[0].args.exactSku, true);
    assert.equal(Object.hasOwn(calls[0].args, 'followUpProductRef'), false);
    assert.equal(Object.hasOwn(calls[0].args, 'requiresVariantAttribute'), false);
    assert.equal(flow.shouldForceProductAvailability(), true);

    const categoryAttempt = await flow.execute({
        name: 'listCategories',
        args: { lookupPurpose: 'product_discovery', responseLanguage: 'vi', responseLanguageEvidence: ['The', 'khong'] }
    });
    assert.equal(categoryAttempt.blocked, true);
    assert.equal(categoryAttempt.outcome.content.reason, 'product_availability_verification_required');
    assert.deepEqual(calls.map(call => call.name), ['searchProducts']);

    const availability = await flow.execute({
        name: 'getProductAvailability',
        args: { sku: 'UNTRUSTED-SKU', selectedOptions: { size: '3XL' } }
    });
    assert.equal(availability.blocked, false);
    assert.equal(calls[1].name, 'getProductAvailability');
    assert.equal(calls[1].args.sku, 'N042.A104');
    assert.deepEqual(calls[1].args.selectedOptions, { size: '3XL' });
    assert.equal(flow.shouldForceProductAvailability(), false);

    const categoryAttemptAfterAvailability = await flow.execute({
        name: 'listCategories',
        args: { lookupPurpose: 'product_discovery', responseLanguage: 'vi', responseLanguageEvidence: ['The', 'khong'] }
    });
    assert.equal(categoryAttemptAfterAvailability.blocked, true);
    assert.equal(categoryAttemptAfterAvailability.outcome.content.reason, 'catalog_identity_already_resolved');
    assert.deepEqual(calls.map(call => call.name), ['searchProducts', 'getProductAvailability']);
});

test('requires live availability after a one-card configurable search without a product anchor', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Does T-Shirt "2. Wahl" have size M?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'getProductAvailability') {
                    return {
                        data: [{
                            sku: 'N042.A104',
                            product_type: 'configurable',
                            availability: 'in_stock',
                            matching_variants: 1,
                            available_variants: 1
                        }]
                    };
                }
                if (name !== 'searchProducts') throw new Error(`Unexpected tool ${name}`);
                return {
                    data: [{
                        id: 986,
                        sku: 'N042.A104',
                        name: 'T-Shirt "2. Wahl"',
                        product_type: 'configurable',
                        requires_variant_selection: true,
                        variant_options: [{ code: 'size', label: 'Size', values: ['M', 'XL'] }]
                    }],
                    html: '<div class="product-card">T-Shirt</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });

    const search = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'T-Shirt "2. Wahl"',
            catalogIntent: 'product_search',
            responseLanguage: 'en',
            responseLanguageEvidence: ['Does', 'have', 'size'],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Checking product {scope}',
                completedLabel: 'Checked product {scope}',
                failedLabel: 'Could not check product {scope}',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}',
                searchScope: 'in the store'
            }
        }
    });

    assert.equal(search.blocked, false);
    assert.deepEqual(calls.map(call => call.name), ['searchProducts']);
    assert.equal(flow.shouldForceProductAvailability(), true);

    const availability = await flow.execute({
        name: 'getProductAvailability',
        args: { sku: 'UNTRUSTED-SKU', selectedOptions: { size: 'M' } }
    });
    assert.equal(availability.blocked, false);
    assert.deepEqual(calls.map(call => call.name), ['searchProducts', 'getProductAvailability']);
    assert.equal(calls[1].args.sku, 'N042.A104');
    assert.deepEqual(calls[1].args.selectedOptions, { size: 'M' });
    assert.equal(flow.shouldForceProductAvailability(), false);
});

test('uses Magento SKU equality only when the provider declares an exact SKU identity', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Bitte prüfe die SKU 021.X100.' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [{ id: 100, sku: '021.X100', name: 'Catalog product' }],
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: '021.X100',
            catalogIntent: 'product_search',
            exactIdentity: true,
            catalogIdentityKind: 'sku',
            responseLanguage: 'de',
            responseLanguageEvidence: ['Bitte', 'prüfe', 'die'],
            activityPresentation: {
                language: 'de',
                runningLabel: 'Produkt im Shop prüfen {scope}',
                completedLabel: 'Produkt im Shop geprüft {scope}',
                failedLabel: 'Produkt im Shop nicht geprüft {scope}',
                runningSummary: 'Bearbeitung seit {duration}',
                completedSummary: 'Bearbeitet in {duration}',
                searchScope: 'im gesamten Shop'
            }
        }
    });

    assert.equal(result.blocked, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.exactIdentity, true);
    assert.equal(calls[0].args.exactSku, true);
    assert.equal(Object.hasOwn(calls[0].args, 'catalogIdentityKind'), false);
});

test('does not let a model use the exact SKU path without exact identity metadata', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        currentUserMessage: { text: 'SKU 021.X100' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return { data: [] };
            }
        }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: '021.X100',
            catalogIntent: 'product_search',
            exactIdentity: false,
            catalogIdentityKind: 'sku',
            responseLanguage: 'en',
            responseLanguageEvidence: ['SKU'],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Looking up products {scope}',
                completedLabel: 'Finished looking up products {scope}',
                failedLabel: 'Could not look up products {scope}',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}',
                searchScope: 'in the store'
            }
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'sku_requires_exact_identity');
    assert.deepEqual(calls, []);
});

test('passes exactly two structured comparison identities to Magento without a one-product search', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'openai',
        currentUserMessage: { text: 'Compare the named football and calendar.' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [{
                        status: 'OK',
                        products: [
                            { sku: 'SKU-1', name: 'First product', price: '12.00 EUR' },
                            { sku: 'SKU-2', name: 'Second product', price: '4.50 EUR' }
                        ],
                        missing_skus: []
                    }]
                };
            }
        }
    });

    const result = await flow.execute({
        name: 'compareProducts',
        args: {
            identities: [
                { kind: 'product_name', value: 'First product' },
                { kind: 'product_name', value: 'Second product' }
            ],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Comparing product details',
                completedLabel: 'Compared product details',
                failedLabel: 'Could not compare product details',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}'
            }
        }
    });

    assert.equal(result.blocked, false);
    assert.deepEqual(calls, [{
        name: 'compareProducts',
        args: {
            identities: [
                { kind: 'product_name', value: 'First product' },
                { kind: 'product_name', value: 'Second product' }
            ]
        }
    }]);
    assert.equal(result.modelContext.comparison[0].products.length, 2);
});

test('fails closed when a single-card product search omits its semantic context decision', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'openai',
        currentUserMessage: { text: 'How much does it cost?' },
        options: {
            singleProductAnchor: { productRef: 'product:701', sku: 'SKU-701' },
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return { data: [{ id: 701, sku: 'SKU-701', name: 'Catalog item' }] };
            }
        }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'it price',
            exactIdentity: false,
            responseLanguage: 'en',
            responseLanguageEvidence: ['How', 'much', 'does', 'it', 'cost'],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Checking product details',
                completedLabel: 'Finished checking product details',
                failedLabel: 'Could not check product details',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}',
                searchScope: 'in the store'
            }
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'catalog_context_decision_required');
    assert.deepEqual(calls, []);
});

test('blocks a missing or mismatched structured follow-up reference before Magento', async () => {
    for (const followUpProductRef of ['', 'product:702']) {
        const calls = [];
        const flow = createProviderNeutralToolFlow({
            provider: 'anthropic',
            currentUserMessage: { text: 'Is it available?' },
            options: {
                singleProductAnchor: { productRef: 'product:701', sku: 'SKU-701' },
                executeMagentoTool: async (name, args) => {
                    calls.push({ name, args });
                    return { data: [] };
                }
            }
        });

        const result = await flow.execute({
            name: 'searchProducts',
            args: {
                query: 'available',
                exactIdentity: false,
                catalogContextDecision: 'follow_up',
                ...(followUpProductRef ? { followUpProductRef } : {}),
                responseLanguage: 'en',
                responseLanguageEvidence: ['Is', 'it', 'available']
            }
        });

        assert.equal(result.blocked, true, followUpProductRef || 'missing reference');
        assert.equal(result.outcome.content.reason, 'catalog_follow_up_reference_required');
        assert.deepEqual(calls, []);
    }
});

test('allows a declared new search beside an anchor without forwarding context controls', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Show me posters instead.' },
        options: {
            singleProductAnchor: { productRef: 'product:701', sku: 'SKU-701' },
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [{ id: 803, sku: 'POSTER-803', name: 'Poster' }],
                    html: '<div class="product-card">Poster</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'posters',
            catalogIntent: 'product_search',
            exactIdentity: false,
            catalogContextDecision: 'new_search',
            responseLanguage: 'en',
            responseLanguageEvidence: ['Show', 'me', 'instead'],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Looking up products',
                completedLabel: 'Finished looking up products',
                failedLabel: 'Could not look up products',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}',
                searchScope: 'in the store'
            }
        }
    });

    assert.equal(result.blocked, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.query, 'posters');
    assert.equal(calls[0].args.exactIdentity, false);
    assert.equal(Object.hasOwn(calls[0].args, 'catalogContextDecision'), false);
    assert.equal(Object.hasOwn(calls[0].args, 'followUpProductRef'), false);
});

test('refreshes an exact multi-card result set only with its opaque search reference', async () => {
    const anchor = {
        searchRef: 'search:0a1b2c3d4e5f6a7b8c9d0e1f',
        request: {
            query: 'printed items',
            categoryId: 17,
            minPrice: 2.5,
            priceCurrency: 'EUR',
            requiredVariantAttributeCode: 'farbe',
            requiredVariantOptionValues: ['schwarz']
        }
    };
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Looking up products {scope}',
        completedLabel: 'Finished looking up products {scope}',
        failedLabel: 'Could not look up products {scope}',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in {category}'
    };

    for (const followUpSearchRef of ['', 'search:ffffffffffffffffffffffff']) {
        const calls = [];
        const flow = createProviderNeutralToolFlow({
            provider: 'openai',
            currentUserMessage: { text: 'What is the current price range?' },
            options: {
                resultSetAnchor: anchor,
                executeMagentoTool: async (name, args) => {
                    calls.push({ name, args });
                    return { data: [] };
                }
            }
        });
        const result = await flow.execute({
            name: 'searchProducts',
            args: {
                query: 'unrelated products',
                catalogIntent: 'product_search',
                catalogIdentityKind: 'none',
                exactIdentity: false,
                catalogContextDecision: 'result_set_follow_up',
                ...(followUpSearchRef ? { followUpSearchRef } : {}),
                responseLanguage: 'en',
                responseLanguageEvidence: ['What', 'current', 'price', 'range'],
                activityPresentation
            }
        });
        assert.equal(result.blocked, true, followUpSearchRef || 'missing reference');
        assert.equal(result.outcome.content.reason, 'catalog_result_set_reference_required');
        assert.deepEqual(calls, []);
    }

    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'openai',
        currentUserMessage: { text: 'What is the current price range?' },
        options: {
            resultSetAnchor: anchor,
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [{ id: 701, sku: 'PRINT-701', name: 'Printed item' }],
                    html: '<div class="product-card">Printed item</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });
    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'unrelated products',
            catalogIntent: 'product_search',
            catalogIdentityKind: 'none',
            exactIdentity: false,
            catalogContextDecision: 'result_set_follow_up',
            followUpSearchRef: anchor.searchRef,
            responseLanguage: 'en',
            responseLanguageEvidence: ['What', 'current', 'price', 'range'],
            activityPresentation
        }
    });

    assert.equal(result.blocked, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.query, 'printed items');
    assert.equal(calls[0].args.categoryId, 17);
    assert.equal(calls[0].args.minPrice, 2.5);
    assert.equal(calls[0].args.priceCurrency, 'EUR');
    assert.equal(calls[0].args.requiredVariantAttributeCode, 'farbe');
    assert.deepEqual(calls[0].args.requiredVariantOptionValues, ['schwarz']);
    assert.equal(Object.hasOwn(calls[0].args, 'followUpSearchRef'), false);
    assert.equal(Object.hasOwn(calls[0].args, 'catalogContextDecision'), false);

    const newSearchCalls = [];
    const newSearchFlow = createProviderNeutralToolFlow({
        provider: 'openai',
        currentUserMessage: { text: 'Show me posters instead.' },
        options: {
            resultSetAnchor: anchor,
            executeMagentoTool: async (name, args) => {
                newSearchCalls.push({ name, args });
                return { data: [] };
            }
        }
    });
    const newSearch = await newSearchFlow.execute({
        name: 'searchProducts',
        args: {
            query: 'posters',
            catalogIntent: 'product_search',
            catalogIdentityKind: 'none',
            exactIdentity: false,
            catalogContextDecision: 'new_search',
            responseLanguage: 'en',
            responseLanguageEvidence: ['Show', 'me', 'posters'],
            activityPresentation: {
                ...activityPresentation,
                runningLabel: 'Looking up products {scope}',
                completedLabel: 'Finished looking up products {scope}',
                failedLabel: 'Could not look up products {scope}',
                searchScope: 'in the store'
            }
        }
    });
    assert.equal(newSearch.blocked, false);
    assert.equal(newSearchCalls[0].args.query, 'posters');
    assert.equal(newSearchCalls[0].args.categoryId, undefined);
});

test('keeps prose and cards on the same product result set within one shopper turn', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Are there inexpensive printed items?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [{ id: 11, sku: 'PRINT-LOW', name: 'Low-cost printed item', price: '1.00 EUR' }],
                    html: '<div class="product-card">Low-cost printed item</div>',
                    meta: { pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false } }
                };
            }
        }
    });
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Looking up products',
        completedLabel: 'Finished looking up products',
        failedLabel: 'Could not look up products',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };

    const first = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'printed items',
            catalogIntent: 'product_search',
            catalogIdentityKind: 'none',
            exactIdentity: false,
            responseLanguage: 'en',
            responseLanguageEvidence: ['Are', 'there', 'inexpensive'],
            activityPresentation
        }
    });
    assert.equal(first.blocked, false);
    assert.equal(first.visibleProducts, true);

    const replacementAttempt = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'flyers',
            catalogIntent: 'product_search',
            catalogIdentityKind: 'none',
            exactIdentity: false,
            responseLanguage: 'en',
            responseLanguageEvidence: ['Are', 'there', 'inexpensive'],
            activityPresentation
        }
    });

    assert.equal(replacementAttempt.blocked, true);
    assert.equal(replacementAttempt.outcome.content.reason, 'catalog_result_set_already_presented');
    assert.equal(replacementAttempt.visibleProducts, false);
    assert.deepEqual(calls.map(call => call.args.query), ['printed items']);
    assert.equal(flow.getState().hasVisibleProducts, true);
});

test('blocks clarification and multi-card follow-up references without a Magento search', async () => {
    const clarifyCalls = [];
    const clarifyFlow = createProviderNeutralToolFlow({
        currentUserMessage: { text: 'How much is that one?' },
        options: {
            singleProductAnchor: { productRef: 'product:701', sku: 'SKU-701' },
            executeMagentoTool: async (name, args) => {
                clarifyCalls.push({ name, args });
                return { data: [] };
            }
        }
    });
    const clarification = await clarifyFlow.execute({
        name: 'searchProducts',
        args: {
            query: '',
            exactIdentity: false,
            catalogContextDecision: 'clarify',
            responseLanguage: 'en',
            responseLanguageEvidence: ['How', 'much', 'that', 'one']
        }
    });
    assert.equal(clarification.blocked, true);
    assert.equal(clarification.outcome.content.reason, 'catalog_context_clarification_required');
    assert.deepEqual(clarifyCalls, []);

    const multiCardCalls = [];
    const multiCardFlow = createProviderNeutralToolFlow({
        currentUserMessage: { text: 'Is it available?' },
        options: {
            executeMagentoTool: async (name, args) => {
                multiCardCalls.push({ name, args });
                return { data: [] };
            }
        }
    });
    const multiCardReference = await multiCardFlow.execute({
        name: 'searchProducts',
        args: {
            query: 'it',
            exactIdentity: false,
            catalogContextDecision: 'follow_up',
            followUpProductRef: 'product:701',
            responseLanguage: 'en',
            responseLanguageEvidence: ['Is', 'it', 'available']
        }
    });
    assert.equal(multiCardReference.blocked, true);
    assert.equal(multiCardReference.outcome.content.reason, 'single_product_anchor_unavailable');
    assert.deepEqual(multiCardCalls, []);
});

test('does not render a replacement card after an anchored exact-identity miss', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        currentUserMessage: { text: 'Does it have another colour?' },
        options: {
            singleProductAnchor: { productRef: 'product:701', sku: 'SKU-701' },
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                return {
                    data: [],
                    meta: {
                        pagination: { total: 0, page: 1, page_size: 5, returned: 0, has_more: false },
                        scope: { exact_query_miss: true }
                    }
                };
            }
        }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'other colour',
            catalogIntent: 'product_search',
            exactIdentity: false,
            catalogContextDecision: 'follow_up',
            followUpProductRef: 'product:701',
            responseLanguage: 'en',
            responseLanguageEvidence: ['Does', 'it', 'have', 'another', 'colour'],
            activityPresentation: {
                language: 'en',
                runningLabel: 'Checking product details',
                completedLabel: 'Finished checking product details',
                failedLabel: 'Could not check product details',
                runningSummary: 'Working for {duration}',
                completedSummary: 'Worked for {duration}',
                searchScope: 'in the store'
            }
        }
    });

    assert.equal(result.blocked, false);
    assert.equal(result.visibleProducts, false);
    assert.equal(result.productPresentation, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.query, 'SKU-701');
    assert.equal(calls[0].args.exactIdentity, true);
    assert.equal(calls[0].args.exactSku, true);
});

test('keeps the original exact identity through a refinement and rejects a replacement card', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        currentUserMessage: { text: 'Is Feuerzeug "Mein Herz brennt..." available?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (calls.length === 1) {
                    return {
                        data: [],
                        meta: {
                            pagination: { total: 0, page: 1, page_size: 5, returned: 0, has_more: false },
                            scope: { exact_query_miss: true }
                        }
                    };
                }
                return {
                    data: [{ sku: '021.A201', name: 'Feuerzeug "Unser Herz brennt..."' }],
                    html: '<div class="product-card">replacement</div>',
                    meta: {
                        pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false },
                        scope: { exact_query_match: true }
                    }
                };
            }
        }
    });
    const activityPresentation = {
        language: 'en',
        runningLabel: 'Looking up products',
        completedLabel: 'Finished looking up products',
        failedLabel: 'Could not look up products',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}',
        searchScope: 'in the store'
    };
    const first = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Feuerzeug "Mein Herz brennt..."',
            catalogIntent: 'product_search',
            catalogIdentityKind: 'product_name',
            exactIdentity: true,
            responseLanguage: 'en',
            responseLanguageEvidence: ['Is', 'available'],
            activityPresentation
        }
    });
    assert.equal(first.visibleProducts, false);

    const refined = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Feuerzeug "Unser Herz brennt..."',
            catalogIntent: 'product_search',
            catalogIdentityKind: 'product_name',
            exactIdentity: true,
            responseLanguage: 'en',
            responseLanguageEvidence: ['Is', 'available'],
            activityPresentation
        }
    });

    assert.equal(refined.blocked, false);
    assert.equal(refined.visibleProducts, false);
    assert.equal(refined.productPresentation, null);
    assert.equal(refined.outcome.content.meta.scope.exact_query_miss, true);
    assert.equal(flow.getState().terminalCatalog, true);
    assert.equal(calls.length, 2);
});

test('does not let a model drop the hard option constraint after attribute discovery', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Có áo xanh dương không?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'listCategories') return {
                    data: [{ id: 101, name: 'Textilien', product_count: 29, parent_id: 2, level: 2 }]
                };
                if (name === 'listVariantAttributes') return {
                    data: [{ code: 'farbe', label: 'Farbe', values: ['blau', 'weiß'] }]
                };
                throw new Error(`Unexpected tool ${name}`);
            }
        }
    });

    await flow.execute({
        name: 'listCategories',
        args: { lookupPurpose: 'product_discovery', requiresVariantAttribute: true }
    });
    await flow.execute({ name: 'listVariantAttributes', args: { categoryId: 101 } });
    const droppedConstraint = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'T-Shirt', categoryId: 101, exactIdentity: false,
            activityPresentation: {
                language: 'vi', runningLabel: 'Đang tìm {scope}', completedLabel: 'Đã tìm xong {scope}', failedLabel: 'Không thể tìm {scope}',
                runningSummary: 'Đang xử lý trong {duration}', completedSummary: 'Đã xử lý trong {duration}', searchScope: 'trong danh mục {category}'
            }
        }
    });

    assert.equal(droppedConstraint.blocked, true);
    assert.equal(droppedConstraint.outcome.content.reason, 'variant_option_constraint_required');
    assert.deepEqual(calls.map(call => call.name), ['listCategories', 'listVariantAttributes']);
});

test('uses one verified closest-product fallback when the requested attribute does not exist', async () => {
    const calls = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Có áo màu đỏ không?' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (name === 'listCategories') {
                    return {
                        data: [{ id: 101, name: 'Textilien', product_count: 29, parent_id: 2, level: 2 }]
                    };
                }
                if (name === 'listVariantAttributes') {
                    return {
                        data: [],
                        meta: { scope: { category_id: 101, category_name: 'Textilien' } }
                    };
                }
                if (name === 'searchProducts' && args.query === 'áo') {
                    return {
                        data: [{ id: 7, sku: 'shirt-blue', name: 'Áo xanh', url: 'https://shop.test/shirt-blue.html' }],
                        html: '<div class="product-card">Áo xanh</div>',
                        meta: {
                            pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false },
                            scope: { category_id: 101, category_name: 'Textilien' }
                        }
                    };
                }
                throw new Error(`Unexpected tool ${name}`);
            }
        }
    });
    const storeActivityPresentation = {
        language: 'vi',
        runningLabel: 'Đang tìm sản phẩm',
        completedLabel: 'Đã tìm xong sản phẩm',
        failedLabel: 'Không thể tìm sản phẩm',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trong toàn bộ cửa hàng'
    };
    const categoryActivityPresentation = {
        ...storeActivityPresentation,
        runningLabel: 'Đang tìm sản phẩm {scope}',
        completedLabel: 'Đã tìm xong sản phẩm {scope}',
        failedLabel: 'Không thể tìm sản phẩm {scope}',
        searchScope: 'trong danh mục {category}'
    };

    await flow.execute({
        name: 'listCategories',
        args: {
            lookupPurpose: 'product_discovery', requiresVariantAttribute: true,
            responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ']
        }
    });
    await flow.execute({
        name: 'listVariantAttributes',
        args: { categoryId: 101, responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'] }
    });

    const fallback = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'áo', catalogIntent: 'product_search', categoryId: 101, exactIdentity: false, similarityFallback: true,
            responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'], activityPresentation: categoryActivityPresentation
        }
    });

    assert.equal(fallback.blocked, false);
    assert.equal(fallback.modelContext.similarity_fallback, true);
    assert.equal(fallback.modelContext.verified_alternatives, true);
    assert.equal(fallback.modelContext.product_cards_rendered, true);
    assert.match(fallback.modelContext.instruction, /product cards.*already rendered separately/i);
    assert.match(fallback.modelContext.instruction, /do not enumerate names, prices, URLs, SKUs/i);
    assert.deepEqual(calls.map(call => call.name), [
        'listCategories', 'listVariantAttributes', 'searchProducts'
    ]);
    assert.equal(calls.at(-1).args.query, 'áo');
    assert.equal(calls.at(-1).args.categoryId, 101);

    const repeatFallback = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'áo', categoryId: 101, exactIdentity: false, similarityFallback: true,
            responseLanguage: 'vi', responseLanguageEvidence: ['Có áo màu đỏ'], activityPresentation: categoryActivityPresentation
        }
    });
    assert.equal(repeatFallback.blocked, true);
    assert.equal(repeatFallback.outcome.content.reason, 'similarity_fallback_complete');
    assert.equal(calls.length, 3);
});

test('reserves one tool-free synthesis turn after the tool-round budget', () => {
    assert.equal(isFinalSynthesisTurn(7, 8), false);
    assert.equal(isFinalSynthesisTurn(8, 8), true);
    assert.equal(isFinalSynthesisTurn(8, 8, true), false);
    assert.equal(isFinalSynthesisTurn(9, 8), true);
});

test('final synthesis forbids plan-only customer prose after tools complete', () => {
    assert.match(FINAL_SYNTHESIS_INSTRUCTION, /Tool execution is complete/i);
    assert.match(FINAL_SYNTHESIS_INSTRUCTION, /Do not say that you will check, search, look up, refine, or inspect/i);
    assert.match(FINAL_SYNTHESIS_INSTRUCTION, /shopper\'s language/i);
});

test('requires product-page selection instead of collecting options in chat', () => {
    assert.match(CATALOG_AGENT_GUIDANCE, /must be configured only on its returned product page/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /do not list, ask for, accept, or verify options in chat/i);
    assert.match(CATALOG_AGENT_GUIDANCE, /only when the current Magento result says direct_addable=true/i);
});

test('keeps an unverified human-support reply focused on the verification card', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Toi muon lien he voi nhan vien ho tro' }
    });

    const result = await flow.execute({
        name: 'handoffToHuman',
        args: {}
    });

    assert.equal(result.outcome.content.reason, 'guest_access_required');
    assert.match(result.modelContext.instruction, /complete the verification form below/i);
    assert.match(result.modelContext.instruction, /do not discuss unrelated products/i);
    assert.match(result.modelContext.instruction, /do not ask for the email or code in prose/i);
});

test('keeps an unavailable provider capability non-blocking for normal chat', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Hãy tạo một hình minh hoạ.' }
    });
    const result = await flow.execute({
        id: 'image-call',
        name: 'generateImage',
        args: { prompt: 'A product illustration' }
    });

    assert.equal(result.error, '');
    assert.notEqual(result.outcome.content.status, 'error');
    assert.ok(result.modelContext.instruction || result.modelContext.message);
});

test('does not mark an image SVG fallback as completed before an image exists', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: '9router',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Tạo hình ảnh chú chó.' },
        config: {
            provider: '9router',
            api_key: 'test-key',
            api_format: 'openai-chat-completions',
            model: 'chat-only',
            models: [{ id: 'chat-only', capabilities: { image_generation: true } }],
            image_generation: { enabled: true }
        }
    });
    const presentation = {
        language: 'vi',
        runningLabel: 'Đang tạo hình ảnh chú chó',
        completedLabel: 'Đã hoàn thành tạo hình ảnh chú chó',
        failedLabel: 'Không thể tạo hình ảnh chú chó',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}'
    };

    const result = await flow.execute({
        id: 'native-image-attempt',
        name: 'generateImage',
        args: { prompt: 'Một chú chó dễ thương', activityPresentation: presentation }
    });

    assert.equal(result.outcome.content.status, 'svg_fallback_required');
    assert.deepEqual(
        frames.filter(frame => frame.type === 'tool_activity').map(frame => [frame.state, frame.label]),
        [['running', 'Đang tạo hình ảnh chú chó']]
    );

    // A provider that fails to perform the invisible SVG retry must not leave
    // a success label behind. A successful retry reuses this action key and
    // replaces the deferred outcome before this terminal flush.
    assert.equal(flow.completePendingActivity(), true);
    assert.deepEqual(
        frames.filter(frame => frame.type === 'tool_activity').map(frame => [frame.state, frame.label]),
        [
            ['running', 'Đang tạo hình ảnh chú chó'],
            ['failed', 'Không thể tạo hình ảnh chú chó']
        ]
    );
});

test('uses model-localized activity labels without passing presentation metadata to commerce', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Muéstrame una camiseta.' },
        options: {
            requestBrowserCart: async () => ({ status: 'success', cart_type: 'checkout' })
        }
    });

    const result = await flow.execute({
        id: 'localized-cart-action',
        name: 'addToCart',
        args: {
            sku: 'SHIRT-1',
            activityPresentation: {
                language: 'es-MX',
                runningLabel: 'Actualizando tu carrito',
                completedLabel: 'Carrito actualizado',
                failedLabel: 'No se pudo actualizar el carrito',
                runningSummary: 'Procesando durante {duration}',
                completedSummary: 'Proceso completado en {duration}'
            }
        }
    });

    let activities = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(activities.map(({ state, label, language, turn_summary }) => ({ state, label, language, turn_summary })), [
        {
            state: 'running',
            label: 'Actualizando tu carrito',
            language: 'es-MX',
            turn_summary: 'Procesando durante {duration}'
        }
    ]);

    // A completed tool result remains the active action while the model is
    // deciding whether it needs another tool. The gateway exposes completion
    // only when the next action begins or this turn reaches its terminal frame.
    assert.equal(flow.completePendingActivity(), true);
    activities = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(activities.map(({ state, label, language, turn_summary }) => ({ state, label, language, turn_summary })), [
        {
            state: 'running',
            label: 'Actualizando tu carrito',
            language: 'es-MX',
            turn_summary: 'Procesando durante {duration}'
        },
        {
            state: 'completed',
            label: 'Carrito actualizado',
            language: 'es-MX',
            turn_summary: 'Proceso completado en {duration}'
        }
    ]);
    assert.equal(Object.hasOwn(result.outcome, 'activityPresentation'), false);
});

test('completes action A only when the next serial action starts', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Add two distinct products to my cart.' },
        options: {
            requestBrowserCart: async () => ({ status: 'success', cart_type: 'checkout' })
        }
    });
    const presentation = {
        language: 'en',
        runningLabel: 'Updating your cart',
        completedLabel: 'Cart updated',
        failedLabel: 'Could not update your cart',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}'
    };

    await flow.execute({
        id: 'action-a',
        name: 'addToCart',
        args: { sku: 'FIRST-SKU', activityPresentation: presentation }
    });
    assert.deepEqual(frames.map(frame => [frame.activity_id, frame.state]), [
        ['tool-action-a', 'running']
    ]);

    await flow.execute({
        id: 'action-b',
        name: 'addToCart',
        args: { sku: 'SECOND-SKU', activityPresentation: presentation }
    });
    assert.deepEqual(frames.map(frame => [frame.activity_id, frame.state]), [
        ['tool-action-a', 'running'],
        ['tool-action-a', 'completed'],
        ['tool-action-b', 'running']
    ]);

    flow.completePendingActivity();
    assert.deepEqual(frames.map(frame => [frame.activity_id, frame.state]), [
        ['tool-action-a', 'running'],
        ['tool-action-a', 'completed'],
        ['tool-action-b', 'running'],
        ['tool-action-b', 'completed']
    ]);
});

test('keeps consecutive catalogue refinements in one timeline action without comparing labels', async () => {
    const frames = [];
    let searchAttempt = 0;
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Cửa hàng có áo màu đỏ không?' },
        options: {
            executeMagentoTool: async (name) => {
                assert.equal(name, 'searchProducts');
                searchAttempt += 1;
                return searchAttempt === 1
                    ? { data: [], meta: { pagination: { total: 0 } } }
                    : { data: [{ sku: 'RED-SHIRT' }], meta: { pagination: { total: 1 } } };
            }
        }
    });
    const presentation = {
        language: 'vi',
        runningLabel: 'Đang tìm kiếm sản phẩm trên toàn bộ cửa hàng',
        completedLabel: 'Đã tìm kiếm sản phẩm trên toàn bộ cửa hàng',
        failedLabel: 'Không thể tìm kiếm sản phẩm trên toàn bộ cửa hàng',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trên toàn bộ cửa hàng'
    };

    await flow.execute({
        id: 'store-search-first',
        name: 'searchProducts',
        args: { query: 'áo màu đỏ', catalogIntent: 'product_search', exactIdentity: false, activityPresentation: presentation }
    });
    await flow.execute({
        id: 'store-search-refined',
        name: 'searchProducts',
        args: { query: 'áo đỏ', catalogIntent: 'product_search', exactIdentity: false, activityPresentation: presentation }
    });

    assert.deepEqual(
        frames.map(frame => [frame.activity_id, frame.state, frame.timeline_key]),
        [
            ['tool-store-search-first', 'running', 'timeline-catalog-search-store'],
            ['tool-store-search-refined', 'running', 'timeline-catalog-search-store']
        ]
    );

    flow.completePendingActivity();
    assert.deepEqual(
        frames.map(frame => [frame.activity_id, frame.state, frame.timeline_key]),
        [
            ['tool-store-search-first', 'running', 'timeline-catalog-search-store'],
            ['tool-store-search-refined', 'running', 'timeline-catalog-search-store'],
            ['tool-store-search-refined', 'completed', 'timeline-catalog-search-store']
        ]
    );
});

test('blocks a repeated semantic operation before it can create a second action', async () => {
    const frames = [];
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        ws: { send: frame => frames.push(JSON.parse(frame)) },
        currentUserMessage: { text: 'Add the same product.' },
        options: {
            requestBrowserCart: async () => ({ status: 'success', cart_type: 'checkout' })
        }
    });
    const firstPresentation = {
        language: 'en',
        runningLabel: 'Updating cart',
        completedLabel: 'Cart updated',
        failedLabel: 'Cart update failed',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}'
    };
    const secondPresentation = {
        language: 'en-GB',
        runningLabel: 'Updating the shopping cart',
        completedLabel: 'Shopping cart updated',
        failedLabel: 'Could not update the shopping cart',
        runningSummary: 'Working for {duration}',
        completedSummary: 'Worked for {duration}'
    };

    const first = await flow.execute({
        id: 'cart-first',
        name: 'addToCart',
        args: { sku: 'SAME-SKU', responseLanguage: 'en', activityPresentation: firstPresentation }
    });
    const repeated = await flow.execute({
        id: 'cart-second',
        name: 'addToCart',
        args: { sku: 'SAME-SKU', responseLanguage: 'en-GB', activityPresentation: secondPresentation }
    });

    const activitiesBeforeFinalization = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(
        activitiesBeforeFinalization.map(frame => [frame.activity_id, frame.state]),
        [
            ['tool-cart-first', 'running']
        ]
    );
    assert.equal(first.blocked, false);
    assert.equal(repeated.blocked, true);
    assert.equal(repeated.outcome.content.reason, 'duplicate_tool_call');

    flow.completePendingActivity();
    const activities = frames.filter(frame => frame.type === 'tool_activity');
    assert.deepEqual(
        activities.map(frame => [frame.activity_id, frame.state]),
        [
            ['tool-cart-first', 'running'],
            ['tool-cart-first', 'completed']
        ]
    );
    assert.equal(activities[1].continuation_key, activities[0].continuation_key);
});

test('explains insufficient stock instead of inventing a product-page option requirement', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Thêm 200 Sonnenschirm vào giỏ hàng.' },
        options: {
            requestBrowserCart: async () => ({
                status: 'requires_customer_action',
                reason: 'insufficient_stock',
                requested_qty: 200,
                sku: '023.F101'
            })
        }
    });

    const result = await flow.execute({
        id: 'stock-limit-call',
        name: 'addToCart',
        args: { sku: '023.F101', qty: 200 }
    });

    assert.equal(result.outcome.content.reason, 'insufficient_stock');
    assert.match(result.modelContext.instruction, /exceeds the currently available salable quantity/i);
    assert.doesNotMatch(result.modelContext.instruction, /needs product-page configuration/i);
});

test('blocks a repeated add-to-cart call after product-page configuration is required', async () => {
    let browserCartRequests = 0;
    const productPageUrl = 'https://afd.test/t-shirt-hellblau-mit-wunsch-aufdruck-1-design.html';
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Thêm áo N022.A00 vào giỏ hàng.' },
        options: {
            requestBrowserCart: async () => {
                browserCartRequests += 1;
                return {
                    status: 'requires_customer_action',
                    reason: 'product_page_required',
                    product: 'T-Shirt mit Wunschaufdruck',
                    sku: 'N022.A00',
                    url: productPageUrl,
                    message: 'Please configure your design on the product page first.'
                };
            }
        }
    });

    const first = await flow.execute({
        id: 'product-page-first-call',
        name: 'addToCart',
        args: { sku: 'N022.A00', qty: 1 }
    });
    const retry = await flow.execute({
        id: 'product-page-retry-call',
        name: 'addToCart',
        args: { sku: 'N022.A00', qty: 1 }
    });

    assert.equal(browserCartRequests, 1);
    assert.equal(first.blocked, false);
    assert.equal(retry.blocked, true);
    assert.equal(retry.outcome.content.status, 'requires_customer_action');
    assert.equal(retry.outcome.content.reason, 'product_page_required');
    assert.equal(retry.outcome.content.sku, 'N022.A00');
    assert.equal(retry.outcome.content.url, productPageUrl);
    assert.equal(retry.outcome.content.blocked, true);
    assert.match(retry.modelContext.instruction, /Do not retry addToCart/i);
    assert.match(retry.modelContext.instruction, /only the returned product URL/i);
});

test('reconciles concurrent tool outcomes in model call order', () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Tìm áo.' }
    });
    const state = flow.reconcile([
        {
            outcome: {
                name: 'searchProducts',
                query: 'shirt',
                content: {
                    data: [{ name: 'Shirt', sku: 'SHIRT-1' }],
                    meta: { pagination: { total: 1 } }
                }
            },
            productPresentation: { type: 'products_html', html: '<div>shirt</div>' }
        },
        {
            outcome: {
                name: 'listCategories',
                content: { data: [] }
            }
        }
    ]);

    assert.equal(state.hasVisibleProducts, true);
    assert.equal(state.lastToolOutcome.name, 'listCategories');
    assert.equal(state.pendingProductPresentation.type, 'products_html');
});

test('allows one exact-identity catalogue-language refinement before a terminal miss', async () => {
    const calls = [];
    const activityPresentation = {
        language: 'vi',
        runningLabel: 'Đang tìm sản phẩm {scope}',
        completedLabel: 'Đã tìm xong sản phẩm {scope}',
        failedLabel: 'Không thể tìm sản phẩm {scope}',
        runningSummary: 'Đang xử lý trong {duration}',
        completedSummary: 'Đã xử lý trong {duration}',
        searchScope: 'trong toàn bộ cửa hàng'
    };
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Hãy tìm đúng quả bóng đá AfD trong cửa hàng.' },
        options: {
            executeMagentoTool: async (name, args) => {
                calls.push({ name, args });
                if (calls.length === 1) {
                    return {
                        data: [],
                        html: '',
                        meta: {
                            pagination: { total: 0, page: 1, page_size: 5, returned: 0, has_more: false },
                            scope: { exact_query_miss: true, catalog_language: 'de' }
                        }
                    };
                }
                return {
                    data: [{
                        id: 3653,
                        sku: '021.J201',
                        name: 'Fußball "AfD"',
                        price: '12,00 €',
                        quantity_prices: [{ minimum_qty: 1, price: '12,00 €' }]
                    }],
                    html: '<div class="product-card">Fußball</div>',
                    meta: {
                        pagination: { total: 1, page: 1, page_size: 5, returned: 1, has_more: false },
                        scope: { exact_query_match: true }
                    }
                };
            }
        }
    });

    const first = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'quả bóng đá AfD',
            catalogIntent: 'product_search',
            exactIdentity: true,
            responseLanguage: 'vi',
            activityPresentation
        }
    });
    assert.equal(first.blocked, false);
    assert.equal(flow.getState().terminalCatalog, false);
    assert.equal(first.modelContext.catalog_query_language, 'de');
    assert.match(first.modelContext.instruction, /one more searchProducts call/i);

    const missingCatalogLanguage = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Fußball AfD',
            catalogIntent: 'product_search',
            exactIdentity: true,
            responseLanguage: 'vi',
            activityPresentation
        }
    });
    assert.equal(missingCatalogLanguage.blocked, true);
    assert.equal(missingCatalogLanguage.modelContext.reason, 'catalog_query_language_required');
    assert.equal(calls.length, 1);

    const second = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Fußball AfD',
            catalogIntent: 'product_search',
            exactIdentity: true,
            catalogQueryLanguage: 'de',
            responseLanguage: 'vi',
            activityPresentation
        }
    });
    assert.equal(second.blocked, false);
    assert.equal(second.visibleProducts, true);
    assert.equal(second.modelContext.products[0].sku, '021.J201');
    assert.deepEqual(second.modelContext.products[0].quantity_prices, [{ minimum_qty: 1, price: '12,00 €' }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args.catalogQueryLanguage, undefined);
    assert.equal(calls[1].args.catalog_query_language, undefined);
});

test('does not let an explicit exact identity be overwritten by a previous product anchor', async () => {
    const flow = createProviderNeutralToolFlow({
        provider: 'gemini',
        currentUserMessage: { text: 'Hãy tìm đúng Tisch-Querkalender 2026.' },
        options: {
            singleProductAnchor: { productRef: 'product:3653', sku: '021.J201' },
            executeMagentoTool: async () => {
                throw new Error('An exact-identity anchor conflict must not reach Magento.');
            }
        }
    });

    const result = await flow.execute({
        name: 'searchProducts',
        args: {
            query: 'Tisch-Querkalender 2026',
            catalogIntent: 'product_search',
            exactIdentity: true,
            catalogContextDecision: 'follow_up',
            followUpProductRef: 'product:3653',
            responseLanguage: 'vi'
        }
    });

    assert.equal(result.blocked, true);
    assert.equal(result.outcome.content.reason, 'exact_identity_requires_new_search');
});
