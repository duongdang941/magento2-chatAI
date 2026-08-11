import { issueAddressFormToken } from './address-form-token.js';

const ADDRESS_FIELDS = [
    'prefix',
    'firstname',
    'middlename',
    'lastname',
    'suffix',
    'company',
    'street',
    'city',
    'region',
    'region_id',
    'postcode',
    'country_id',
    'telephone',
    'fax',
    'vat_id',
    'email'
];

const EDITABLE_ADDRESS_FIELDS = new Set(ADDRESS_FIELDS.filter((field) => field !== 'email'));
const ORDER_ADDRESS_FORM_TTL_MS = 15 * 60 * 1000;

function normalizedText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * A form is appropriate only for an explicit edit request. Viewing an order or
 * its status must not expose address fields just because a details tool ran.
 */
export function isOrderAddressChangeRequest(value) {
    const text = normalizedText(value);
    if (!text) return false;

    return [
        /\b(?:doi|sua|cap nhat|thay)\b[\s\w]{0,36}\b(?:dia chi|shipping|billing)\b/,
        /\b(?:dia chi giao hang|dia chi thanh toan)\b[\s\w]{0,28}\b(?:doi|sua|cap nhat|thay)\b/,
        /\b(?:change|update|edit)\b[\s\w]{0,36}\b(?:shipping|billing|delivery)?\s*address\b/,
        /\b(?:shipping|billing|delivery)\s+address\b[\s\w]{0,28}\b(?:change|update|edit)\b/,
        /\b(?:liefer|rechnungs)adresse\b[\s\w]{0,28}\b(?:andern|aendern|aktualisieren)\b/
    ].some((pattern) => pattern.test(text));
}

export function isCustomerAddressRequest(value) {
    const text = normalizedText(value);
    if (!text) return false;

    const mentionsAddress = /\b(?:dia chi|billing|shipping|delivery|account address|lieferadresse|rechnungsadresse|adresse)\b/.test(text);
    const mentionsAccount = /\b(?:tai khoan|account|default|mac dinh|customer|cua toi|my|mein|meine)\b/.test(text);
    return mentionsAddress && mentionsAccount && !/\b(?:don hang|order|bestellung)\b/.test(text);
}

/**
 * Account-address data may be retrieved for both viewing and editing, but the
 * pre-filled form must be exposed only after an explicit change request.
 */
export function isCustomerAddressChangeRequest(value) {
    const text = normalizedText(value);
    if (!text || /\b(?:don hang|order|bestellung)\b/.test(text)) return false;

    return [
        /\b(?:doi|sua|cap nhat|thay)\b[\s\w]{0,36}\b(?:dia chi|shipping|billing)\b/,
        /\b(?:dia chi mac dinh|dia chi tai khoan|billing|shipping)\b[\s\w]{0,28}\b(?:doi|sua|cap nhat|thay)\b/,
        /\b(?:change|update|edit)\b[\s\w]{0,36}\b(?:default|account|shipping|billing)?\s*address\b/,
        /\b(?:default|account|shipping|billing)\s+address\b[\s\w]{0,28}\b(?:change|update|edit)\b/,
        /\b(?:liefer|rechnungs)adresse\b[\s\w]{0,28}\b(?:andern|aendern|aktualisieren)\b/
    ].some((pattern) => pattern.test(text));
}

export function buildCustomerAddressFormPayload(toolName, result, options = {}) {
    if (options.requestAddressForm !== true
        || toolName !== 'getCustomerAddresses'
        || result?.status !== 'success') {
        return null;
    }

    const rawAddresses = result.addresses && typeof result.addresses === 'object'
        ? result.addresses
        : {};
    const now = Date.now();

    const formId = `customer-address-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = now + ORDER_ADDRESS_FORM_TTL_MS;
    const actionToken = issueAddressFormToken({
        formId,
        resourceType: 'customer_account',
        customerId: options.customerId,
        conversationId: options.conversationId,
        expiresAt,
        addressTypes: ['billing', 'shipping']
    }, options.tokenSecret);
    if (!actionToken) return null;

    return {
        type: 'order_address_form',
        resource_type: 'customer_account',
        form_id: formId,
        action_token: actionToken,
        created_at: now,
        expires_at: expiresAt,
        access_scope: 'customer',
        order_number: '',
        addresses: {
            billing: normalizeAddress(rawAddresses.billing) || {},
            shipping: normalizeAddress(rawAddresses.shipping) || {}
        },
        address_types: ['billing', 'shipping'],
        address_type: 'shipping',
        fields: normalizeFormFields(result.address_form?.fields),
        countries: normalizeCountries(result.address_form?.countries),
        regions: normalizeRegions(result.address_form?.regions)
    };
}

/**
 * Restrict the client payload to Magento's standard order-address fields. The
 * returned form is bound to the guest-email verification deadline when one is
 * available, and is persisted only as a read-only historical snapshot after
 * that deadline.
 */
export function buildOrderAddressFormPayload(toolName, result, options = {}) {
    const scope = toolName === 'getGuestOrderDetails'
        ? 'guest'
        : (toolName === 'getOrderDetails' ? 'customer' : '');
    const order = result?.status === 'success' && result.order && typeof result.order === 'object'
        ? result.order
        : null;

    if (!scope || !order || order.address_change_allowed !== true) {
        return null;
    }

    const billing = normalizeAddress(order.billing_address);
    const shipping = normalizeAddress(order.shipping_address);
    const availableTypes = [
        ...(billing ? ['billing'] : []),
        ...(shipping ? ['shipping'] : [])
    ];
    const orderNumber = String(order.order_number || '').trim();
    if (!orderNumber || availableTypes.length === 0) {
        return null;
    }

    const now = Date.now();
    const verifiedAccessExpiresAt = normalizeTimestamp(
        options.accessExpiresAt || options.access_expires_at,
        0
    );
    // A guest address form must never outlive the verified-email access that
    // allowed Magento to return the address snapshot. Customer forms retain
    // their short UI lifetime because their session is authenticated directly.
    const expiresAt = scope === 'guest' && verifiedAccessExpiresAt > now
        ? Math.min(verifiedAccessExpiresAt, now + ORDER_ADDRESS_FORM_TTL_MS)
        : now + ORDER_ADDRESS_FORM_TTL_MS;

    const formId = `order-address-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const actionToken = issueAddressFormToken({
        formId,
        resourceType: 'order',
        customerId: options.customerId,
        sessionId: options.sessionId,
        conversationId: options.conversationId,
        orderNumber,
        expiresAt,
        addressTypes: availableTypes
    }, options.tokenSecret);
    if (!actionToken) return null;

    return {
        type: 'order_address_form',
        form_id: formId,
        action_token: actionToken,
        created_at: now,
        expires_at: expiresAt,
        access_scope: scope,
        order_number: orderNumber,
        addresses: { billing, shipping },
        address_types: availableTypes,
        address_type: availableTypes.includes('shipping') ? 'shipping' : 'billing',
        fields: normalizeFormFields(order.address_form?.fields),
        countries: normalizeCountries(order.address_form?.countries),
        regions: normalizeRegions(order.address_form?.regions)
    };
}

/**
 * Keep the durable message part deliberately narrow. The form is a visual
 * snapshot, never proof that the shopper may still alter an order: Magento
 * repeats ownership, shipment and guest-email checks on every submission.
 */
export function normalizeOrderAddressFormPart(value) {
    if (!value || typeof value !== 'object') return null;

    const formId = String(value.form_id || value.formId || '').trim().slice(0, 160);
    const orderNumber = String(value.order_number || value.orderNumber || '').trim().slice(0, 64);
    const resourceType = value.resource_type === 'customer_account' ? 'customer_account' : 'order';
    if (!formId || (resourceType === 'order' && !orderNumber)) return null;

    const rawAddresses = value.addresses && typeof value.addresses === 'object'
        ? value.addresses
        : {};
    const addresses = {
        billing: normalizeStoredAddress(rawAddresses.billing),
        shipping: normalizeStoredAddress(rawAddresses.shipping)
    };
    const addressTypes = (Array.isArray(value.address_types) ? value.address_types : [])
        .filter((type, index, source) => (
            ['billing', 'shipping'].includes(type)
            && addresses[type]
            && source.indexOf(type) === index
        ));
    if (addressTypes.length === 0) return null;

    const preferredType = String(value.address_type || '');
    const addressType = addressTypes.includes(preferredType)
        ? preferredType
        : (addressTypes.includes('shipping') ? 'shipping' : 'billing');
    const now = Date.now();
    const createdAt = normalizeTimestamp(value.created_at || value.createdAt, now);
    const expiresAt = Math.max(
        createdAt,
        normalizeTimestamp(value.expires_at || value.expiresAt, createdAt + ORDER_ADDRESS_FORM_TTL_MS)
    );
    const historyAddresses = expiresAt <= now
        ? Object.fromEntries(addressTypes.map((type) => [type, {}]))
        : addresses;

    return {
        type: 'order_address_form',
        form_id: formId,
        action_token: String(value.action_token || value.actionToken || '').slice(0, 2048),
        created_at: createdAt,
        expires_at: expiresAt,
        access_scope: value.access_scope === 'customer' ? 'customer' : 'guest',
        resource_type: resourceType,
        order_number: orderNumber,
        // Do not send an old customer address back to the browser after the
        // form expires. Keep only the field schema so history can display a
        // blank, locked form with its expiry overlay.
        addresses: historyAddresses,
        address_types: addressTypes,
        address_type: addressType,
        fields: normalizeFormFields(value.fields),
        countries: normalizeCountries(value.countries),
        regions: normalizeRegions(value.regions)
    };
}

function normalizeStoredAddress(value) {
    const address = normalizeAddress(value);
    if (!address) return null;

    // The checkout email is not an editable order-address field. It is also
    // unnecessary in a historical form, so do not retain it in chat storage.
    delete address.email;
    return address;
}

function normalizeTimestamp(value, fallback) {
    const timestamp = Math.floor(Number(value) || 0);
    return timestamp > 0 ? timestamp : fallback;
}

function normalizeAddress(value) {
    if (!value || typeof value !== 'object') return null;
    const address = {};

    for (const field of ADDRESS_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
        if (field === 'street') {
            address.street = Array.isArray(value.street)
                ? value.street.slice(0, 4).map((line) => String(line || '').slice(0, 255))
                : String(value.street || '').split(/\r?\n/).slice(0, 4);
            continue;
        }
        address[field] = field === 'region_id'
            ? Math.max(0, Number(value[field]) || 0)
            : (field === 'country_id'
                ? String(value[field] || '').trim().toUpperCase()
                : String(value[field] || ''));
    }

    return address;
}

function normalizeFormFields(value) {
    if (!Array.isArray(value)) return [];

    return value.reduce((fields, field) => {
        const code = String(field?.code || '').trim();
        if (!EDITABLE_ADDRESS_FIELDS.has(code)) return fields;

        fields.push({
            code,
            label: String(field?.label || code).slice(0, 120),
            input_type: ['text', 'multiline', 'select'].includes(String(field?.input_type || ''))
                ? String(field.input_type)
                : 'text',
            required: field?.required === true,
            line_count: code === 'street'
                ? Math.max(1, Math.min(Number(field?.line_count) || 1, 4))
                : 1
        });
        return fields;
    }, []);
}

function normalizeCountries(value) {
    if (!Array.isArray(value)) return [];

    return value.reduce((countries, country) => {
        const code = String(country?.value || '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code)) return countries;
        countries.push({
            value: code,
            label: String(country?.label || code).slice(0, 120),
            is_region_required: country?.is_region_required === true,
            is_zip_required: country?.is_zip_required !== false
        });
        return countries;
    }, []);
}

function normalizeRegions(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const regions = {};

    for (const [countryId, source] of Object.entries(value)) {
        const country = String(countryId || '').trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(source)) continue;
        const entries = source.reduce((items, region) => {
            const id = Math.max(0, Number(region?.id) || 0);
            const name = String(region?.name || '').trim().slice(0, 120);
            if (id < 1 || !name || items.some(item => item.id === id)) return items;
            items.push({
                id,
                code: String(region?.code || '').trim().slice(0, 32),
                name
            });
            return items;
        }, []);
        if (entries.length) regions[country] = entries;
    }

    return regions;
}
