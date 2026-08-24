/**
 * Chat component composition root.
 *
 * Individual behaviours live in js/chat/*.js. This file deliberately owns
 * only initial Alpine state and composes the independently testable modules.
 */
(function (modules) {
    'use strict';

    function aiAgentChat() {
        const config = window.afdAiChatConfig || {};
        const urls = config.urls || {};
        const context = { config, urls, helpers: modules.helpers };
        const state = modules.createInitialState(config);

        return Object.assign(
            state,
            modules.visualMethods(context),
            modules.connectionMethods(context),
            modules.historyMethods(context),
            modules.preferenceMethods(context),
            modules.attachmentMethods(context),
            modules.voiceMethods(context),
            modules.liveVoiceMethods(context),
            modules.requestMethods(context),
            modules.streamRendererMethods(context),
            modules.streamMethods(context),
            modules.orderAddressStreamMethods(context),
            modules.guestOrderStreamMethods(context),
            modules.reasoningStreamMethods(context),
            modules.imageFeedbackStreamMethods(context),
            modules.windowMethods(context),
            modules.shellMethods(context)
        );
    }

    window.aiAgentChat = aiAgentChat;
}(window.AfdAiChat = window.AfdAiChat || {}));
