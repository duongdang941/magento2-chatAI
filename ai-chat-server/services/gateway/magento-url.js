import { getMagentoBaseUrl } from '../configuration/config-service.js';

export function resolveMagentoBaseUrl(catalogScope = null, explicitUrl = '') {
    const configured = String(explicitUrl || '').trim()
        || getMagentoBaseUrl(catalogScope?.storeCode || '');
    const fallback = String(process.env.MAGENTO_API_URL || '').trim();
    const url = (configured || fallback).replace(/\/+$/, '');
    if (!url) {
        throw new Error('Magento base URL is not configured. Save the website base URL in Magento Admin and sync AI configuration.');
    }
    try {
        return new URL(url).toString().replace(/\/+$/, '');
    } catch {
        throw new Error('Magento base URL is invalid. Save a valid website URL in Magento Admin and sync AI configuration.');
    }
}
