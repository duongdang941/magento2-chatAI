import { createCustomerResponseStreamSanitizer } from './customer-response-sanitizer.js';

/**
 * Holds one provider turn until it is known to be a customer response.
 *
 * A model can emit prose before selecting a tool. That prose is progress
 * narration, not an answer, so forwarding it immediately causes the chat UI
 * to replace Thinking with a temporary message and then remove it. Keeping it
 * here makes the tool boundary visually stable without losing normal final
 * response streaming (the smooth emitter still paces the committed text).
 */
export function createCustomerTurnBuffer() {
    const sanitizer = createCustomerResponseStreamSanitizer();
    let text = '';

    return {
        push(content) {
            text += sanitizer.push(content);
        },

        /**
         * Returns only the already-safe part of the stream. The sanitizer
         * keeps a short suffix internally so an identifier split across
         * provider chunks can never reach the browser.
         */
        release() {
            const released = text;
            text = '';
            return released;
        },

        commit() {
            return this.release() + sanitizer.flush();
        },

        discard() {
            text = '';
            sanitizer.discard();
        }
    };
}
