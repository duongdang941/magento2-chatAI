/** Durable guest conversations use a Magento-issued browser token digest. */
export function guestHistoryIdentity(client) {
    return String(client?.guestHistoryId || '');
}

export async function guestHistoryMode(runtime, getConfig) {
    const config = await getConfig(runtime);
    return config.persist_guest_history === true ? 'database' : 'session';
}
