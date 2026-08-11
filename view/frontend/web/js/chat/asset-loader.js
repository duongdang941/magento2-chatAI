/** Loads rich-text libraries only when the shopper opens the assistant. */
(function (modules) {
    'use strict';

    let sharedPromise = null;

    modules.loadRichTextAssets = function (assets) {
        if (sharedPromise) return sharedPromise;
        const entries = Object.entries(assets || {}).filter((entry) => entry[1]);
        sharedPromise = Promise.all(entries.map(([name, url]) => loadScript(name, url)));
        return sharedPromise;
    };

    function loadScript(name, url) {
        const id = 'afd-ai-chat-asset-' + name;
        const existing = document.getElementById(id);
        if (existing) {
            return existing.dataset.loaded === 'true'
                ? Promise.resolve()
                : new Promise((resolve, reject) => {
                    existing.addEventListener('load', resolve, { once: true });
                    existing.addEventListener('error', reject, { once: true });
                });
        }

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.id = id;
            script.src = String(url);
            script.async = true;
            script.addEventListener('load', () => {
                script.dataset.loaded = 'true';
                resolve();
            }, { once: true });
            script.addEventListener('error', reject, { once: true });
            document.head.appendChild(script);
        });
    }
}(window.AfdAiChat = window.AfdAiChat || {}));
