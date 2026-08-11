# Catalogue retrieval agent

## Problem solved

The previous implementation attempted to understand shoppers in PHP and Node with fixed lists of translated product words, category synonyms, colour names and sale terms. That is unsuitable for a reusable Magento module: a store can have any language, category tree and configurable attributes.

## Design

```text
Shopper message (any language)
        |
        v
AI model: understand intent + language
        |
        +--> listCategories() --------> actual Magento taxonomy + IDs
        |                                      |
        |                                      v
        +--> searchProducts(query, categoryId, minPrice, maxPrice)
        |                                      |
        |                                      v
        |                              visible, saleable products
        |
        +--> getProductAvailability(sku, selectedOptions)
                                               |
                                               v
                                       Magento MSI salable quantity
```

The model runs a bounded tool loop configured in Magento Admin. The quality-first default is `8` reasoning rounds, `15` total tool executions, and `3` category lookups; rounds are capped at `12` and executions at `30`. Identical tool calls can be blocked without consuming budget. The legacy `AI_MAX_CATALOG_TOOL_ROUNDS` environment variable remains only as a startup fallback before Magento pushes configuration. The agent may first search, inspect the category tree after a weak result, then browse the selected category by ID, and it may only state product facts returned by Magento.

## Responsibilities

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| AI provider | Interpret the shopper language, refine terms and decide the next tool call | Claim inventory without a tool result |
| Node gateway | Bound/validate tool arguments, execute the tool loop, stream status and response | Translate a fixed product dictionary |
| Magento `CatalogSearchTool` | Query the configured search engine or a verified category ID; enforce visibility, saleability and price filters | Infer intent from user text |
| Magento `ProductAvailabilityTool` | Read MSI availability and match configurable children by actual attribute codes | Assume `size`, `color`, `farbe` or any project-specific code |

## Generic configurable options

`searchProducts` returns `variant_options` in this form:

```json
[
  {
    "code": "material",
    "label": "Material",
    "values": ["Cotton", "Wool"]
  }
]
```

The agent sends the selected dimensions back as `selectedOptions`, for example `{"material":"Cotton"}`. The Node gateway serializes this for the Magento GET endpoint; Magento uses the returned attribute codes to select the correct child SKU. No code in the retrieval path depends on a particular store's labels or languages.

## Operational notes

- The active Magento search engine remains the source for free-text product search. Its index must be healthy.
- Browsing a category uses the category ID returned by `listCategories`; it remains available even if a full-text query has no match.
- A blank query without a verified category ID is deliberately rejected as an unbounded catalogue dump.
- After changing Web API signatures, run `bin/magento setup:di:compile`, flush cache and reload PHP-FPM in production.
