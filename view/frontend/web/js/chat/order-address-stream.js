/**
 * Order-address form state and interaction methods.
 */
(function (modules) {
    'use strict';
    modules.orderAddressStreamMethods = function (context) {
        return {
            normalizeOrderAddressFormValue(source = {}) {
                const value = source && typeof source === 'object' ? source : {};
                const street = Array.isArray(value.street)
                    ? value.street
                    : String(value.street || '').split(/\r?\n/);
                return {
                    prefix: String(value.prefix || ''),
                    firstname: String(value.firstname || ''),
                    middlename: String(value.middlename || ''),
                    lastname: String(value.lastname || ''),
                    suffix: String(value.suffix || ''),
                    company: String(value.company || ''),
                    street: [0, 1, 2, 3].map(index => String(street[index] || '')),
                    city: String(value.city || ''),
                    region: String(value.region || ''),
                    region_id: Math.max(0, Number(value.region_id || value.regionId) || 0),
                    postcode: String(value.postcode || ''),
                    country_id: String(value.country_id || value.countryId || '').trim().toUpperCase(),
                    telephone: String(value.telephone || ''),
                    fax: String(value.fax || ''),
                    vat_id: String(value.vat_id || value.vatId || ''),
                    email: String(value.email || '')
                };
            },

            normalizeOrderAddressFormFields(fields = []) {
                const supported = new Set([
                    'prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company',
                    'street', 'city', 'region', 'postcode', 'country_id', 'telephone', 'fax', 'vat_id'
                ]);
                const normalized = Array.isArray(fields)
                    ? fields.reduce((result, field) => {
                        const code = String(field?.code || '').trim();
                        if (!supported.has(code) || result.some(item => item.code === code)) return result;
                        result.push({
                            code,
                            label: String(field?.label || code).slice(0, 120),
                            required: field?.required === true,
                            lineCount: code === 'street'
                                ? Math.max(1, Math.min(Number(field?.line_count) || 1, 4))
                                : 1
                        });
                        return result;
                    }, [])
                    : [];

                return normalized;
            },

            normalizeOrderAddressCountries(countries = []) {
                return Array.isArray(countries)
                    ? countries.reduce((result, country) => {
                        const value = String(country?.value || '').trim().toUpperCase();
                        if (!/^[A-Z]{2}$/.test(value) || result.some(item => item.value === value)) return result;
                        result.push({
                            value,
                            label: String(country?.label || value).slice(0, 120),
                            isRegionRequired: country?.is_region_required === true,
                            isZipRequired: country?.is_zip_required !== false
                        });
                        return result;
                    }, [])
                    : [];
            },

            normalizeOrderAddressRegions(regions = {}) {
                if (!regions || typeof regions !== 'object' || Array.isArray(regions)) return {};
                return Object.entries(regions).reduce((result, [countryId, source]) => {
                    const country = String(countryId || '').trim().toUpperCase();
                    if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(source)) return result;
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
                    if (entries.length) result[country] = entries;
                    return result;
                }, {});
            },

            orderAddressField(part, code) {
                return Array.isArray(part?.fields)
                    ? part.fields.find(field => field?.code === code) || null
                    : null;
            },

            orderAddressFieldVisible(part, code) {
                return Boolean(this.orderAddressField(part, code));
            },

            orderAddressFieldRequired(part, code) {
                if (this.orderAddressField(part, code)?.required === true) return true;
                const country = this.orderAddressCountry(part);
                if (code === 'postcode') return country?.isZipRequired === true;
                if (code === 'region') return country?.isRegionRequired === true;
                return false;
            },

            orderAddressFieldLabel(part, code, fallback) {
                const label = String(this.orderAddressField(part, code)?.label || fallback);
                return this.orderAddressFieldRequired(part, code) ? `${label} *` : label;
            },

            orderAddressStreetLineVisible(part, line) {
                const field = this.orderAddressField(part, 'street');
                return Boolean(field) && Number(field.lineCount || 1) >= line;
            },

            orderAddressCountry(part) {
                const countryId = String(part?.address?.country_id || '').trim().toUpperCase();
                return Array.isArray(part?.countries)
                    ? part.countries.find(country => country?.value === countryId) || null
                    : null;
            },

            orderAddressCountryRegions(part) {
                const countryId = String(part?.address?.country_id || '').trim().toUpperCase();
                const regions = part?.regions && typeof part.regions === 'object' ? part.regions : {};
                return Array.isArray(regions[countryId]) ? regions[countryId] : [];
            },

            changeOrderAddressCountry(part) {
                if (!part?.address) return;
                part.address.country_id = String(part.address.country_id || '').trim().toUpperCase();
                part.address.region_id = 0;
                part.address.region = '';
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            ensureOrderAddressCountrySelection(part) {
                if (!part || part.status === 'expired' || !part.addresses || typeof part.addresses !== 'object') return;
                const countries = Array.isArray(part.countries) ? part.countries : [];
                if (countries.length === 0) return;
                const allowedCountries = new Set(countries.map(country => country.value));

                ['billing', 'shipping'].forEach((type) => {
                    const address = part.addresses[type];
                    if (!address || typeof address !== 'object') return;

                    const currentCountry = String(address.country_id || '').trim().toUpperCase();
                    if (allowedCountries.has(currentCountry)) {
                        address.country_id = currentCountry;
                    } else if (countries.length === 1) {
                        // A store restricted to one allowed country should act
                        // like Magento Checkout: old address snapshots without
                        // country_id resolve to that sole valid option.
                        address.country_id = countries[0].value;
                    }
                });

                const activeAddress = part.addresses[part.addressType];
                if (activeAddress) {
                    part.address = this.normalizeOrderAddressFormValue(activeAddress);
                }
            },

            expireOrderAddressForm(part) {
                if (!part) return;
                if (part.expiryTimer) {
                    window.clearInterval(part.expiryTimer);
                    part.expiryTimer = null;
                }
                const emptyAddress = this.normalizeOrderAddressFormValue({});
                (Array.isArray(part.addressTypes) ? part.addressTypes : []).forEach((type) => {
                    if (type === 'billing' || type === 'shipping') {
                        part.addresses[type] = this.normalizeOrderAddressFormValue(emptyAddress);
                    }
                });
                part.address = this.normalizeOrderAddressFormValue(emptyAddress);
                part.actionToken = '';
                part.status = 'expired';
                part.remainingSeconds = 0;
                part.busy = false;
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            scheduleOrderAddressFormExpiry(part) {
                if (!part || part.status === 'success' || part.status === 'expired' || part.expiresAt <= 0) return;
                if (part.expiryTimer) window.clearInterval(part.expiryTimer);
                const update = () => {
                    part.remainingSeconds = Math.max(0, Math.ceil((part.expiresAt - Date.now()) / 1000));
                    if (part.status !== 'success' && part.remainingSeconds <= 0) {
                        this.expireOrderAddressForm(part);
                        this.scheduleGuestSessionSnapshot();
                    }
                };
                update();
                if (part.status !== 'expired') {
                    part.expiryTimer = window.setInterval(update, 1000);
                }
            },

            orderAddressCountdownLabel(part) {
                const seconds = Math.max(0, Math.floor(Number(part?.remainingSeconds) || 0));
                const minutes = Math.floor(seconds / 60);
                return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
            },

            expireOtherOrderAddressForms(activeFormId) {
                const activeId = String(activeFormId || '');
                this.messages.forEach((message) => {
                    (Array.isArray(message?.parts) ? message.parts : []).forEach((candidate) => {
                        if (candidate?.type === 'order_address_form'
                            && String(candidate.id || '') !== activeId
                            && candidate.status !== 'expired'
                        ) {
                            this.expireOrderAddressForm(candidate);
                        }
                    });
                });
            },

            enforceSingleActiveOrderAddressForm() {
                let activeId = '';
                let activePart = null;
                let foundLatestForm = false;
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0 && !foundLatestForm; messageIndex -= 1) {
                    const parts = Array.isArray(this.messages[messageIndex]?.parts)
                        ? this.messages[messageIndex].parts
                        : [];
                    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
                        const part = parts[partIndex];
                        if (part?.type !== 'order_address_form') continue;
                        foundLatestForm = true;
                        if (part.status !== 'expired' && part.expiresAt > Date.now()) {
                            activeId = String(part.id || '');
                            activePart = part;
                        }
                        break;
                    }
                }
                this.expireOtherOrderAddressForms(activeId);
                if (activePart) this.scheduleOrderAddressFormExpiry(activePart);
            },

            observeOrderAddressFormWidth(element, part) {
                if (!element || !part) return;
                const updateWidth = () => {
                    // Two columns only when the actual chat card has enough
                    // room. A desktop viewport can still contain a narrow
                    // floating chat window, so a viewport media query is not
                    // an accurate signal here.
                    part.isWide = element.clientWidth >= 576;
                };
                updateWidth();

                if (typeof ResizeObserver !== 'function' || element._afdOrderAddressResizeObserver) return;
                const observer = new ResizeObserver(updateWidth);
                observer.observe(element);
                element._afdOrderAddressResizeObserver = observer;
            },

            changeOrderAddressRegion(part) {
                if (!part?.address) return;
                const regionId = Math.max(0, Number(part.address.region_id) || 0);
                const region = this.orderAddressCountryRegions(part).find(item => item.id === regionId);
                part.address.region_id = regionId;
                part.address.region = region ? region.name : '';
            },

            createOrderAddressFormPart(data = {}) {
                const resourceType = data.resource_type === 'customer_account' ? 'customer_account' : 'order';
                const rawAddresses = data.addresses && typeof data.addresses === 'object'
                    ? data.addresses
                    : {};
                const countries = this.normalizeOrderAddressCountries(data.countries);
                const addresses = {
                    billing: rawAddresses.billing
                        ? this.normalizeOrderAddressFormValue(rawAddresses.billing)
                        : (resourceType === 'customer_account' ? this.normalizeOrderAddressFormValue({}) : null),
                    shipping: rawAddresses.shipping
                        ? this.normalizeOrderAddressFormValue(rawAddresses.shipping)
                        : (resourceType === 'customer_account' ? this.normalizeOrderAddressFormValue({}) : null)
                };
                const addressTypes = Array.isArray(data.address_types)
                    ? data.address_types.filter(type => ['billing', 'shipping'].includes(type) && addresses[type])
                    : ['billing', 'shipping'].filter(type => addresses[type]);
                const addressType = addressTypes.includes(data.address_type)
                    ? data.address_type
                    : (addressTypes.includes('shipping') ? 'shipping' : 'billing');
                const fields = this.normalizeOrderAddressFormFields(data.fields);

                const expiresAt = Math.max(0, Number(data.expires_at || data.expiresAt) || 0);
                const createdAt = Math.max(0, Number(data.created_at || data.createdAt) || 0);
                const isExpired = expiresAt > 0 && Date.now() >= expiresAt;
                if (isExpired) {
                    addressTypes.forEach((type) => {
                        addresses[type] = this.normalizeOrderAddressFormValue({});
                    });
                }
                const part = {
                    id: String(data.form_id || ('order-address-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))),
                    type: 'order_address_form',
                    actionToken: String(data.action_token || data.actionToken || '').slice(0, 2048),
                    resourceType,
                    accessScope: data.access_scope === 'customer' ? 'customer' : 'guest',
                    orderNumber: String(data.order_number || data.orderNumber || ''),
                    addressTypes,
                    addressType,
                    addresses,
                    fields,
                    countries,
                    regions: this.normalizeOrderAddressRegions(data.regions),
                    address: this.normalizeOrderAddressFormValue(addresses[addressType] || {}),
                    busy: false,
                    status: isExpired ? 'expired' : 'editing',
                    createdAt,
                    expiresAt,
                    remainingSeconds: isExpired ? 0 : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
                    expiryTimer: null,
                    isWide: false,
                    notice: '',
                    noticeVariant: 'neutral'
                };

                if (!isExpired) this.ensureOrderAddressCountrySelection(part);
                return part;
            },

            appendOrderAddressForm(data = {}) {
                const part = this.createOrderAddressFormPart(data);
                if ((part.resourceType === 'order' && !part.orderNumber) || part.addressTypes.length === 0) return null;
                let message = this.currentAiMessageIndex >= 0
                    ? this.messages[this.currentAiMessageIndex]
                    : null;

                if (!message || message.role !== 'assistant' || !Array.isArray(message.parts)) {
                    message = { role: 'assistant', feedbackEnabled: false, feedbackBusy: false, parts: [] };
                    this.messages.push(message);
                    this.currentAiMessageIndex = this.messages.length - 1;
                }

                this.expireOtherOrderAddressForms(part.id);
                message.parts.push(part);
                this.scheduleOrderAddressFormExpiry(part);
                this.scheduleGuestSessionSnapshot();
                this.$nextTick(() => {
                    // Alpine renders nested x-for options asynchronously. Run
                    // the selection reconciliation after that render so the
                    // select cannot be coerced back to its placeholder.
                    this.ensureOrderAddressCountrySelection(part);
                    this.scrollToBottom();
                });
                return part;
            },

            findOrderAddressForm(formId) {
                const id = String(formId || '');
                for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
                    const parts = this.messages[messageIndex]?.parts;
                    if (!Array.isArray(parts)) continue;
                    const part = parts.find(candidate => candidate?.type === 'order_address_form' && String(candidate.id) === id);
                    if (part) return part;
                }
                return null;
            },

            selectOrderAddressFormType(part, type) {
                if (!part || part.busy || part.status === 'expired' || !part.addressTypes.includes(type)) return;
                part.addressType = type;
                part.address = this.normalizeOrderAddressFormValue(part.addresses[type] || {});
                part.notice = '';
                part.noticeVariant = 'neutral';
            },

            resetOrderAddressFormRegion(part) {
                if (!part?.address) return;
                part.address.region_id = 0;
            },

            submitOrderAddressForm(part) {
                if (!part || part.busy || part.status === 'success' || part.status === 'expired') return;
                if (part.expiresAt > 0 && Date.now() >= part.expiresAt) {
                    this.expireOrderAddressForm(part);
                    this.scheduleGuestSessionSnapshot();
                    return;
                }
                const address = this.normalizeOrderAddressFormValue(part.address);
                const required = (Array.isArray(part.fields) ? part.fields : [])
                    .filter(field => field?.required === true)
                    .map(field => [field.code, field.label || field.code]);
                ['postcode', 'region'].forEach((code) => {
                    if (!this.orderAddressFieldRequired(part, code) || required.some(([field]) => field === code)) return;
                    required.push([code, this.orderAddressFieldLabel(part, code, code)]);
                });
                const missing = required.find(([field]) => (
                    field === 'street'
                        ? !address.street.some(line => line.trim())
                        : !String(address[field] || '').trim()
                ));
                if (missing) {
                    part.notice = `${missing[1]} is required.`;
                    part.noticeVariant = 'error';
                    return;
                }
                if (!/^[A-Z]{2}$/.test(address.country_id)) {
                    part.notice = 'Use a two-letter country code, for example DE.';
                    part.noticeVariant = 'error';
                    return;
                }
                if (!this.socket || !this.wsConnected) {
                    part.notice = 'The secure chat connection is unavailable. Please try again in a moment.';
                    part.noticeVariant = 'error';
                    return;
                }

                part.address = address;
                part.notice = '';
                part.busy = true;
                this.socket.send(JSON.stringify({
                    action: part.resourceType === 'customer_account'
                        ? 'customer_address_update'
                        : 'order_address_update',
                    form_id: String(part.id),
                    action_token: String(part.actionToken || ''),
                    order_number: String(part.orderNumber),
                    address_type: String(part.addressType),
                    address
                }));
            },

        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
