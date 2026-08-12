const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Normalize Magento-signed current-page metadata before it reaches a model. */
export function normalizePageContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const type = String(value.type || '').toLowerCase();
    const name = String(value.name || '').trim().slice(0, 160);

    if (type === 'product') {
        const productId = Math.trunc(Number(value.product_id ?? value.productId) || 0);
        const sku = String(value.sku || '').trim();
        if (productId < 1 || !SKU_PATTERN.test(sku)) return null;
        return { type, productId, sku, name };
    }
    if (type === 'category') {
        const categoryId = Math.trunc(Number(value.category_id ?? value.categoryId) || 0);
        if (categoryId < 1) return null;
        return { type, categoryId, name };
    }
    return null;
}

export function pageContextInstruction(context) {
    if (!context) return '';
    if (context.type === 'product') {
        return `CURRENT MAGENTO PAGE (signed): product SKU ${context.sku}${context.name ? `, name ${JSON.stringify(context.name)}` : ''}. When the shopper says “this product” or an equivalent reference, use searchProducts with this SKU and exact identity before making catalogue claims.`;
    }
    return `CURRENT MAGENTO PAGE (signed): category ID ${context.categoryId}${context.name ? `, name ${JSON.stringify(context.name)}` : ''}. Use this category ID only as a catalogue-navigation hint and verify products with Magento tools.`;
}
