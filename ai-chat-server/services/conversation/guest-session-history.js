import crypto from 'node:crypto';

const MAX_CONVERSATIONS = 20;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
let lastGeneratedId = 0;

function ttlMs() {
    const parsed = Number(process.env.GUEST_SESSION_HISTORY_TTL_MS || DEFAULT_TTL_MS);
    return Number.isFinite(parsed) ? Math.max(60_000, Math.min(Math.trunc(parsed), 24 * 60 * 60 * 1000)) : DEFAULT_TTL_MS;
}

function emptyStore() {
    return { version: 1, conversations: [], messages: {} };
}

function normalizeStore(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
    return {
        version: 1,
        conversations: Array.isArray(value.conversations) ? value.conversations.slice(0, MAX_CONVERSATIONS) : [],
        messages: value.messages && typeof value.messages === 'object' && !Array.isArray(value.messages) ? value.messages : {}
    };
}

function conversationId() {
    // Date plus a random suffix can collide under a burst of in-memory guest
    // writes. A duplicate message ID can make an assistant row look like the
    // preceding user row during branch truncation, so make the local ID
    // strictly monotonic as well.
    const candidate = Number(`${Date.now()}${crypto.randomInt(100, 1000)}`);
    lastGeneratedId = Math.max(lastGeneratedId + 1, candidate);
    return lastGeneratedId;
}

function titleFrom(value) {
    const title = String(value || 'New Chat').trim();
    return title.slice(0, 255) || 'New Chat';
}

export class GuestSessionHistory {
    constructor(runtime) {
        this.runtime = runtime;
    }

    async list(guestId, page = 1) {
        const store = await this.read(guestId);
        const requestedPage = Math.max(1, Number(page) || 1);
        const start = (requestedPage - 1) * MAX_CONVERSATIONS;
        // A guest deliberately has one continuous browser-session chat. Older
        // entries can exist from a previous version; expose only the newest.
        const conversations = [...store.conversations]
            .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
            .slice(start, start + 1);
        return { conversations, hasMore: false, nextPage: null, page: requestedPage };
    }

    async get(guestId, id) {
        const store = await this.read(guestId);
        return store.conversations.find((conversation) => Number(conversation.id) === Number(id)) || null;
    }

    async create(guestId, title) {
        const store = await this.read(guestId);
        const existing = [...store.conversations]
            .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
        if (existing) return existing;
        const now = new Date().toISOString();
        const conversation = { id: conversationId(), title: titleFrom(title), created_at: now, updated_at: now };
        store.conversations.unshift(conversation);
        store.conversations = store.conversations.slice(0, MAX_CONVERSATIONS);
        store.messages[String(conversation.id)] = [];
        await this.write(guestId, store);
        return conversation;
    }

    async loadMessages(guestId, id, beforeMessageId = null) {
        const store = await this.read(guestId);
        if (!store.conversations.some((conversation) => Number(conversation.id) === Number(id))) {
            return { messages: [], has_more: false, next_before_message_id: null };
        }
        const all = Array.isArray(store.messages[String(id)]) ? store.messages[String(id)] : [];
        const filtered = beforeMessageId ? all.filter((message) => Number(message.entity_id) < Number(beforeMessageId)) : all;
        const page = filtered.slice(-50);
        return {
            messages: page,
            has_more: filtered.length > page.length,
            next_before_message_id: filtered.length > page.length ? Number(page[0]?.entity_id) || null : null
        };
    }

    async append(guestId, id, message) {
        const store = await this.read(guestId);
        const conversation = store.conversations.find((item) => Number(item.id) === Number(id));
        if (!conversation) return false;
        const key = String(id);
        const messages = Array.isArray(store.messages[key]) ? store.messages[key] : [];
        const persistedMessage = {
            ...message,
            entity_id: conversationId(),
            created_at: new Date().toISOString()
        };
        messages.push(persistedMessage);
        store.messages[key] = messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
        conversation.updated_at = new Date().toISOString();
        await this.write(guestId, store);
        return persistedMessage.entity_id;
    }

    /**
     * Editing and regenerating create a new branch. Trim the old branch in
     * temporary guest history just as the database-backed implementation does.
     */
    async truncateFromMessage(guestId, id, fromMessageId) {
        const store = await this.read(guestId);
        const conversation = store.conversations.find((item) => Number(item.id) === Number(id));
        if (!conversation) return false;

        const key = String(id);
        const messages = Array.isArray(store.messages[key]) ? store.messages[key] : [];
        const branchIndex = messages.findIndex((message) => (
            Number(message?.entity_id) === Number(fromMessageId)
            && message?.role === 'user'
        ));
        if (branchIndex < 0) return false;

        store.messages[key] = messages.slice(0, branchIndex);
        conversation.updated_at = new Date().toISOString();
        await this.write(guestId, store);
        return true;
    }

    async delete(guestId, id) {
        const store = await this.read(guestId);
        const before = store.conversations.length;
        store.conversations = store.conversations.filter((conversation) => Number(conversation.id) !== Number(id));
        delete store.messages[String(id)];
        if (store.conversations.length === before) return false;
        await this.write(guestId, store);
        return true;
    }

    async clear(guestId) {
        await this.runtime.deleteGuestSessionHistory(guestId);
    }

    async rename(guestId, id, title) {
        const store = await this.read(guestId);
        const conversation = store.conversations.find((item) => Number(item.id) === Number(id));
        if (!conversation) return false;
        conversation.title = titleFrom(title);
        conversation.updated_at = new Date().toISOString();
        await this.write(guestId, store);
        return true;
    }

    async read(guestId) {
        const cached = await this.runtime.getGuestSessionHistory(guestId);
        return normalizeStore(cached);
    }

    async write(guestId, store) {
        await this.runtime.setGuestSessionHistory(guestId, store, ttlMs());
    }
}
