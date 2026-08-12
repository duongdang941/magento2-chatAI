const ORDER_NUMBER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeRecentOrdersArguments(args = {}) {
    const requestedLimit = Number(args.limit ?? 5);
    return {
        limit: Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(Math.trunc(requestedLimit), 10))
            : 5
    };
}

export function normalizeOrderDetailsArguments(args = {}) {
    return { orderNumber: normalizeOrderNumber(args.orderNumber || args.order_number) };
}

export function normalizeOrderAddressArguments(args = {}) {
    const source = args.address && typeof args.address === 'object' && !Array.isArray(args.address)
        ? args.address
        : {};
    const address = {};
    const fields = {
        prefix: 40,
        firstname: 64,
        middlename: 64,
        lastname: 64,
        suffix: 40,
        company: 128,
        city: 128,
        region: 128,
        postcode: 32,
        telephone: 64,
        fax: 64,
        vat_id: 64,
        email: 254
    };

    for (const [field, maxLength] of Object.entries(fields)) {
        if (Object.prototype.hasOwnProperty.call(source, field)) {
            address[field] = normalizeText(source[field], maxLength);
        }
    }

    const countryId = normalizeText(source.country_id ?? source.countryId, 2).toUpperCase();
    if (countryId) address.country_id = countryId;

    const rawRegionId = Number(source.region_id ?? source.regionId);
    if (Number.isFinite(rawRegionId) && rawRegionId > 0) {
        address.region_id = Math.trunc(rawRegionId);
    }

    if (Object.prototype.hasOwnProperty.call(source, 'street')) {
        const lines = Array.isArray(source.street)
            ? source.street
            : String(source.street || '').split(/\r?\n/);
        address.street = lines
            .slice(0, 4)
            .map((line) => normalizeText(line, 255))
            .filter(Boolean);
    }

    const requestedAddressType = String(args.addressType || args.address_type || '').trim().toLowerCase();
    return {
        orderNumber: normalizeOrderNumber(args.orderNumber || args.order_number),
        addressType: requestedAddressType === 'shipping' ? 'shipping' : (requestedAddressType === 'billing' ? 'billing' : ''),
        address
    };
}

export function normalizeCustomerAddressArguments(args = {}) {
    const normalized = normalizeOrderAddressArguments(args);
    return {
        addressType: normalized.addressType,
        address: normalized.address
    };
}

function normalizeOrderNumber(value) {
    const orderNumber = String(value || '').trim();
    return ORDER_NUMBER_PATTERN.test(orderNumber) ? orderNumber : '';
}

function normalizeText(value, maxLength) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}
