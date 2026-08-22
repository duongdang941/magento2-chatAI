const STORE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CUSTOMER_GROUP_ID = 2147483647;
const TENANT_ID_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Normalize only the scope carried by a Magento-signed WebSocket ticket.
 * Store/customer-group values from model tool arguments are never accepted.
 */
export function normalizeCatalogScope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const rawStoreCode = String(value.store_code ?? value.storeCode ?? '').trim();
    if (rawStoreCode !== '' && !STORE_CODE_PATTERN.test(rawStoreCode)) return null;
    const storeCode = STORE_CODE_PATTERN.test(rawStoreCode) ? rawStoreCode : '';
    const rawGroupId = Number(value.customer_group_id ?? value.customerGroupId ?? 0);
    if (!Number.isInteger(rawGroupId) || rawGroupId < 0 || rawGroupId > MAX_CUSTOMER_GROUP_ID) {
        return null;
    }
    const customerGroupId = Number.isInteger(rawGroupId)
        && rawGroupId >= 0
        && rawGroupId <= MAX_CUSTOMER_GROUP_ID
        ? rawGroupId
        : 0;
    const rawTenantId = String(value.tenant_id ?? value.tenantId ?? '').trim().toLowerCase();
    if (rawTenantId !== '' && !TENANT_ID_PATTERN.test(rawTenantId)) return null;
    const tenantId = TENANT_ID_PATTERN.test(rawTenantId) ? rawTenantId : '';

    if (!storeCode && customerGroupId === 0 && !tenantId) return null;

    return {
        storeCode,
        customerGroupId,
        ...(tenantId ? { tenantId } : {})
    };
}

/**
 * Build the only group input accepted by Magento catalogue REST tools.
 * A missing scope intentionally falls back to the public/guest price group
 * while preserving compatibility during a rolling gateway deployment.
 */
export function catalogScopeRequestParams(scope, customerId = 0) {
    const normalizedCustomerId = Math.max(0, Math.trunc(Number(customerId) || 0));
    return {
        customerGroupId: normalizeCatalogScope(scope)?.customerGroupId || 0,
        customerId: normalizedCustomerId
    };
}

/** Build a Magento REST URL that activates the store view before tool code runs. */
export function catalogRestUrl(magentoUrl, path, scope) {
    const baseUrl = String(magentoUrl || '').replace(/\/+$/, '');
    const storeCode = normalizeCatalogScope(scope)?.storeCode || '';
    const restPrefix = storeCode
        ? `/rest/${encodeURIComponent(storeCode)}/V1`
        : '/rest/V1';
    const endpoint = `/${String(path || '').replace(/^\/+/, '')}`;

    return `${baseUrl}${restPrefix}${endpoint}`;
}

/** Stable non-sensitive scope identity for cache keys. */
export function catalogScopeCacheIdentity(scope) {
    const normalized = normalizeCatalogScope(scope);

    return {
        store_code: normalized?.storeCode || '',
        customer_group_id: normalized?.customerGroupId || 0,
        ...(normalized?.tenantId ? { tenant_id: normalized.tenantId } : {})
    };
}
