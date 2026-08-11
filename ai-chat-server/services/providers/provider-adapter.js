export function defineProviderAdapter({ id, protocol, streamChatResponse }) {
    if (!id || !protocol || typeof streamChatResponse !== 'function') {
        throw new TypeError('A provider adapter requires id, protocol, and streamChatResponse.');
    }
    return Object.freeze({ id, protocol, streamChatResponse });
}
