import crypto from 'node:crypto';

const MAGENTO_HOST = process.env.MAGENTO_HOST || '';
const MAGENTO_SIGNING_BASE_URL = process.env.MAGENTO_SIGNING_BASE_URL || '';

function oauthEncode(value) {
    return encodeURIComponent(String(value))
        .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeBaseUrl(url) {
    const parsed = new URL(url);
    const isDefaultPort = (parsed.protocol === 'http:' && (parsed.port === '' || parsed.port === '80'))
        || (parsed.protocol === 'https:' && (parsed.port === '' || parsed.port === '443'));
    const port = isDefaultPort ? '' : `:${parsed.port}`;
    return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
}

export function normalizeMagentoHostHeader(host) {
    const trimmed = String(host || '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return '';
    }

    try {
        const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
        return parsed.host;
    } catch {
        return trimmed;
    }
}

export function buildMagentoSigningUrl(url, host = MAGENTO_HOST, signingBaseUrl = MAGENTO_SIGNING_BASE_URL) {
    const parsed = new URL(url);
    const explicitSigningBaseUrl = String(signingBaseUrl || '').trim();

    if (explicitSigningBaseUrl) {
        const signingBase = new URL(explicitSigningBaseUrl.includes('://')
            ? explicitSigningBaseUrl
            : `http://${explicitSigningBaseUrl}`);
        parsed.protocol = signingBase.protocol;
        parsed.host = signingBase.host;
        return parsed.toString();
    }

    const hostHeader = normalizeMagentoHostHeader(host);
    if (hostHeader) {
        parsed.host = hostHeader;
    }

    return parsed.toString();
}

function collectParams(url, extraParams = {}) {
    const parsed = new URL(url);
    const params = Array.from(parsed.searchParams.entries());

    for (const [key, value] of Object.entries(extraParams)) {
        // Axios transmits an explicitly empty value as `key=`. It must remain
        // in the OAuth base string too; omitting it makes category browsing
        // requests fail signature validation while exact searches still work.
        if (value === undefined || value === null) {
            continue;
        }
        params.push([key, String(value)]);
    }

    return params;
}

function normalizeMagentoOauthConfig(config = {}) {
    const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};

    return {
        consumerKey: String(source.consumer_key || source.consumerKey || '').trim(),
        consumerSecret: String(source.consumer_secret || source.consumerSecret || '').trim(),
        accessToken: String(source.access_token || source.accessToken || '').trim(),
        accessTokenSecret: String(source.access_token_secret || source.accessTokenSecret || '').trim()
    };
}

function buildOAuth1AuthorizationHeader(method, url, extraParams = {}, oauthConfig = {}, signingBaseUrl = '') {
    const credentials = normalizeMagentoOauthConfig(oauthConfig);
    const signingUrl = buildMagentoSigningUrl(url, '', signingBaseUrl);
    const oauthParams = {
        oauth_consumer_key: credentials.consumerKey,
        oauth_nonce: crypto.randomBytes(16).toString('hex'),
        oauth_signature_method: 'HMAC-SHA256',
        oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
        oauth_token: credentials.accessToken,
        oauth_version: '1.0'
    };

    const params = [
        ...collectParams(signingUrl, extraParams),
        ...Object.entries(oauthParams)
    ]
        .map(([key, value]) => [oauthEncode(key), oauthEncode(value)])
        .sort(([keyA, valueA], [keyB, valueB]) => {
            if (keyA === keyB) {
                return valueA.localeCompare(valueB);
            }
            return keyA.localeCompare(keyB);
        });

    const normalizedParams = params
        .map(([key, value]) => `${key}=${value}`)
        .join('&');

    const baseString = [
        method.toUpperCase(),
        oauthEncode(normalizeBaseUrl(signingUrl)),
        oauthEncode(normalizedParams)
    ].join('&');

    const signingKey = `${oauthEncode(credentials.consumerSecret)}&${oauthEncode(credentials.accessTokenSecret)}`;
    const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

    const headerParams = {
        ...oauthParams,
        oauth_signature: signature
    };

    return 'OAuth ' + Object.entries(headerParams)
        .map(([key, value]) => `${oauthEncode(key)}="${oauthEncode(value)}"`)
        .join(', ');
}

export function hasMagentoOAuthCredentials(oauthConfig = {}) {
    const credentials = normalizeMagentoOauthConfig(oauthConfig);

    return Boolean(
        credentials.consumerKey &&
        credentials.consumerSecret &&
        credentials.accessToken &&
        credentials.accessTokenSecret
    );
}

export function createMagentoRequestConfig(method, url, options = {}) {
    const oauthConfig = normalizeMagentoOauthConfig(options.magentoOauth);
    const hostHeader = normalizeMagentoHostHeader(options.magentoBaseUrl || MAGENTO_HOST);
    const headers = {
        Accept: options.accept || 'application/json'
    };

    if (hostHeader) {
        headers.Host = hostHeader;
    }

    if (options.contentType !== false) {
        headers['Content-Type'] = options.contentType || 'application/json';
    }

    if (hasMagentoOAuthCredentials(oauthConfig)) {
        headers.Authorization = buildOAuth1AuthorizationHeader(
            method,
            url,
            options.signParams || {},
            oauthConfig,
            options.magentoBaseUrl || ''
        );
    } else if (oauthConfig.accessToken) {
        headers.Authorization = `Bearer ${oauthConfig.accessToken}`;
    }

    return {
        headers,
        timeout: options.timeout || 10000,
        // Axios' default serializer turns spaces into "+". Laminas OAuth
        // intentionally uses rawurldecode (where "+" remains a literal plus)
        // when Magento verifies the query string, so the signed value and the
        // received value diverge for every multi-word search. RFC3986 encoding
        // keeps spaces as %20 and makes transport and signature identical.
        ...(Object.keys(options.signParams || {}).length > 0
            ? { paramsSerializer: { encode: oauthEncode } }
            : {})
    };
}

/**
 * Sign service-to-service requests that must not depend on a Magento OAuth
 * integration. The signature binds the request method, URI and raw JSON body
 * so it cannot be replayed against a different internal API route.
 */
export function createInternalMagentoRequestConfig(method, url, body = '', options = {}) {
    const internalSecret = process.env.AI_NODE_SYNC_SECRET || '';
    if (internalSecret.length < 32) {
        throw new Error('AI_NODE_SYNC_SECRET is required for internal Magento requests.');
    }

    const requestUrl = new URL(url);
    // Use the synchronized Magento URL's host. MAGENTO_HOST is retained only
    // for loopback development routing; it must not override a live domain.
    const hostHeader = normalizeMagentoHostHeader(
        options.magentoBaseUrl || (isLoopbackHost(requestUrl.hostname) ? MAGENTO_HOST : requestUrl.host)
    );
    const requestTarget = `${requestUrl.pathname}${requestUrl.search}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body || {});
    const signature = crypto
        .createHmac('sha256', internalSecret)
        .update(`${timestamp}.${nonce}.${method.toUpperCase()}.${requestTarget}.${rawBody}`, 'utf8')
        .digest('hex');
    const headers = {
        Accept: options.accept || 'application/json',
        'X-Afd-AI-Internal-Timestamp': timestamp,
        'X-Afd-AI-Internal-Nonce': nonce,
        'X-Afd-AI-Internal-Signature': signature
    };

    if (hostHeader) {
        headers.Host = hostHeader;
    }

    if (options.contentType !== false) {
        headers['Content-Type'] = options.contentType || 'application/json';
    }

    if (options.cookie) {
        headers.Cookie = String(options.cookie);
    }

    return {
        headers,
        timeout: options.timeout || 10000
    };
}

function isLoopbackHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
