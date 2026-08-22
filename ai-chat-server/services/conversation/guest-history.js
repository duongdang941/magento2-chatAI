/** Durable guest conversations use a Magento-issued browser token digest. */
export function guestHistoryIdentity(client) {
    return String(client?.guestHistoryId || '');
}

export async function guestHistoryMode(runtime, getConfig, client = null) {
    const config = await getConfig(
        runtime,
        client?.catalogScope?.storeCode || '',
        client?.tenantId || client?.catalogScope?.tenantId || ''
    );
    return config.persist_guest_history === true ? 'database' : 'session';
}
