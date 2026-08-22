const DEFAULT_INTERVAL_MS = 16;
const DEFAULT_TARGET_FRAMES = 2;
const DEFAULT_MIN_CHARS = 4;
const DEFAULT_MAX_CHARS = 64;

function takeCodePoints(value, limit) {
    let end = 0;
    let count = 0;

    for (const character of value) {
        end += character.length;
        count += 1;
        if (count >= limit) break;
    }

    return [value.slice(0, end), value.slice(end)];
}

/**
 * Convert irregular provider deltas into small, frame-friendly chunks.
 *
 * Providers commonly deliver 20-60 characters in a burst every 100-200ms.
 * Forwarding those bursts directly makes the browser reflow whole lines at
 * once. This emitter keeps only a small transport buffer; the browser-side
 * renderer coalesces all deltas received during a frame. The limits are high
 * enough that the gateway does not become a second typewriter animation.
 */
export function createSmoothChunkEmitter({
    emit,
    isCancelled = () => false,
    intervalMs = DEFAULT_INTERVAL_MS,
    targetFrames = DEFAULT_TARGET_FRAMES,
    minChars = DEFAULT_MIN_CHARS,
    maxChars = DEFAULT_MAX_CHARS
}) {
    let queue = '';
    let timer = null;
    let failure = null;
    const drainWaiters = [];

    const settleDrains = () => {
        while (drainWaiters.length > 0) {
            const waiter = drainWaiters.shift();
            if (failure) waiter.reject(failure);
            else waiter.resolve();
        }
    };

    const schedule = () => {
        if (timer !== null || queue === '') return;
        timer = setTimeout(pump, Math.max(0, intervalMs));
    };

    const pump = () => {
        timer = null;
        if (isCancelled()) {
            queue = '';
            settleDrains();
            return;
        }

        if (queue === '') {
            settleDrains();
            return;
        }

        const backlogSize = Array.from(queue).length;
        const budget = Math.max(
            minChars,
            Math.min(maxChars, Math.ceil(backlogSize / Math.max(1, targetFrames)))
        );
        const [chunk, remaining] = takeCodePoints(queue, budget);
        queue = remaining;

        try {
            emit(chunk);
        } catch (error) {
            failure = error;
            queue = '';
            settleDrains();
            return;
        }

        if (queue === '') settleDrains();
        else schedule();
    };

    return {
        push(content) {
            if (failure) throw failure;
            if (isCancelled()) return;

            const next = String(content || '');
            if (!next) return;
            queue += next;

            // Preserve first-token responsiveness; subsequent pieces are
            // paced by the timer above.
            if (timer === null) pump();
        },

        drain() {
            if (failure) return Promise.reject(failure);
            if (isCancelled()) {
                queue = '';
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                return Promise.resolve();
            }
            if (queue === '' && timer === null) return Promise.resolve();

            return new Promise((resolve, reject) => {
                drainWaiters.push({ resolve, reject });
                schedule();
            });
        },

        /** Drop provisional prose if the provider changes to a tool call. */
        discard() {
            queue = '';
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            settleDrains();
        }
    };
}
