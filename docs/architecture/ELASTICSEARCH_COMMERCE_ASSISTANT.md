# Elasticsearch commerce assistant architecture

## Decision

Magento owns the commercial truth. Elasticsearch 7 is the catalogue read model, Magento MSI owns salable quantity, and the Node gateway owns tool orchestration, short-lived caching, conversation context, and provider adapters. The LLM never reads Magento tables or Elasticsearch directly.

```text
Customer → widget → Node gateway → LLM
                            ├─ searchProducts → Magento Fulltext Collection → Elasticsearch 7
                            ├─ getProductAvailability → Magento MSI / reservations
                            ├─ Redis catalog cache + single-flight
                            └─ addToCart → Magento quote API
Magento product/price/stock change → Magento indexer → Elasticsearch 7
```

This uses Magento's Fulltext Collection rather than constructing a private Elasticsearch query. Magento therefore retains responsibility for store scope, catalog visibility, price rules, and its `elasticsearch7` engine configuration. The active engine must be `catalog/search/engine = elasticsearch7` and the `catalogsearch_fulltext` indexer must be current.

## Tool contract

| Tool | Source of truth | Result | Cache |
| --- | --- | --- | --- |
| `searchProducts(query, filters)` | Magento Fulltext → Elasticsearch 7 | discoverable parent/simple products, product reference, price, variants summary | 60 seconds |
| `getProductAvailability(sku, size, color)` | Magento MSI salable quantity | live salability and exact variant quantity | 15 seconds |
| `addToCart(sku, qty)` | Magento quote | write operation; Magento validates stock again | never |

`searchProducts` never claims an exact quantity. `getProductAvailability` is required before answering “how many are left”, “is size M available”, or “does the product suggested above still exist”. For configurable products, quantity is only meaningful after the shopper selects a variant; quantities for different sizes/colors must never be summed.

## Conversation memory

Every displayed product card supplies a stable `product_ref`, `sku`, name, price, type, and available option labels. The browser serialises a compact `CATALOG_CONTEXT` back into model history. This lets the model resolve phrases such as “mẫu thứ hai”, “cái áo hồi nãy”, “áo đó còn M không”, and regional forms such as “cái ni”, “mẫu mô”, “áo nớ” without asking for a SKU again.

The context is advisory only. Price and stock replies still require a fresh Magento tool result.

## Redis behaviour

The gateway creates a canonical cache identity from query/filter parameters and a customer/guest scope. `getOrSetJsonCache` combines a JSON response cache with a distributed Redis lock, so concurrent misses for the same search generate one Magento request. It only caches read tools; errors and cart writes are never cached.

In production, invalidate catalogue cache keys after catalog/price/stock events when immediate freshness is required. The short TTL is a safe fallback when an event is missed. Elasticsearch also has internal caches, but its request cache does not remove the need for a gateway cache for full result hits.

## Operational checks

```bash
php bin/magento config:show catalog/search/engine
php bin/magento indexer:status catalogsearch_fulltext
php bin/magento indexer:reindex catalogsearch_fulltext
curl http://localhost:9200/_cat/indices?v
```

If Elasticsearch document count is far below current enabled catalog products, reindex before diagnosing AI relevance. A changed database with an old Elasticsearch index can return product IDs that no longer exist, causing Magento to present an empty result set.

## Public references reviewed

- Elastic recommends `search_as_you_type`/`bool_prefix` for an independent autocomplete index, but Magento's own fulltext mapping should remain the primary catalogue query in this module: <https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/search-as-you-type>
- Elasticsearch query cache is segment/filter based, so it complements gateway result caching rather than replacing it: <https://www.elastic.co/guide/en/elasticsearch/reference/current/query-cache.html>
- Elastic index aliases permit an atomic no-downtime reindex swap if a future dedicated AI catalogue index is introduced: <https://www.elastic.co/guide/en/elasticsearch/reference/current/aliases.html>
- OpenAI's tool-calling flow separates model intent from application-side data and actions; this is the boundary used by the Node gateway: <https://developers.openai.com/api/docs/guides/function-calling>
- The OpenAI Agents SDK and Vercel Chatbot are useful implementation references for tool tracing/session UI, while Saleor and Medusa are domain-boundary references. None should replace Magento for this storefront: <https://github.com/openai/openai-agents-js>, <https://github.com/vercel/chatbot>, <https://github.com/saleor/saleor>, <https://github.com/medusajs/medusa>.
