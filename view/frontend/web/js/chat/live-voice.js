/**
 * OpenAI Realtime Voice lifecycle.
 *
 * This is deliberately independent of Dictation: audio is transmitted over a
 * short-lived WebRTC session directly to OpenAI, while the regular gateway
 * continues to own text chat, tool calls and durable message history.
 */
(function (modules) {
    'use strict';

    function randomId() {
        return `live-voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function closePeerConnection(instance) {
        instance.liveVoiceDurationTimer && window.clearInterval(instance.liveVoiceDurationTimer);
        instance.liveVoiceDurationTimer = null;
        instance.liveVoiceDataChannel?.close?.();
        instance.liveVoiceDataChannel = null;
        instance.liveVoicePeerConnection?.getSenders?.().forEach(sender => sender.track?.stop?.());
        instance.liveVoicePeerConnection?.close?.();
        instance.liveVoicePeerConnection = null;
        instance.liveVoiceRemoteAudio?.pause?.();
        instance.liveVoiceRemoteAudio?.remove?.();
        instance.liveVoiceRemoteAudio = null;
    }

    modules.liveVoiceMethods = function (context) {
        const config = context.config || {};

        return {
            initLiveVoice() {
                this.liveVoiceEnabled = config.liveVoiceEnabled === true;
                this.liveVoiceMaximumDuration = Math.max(30, Math.min(1800, Number(config.liveVoiceMaximumDuration) || 600));
                this.liveVoiceSupported = this.liveVoiceEnabled
                    && window.isSecureContext === true
                    && typeof window.RTCPeerConnection === 'function'
                    && !!navigator.mediaDevices?.getUserMedia;
                if (this.liveVoiceEnabled && !this.liveVoiceSupported) {
                    this.liveVoiceError = 'Live Voice requires a modern browser opened over HTTPS.';
                }
            },

            canStartLiveVoice() {
                return this.liveVoiceSupported
                    && !this.isLoading
                    && !this.humanSupportActive
                    && this.voiceState === 'idle'
                    && ['idle', 'error'].includes(this.liveVoiceState);
            },

            liveVoiceButtonLabel() {
                if (this.liveVoiceState === 'connecting') return 'Connecting Live Voice';
                if (this.liveVoiceState === 'connected') return 'End Live Voice';
                if (this.liveVoiceState === 'error') return this.liveVoiceError || 'Retry Live Voice';
                return 'Start Live Voice';
            },

            async toggleLiveVoice() {
                if (['connecting', 'connected'].includes(this.liveVoiceState)) {
                    this.endLiveVoice();
                    return;
                }
                if (!this.canStartLiveVoice()) return;
                this.liveVoiceState = 'connecting';
                this.liveVoiceError = '';
                this.liveVoiceTranscriptBuffer = '';
                this.liveVoiceAssistantText = '';
                this.liveVoiceCurrentTurnId = '';
                this.liveVoiceUserMessageIndex = -1;
                this.liveVoiceMessageIndex = -1;
                this.liveVoiceTurns = {};
                this.liveVoiceHistory = this.buildModelHistory().slice(-20);
                this.liveVoicePendingToolCalls = {};
                const requestId = randomId();
                this.liveVoiceRequestId = requestId;
                try {
                    if (!this.socket || !this.wsConnected) {
                        await this.connectWebSocket();
                        await this.waitForSecureSocket();
                    }
                    if (!this.socket || !this.wsConnected) throw new Error('The secure chat connection is unavailable.');
                    this.socket.send(JSON.stringify({ action: 'live_voice_session', request_id: requestId }));
                } catch (error) {
                    this.failLiveVoice(error?.message || 'Live Voice could not be started.');
                }
            },

            async connectLiveVoiceSession(data) {
                if (!data || String(data.request_id || '') !== this.liveVoiceRequestId) return;
                const secret = String(data.client_secret || '');
                if (!secret) {
                    this.failLiveVoice('Live Voice did not receive a secure session credential.');
                    return;
                }
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                    });
                    const peer = new RTCPeerConnection();
                    const audio = document.createElement('audio');
                    audio.autoplay = true;
                    audio.playsInline = true;
                    audio.style.display = 'none';
                    document.body.append(audio);
                    // Register these before remote signalling. Any failure
                    // below is then cleaned up by failLiveVoice().
                    this.liveVoicePeerConnection = peer;
                    this.liveVoiceRemoteAudio = audio;
                    peer.ontrack = event => {
                        audio.srcObject = event.streams[0];
                        audio.play().catch(() => {});
                    };
                    stream.getTracks().forEach(track => peer.addTrack(track, stream));
                    const channel = peer.createDataChannel('oai-events');
                    channel.addEventListener('message', event => this.handleLiveVoiceEvent(event));
                    channel.addEventListener('open', () => this.seedLiveVoiceHistory(channel, this.liveVoiceHistory));
                    channel.addEventListener('close', () => {
                        if (this.liveVoiceState === 'connected') this.endLiveVoice();
                    });
                    const offer = await peer.createOffer();
                    await peer.setLocalDescription(offer);
                    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
                        body: offer.sdp
                    });
                    const answer = await response.text();
                    if (!response.ok || !answer) throw new Error('Live Voice could not establish its secure audio connection.');
                    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
                    this.liveVoiceDataChannel = channel;
                    this.liveVoiceState = 'connected';
                    this.liveVoiceStartedAt = Date.now();
                    this.liveVoiceElapsedSeconds = 0;
                    const configuredDuration = Math.max(30, Math.min(Number(data.max_duration_seconds) || this.liveVoiceMaximumDuration, this.liveVoiceMaximumDuration));
                    this.liveVoiceDurationTimer = window.setInterval(() => {
                        this.liveVoiceElapsedSeconds = Math.max(0, Math.floor((Date.now() - this.liveVoiceStartedAt) / 1000));
                        if (this.liveVoiceElapsedSeconds >= configuredDuration) this.endLiveVoice();
                    }, 1000);
                } catch (error) {
                    const captureError = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'AbortError']
                        .includes(String(error?.name || ''));
                    this.failLiveVoice(captureError
                        ? this.describeVoiceCaptureError(error)
                        : (error?.message || 'Live Voice could not connect.'));
                }
            },

            seedLiveVoiceHistory(channel, history) {
                if (!channel || channel.readyState !== 'open' || !Array.isArray(history)) return;
                history.slice(-20).forEach((message) => {
                    const role = message?.role === 'user' ? 'user' : 'assistant';
                    const text = String(message?.content || message?.parts?.[0]?.text || '').trim().slice(0, 4000);
                    if (!text) return;
                    try {
                        channel.send(JSON.stringify({
                            type: 'conversation.item.create',
                            item: {
                                type: 'message',
                                role,
                                content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }]
                            }
                        }));
                    } catch {
                        // The ongoing audio session remains usable even when a
                        // historical item cannot be added during reconnection.
                    }
                });
            },

            handleLiveVoiceEvent(event) {
                let payload;
                try { payload = JSON.parse(event?.data || '{}'); } catch { return; }
                const type = String(payload?.type || '');
                if (type === 'conversation.item.input_audio_transcription.completed') {
                    this.handleLiveVoiceUserTranscript(payload.transcript || '');
                    return;
                }
                if (type === 'response.output_audio_transcript.delta') {
                    this.appendLiveVoiceAssistantText(payload.delta || '');
                    return;
                }
                if (type === 'response.output_text.delta') {
                    this.appendLiveVoiceAssistantText(payload.delta || '');
                    return;
                }
                if (type === 'response.function_call_arguments.done') {
                    this.requestLiveVoiceTool(payload);
                    return;
                }
                if (type === 'response.output_item.done' && payload?.item?.type === 'function_call') {
                    this.requestLiveVoiceTool(payload.item);
                    return;
                }
                if (type === 'response.done') {
                    this.finalizeLiveVoiceResponse();
                }
            },

            finalizeLiveVoiceResponse() {
                const turn = this.liveVoiceTurns[this.liveVoiceCurrentTurnId];
                if (turn?.assistantMessageIndex >= 0 && this.messages[turn.assistantMessageIndex]?.parts?.[0]) {
                    this.finalizeStreamingText(this.messages[turn.assistantMessageIndex].parts[0]);
                }
                this.persistLiveVoiceTurn(this.liveVoiceCurrentTurnId);
                this.liveVoiceMessageIndex = -1;
            },

            handleLiveVoiceUserTranscript(transcript) {
                const text = String(transcript || '').replace(/\s+/g, ' ').trim();
                if (!text) return;
                this.persistLiveVoiceTurn(this.liveVoiceCurrentTurnId);
                const turnId = randomId();
                this.liveVoiceTranscriptBuffer = text;
                this.liveVoiceAssistantText = '';
                this.messages.push({
                    role: 'user',
                    content: text,
                    source: 'live_voice',
                    mutationBusy: false,
                    attachments: []
                });
                this.liveVoiceUserMessageIndex = this.messages.length - 1;
                this.liveVoiceMessageIndex = -1;
                this.liveVoiceCurrentTurnId = turnId;
                this.liveVoiceTurns[turnId] = {
                    userText: text,
                    assistantText: '',
                    userMessageIndex: this.liveVoiceUserMessageIndex,
                    assistantMessageIndex: -1,
                    saveRequested: false
                };
                this.hasStartedChat = true;
                this.$nextTick(() => this.scrollToBottom(true));
            },

            requestLiveVoiceTool(payload) {
                const callId = String(payload?.call_id || payload?.id || '');
                const name = String(payload?.name || '');
                let args = {};
                try { args = JSON.parse(String(payload?.arguments || '{}')); } catch {}
                if (!callId || !name || this.liveVoicePendingToolCalls[callId]) return;
                this.liveVoicePendingToolCalls[callId] = true;
                if (!this.socket || !this.wsConnected) {
                    this.sendLiveVoiceToolOutput(callId, { status: 'error', message: 'The store connection is unavailable.' });
                    return;
                }
                this.socket.send(JSON.stringify({
                    action: 'live_voice_tool_call',
                    request_id: this.liveVoiceRequestId,
                    call_id: callId,
                    name,
                    arguments: args,
                    shopper_text: this.liveVoiceTranscriptBuffer
                }));
            },

            receiveLiveVoiceToolResult(data) {
                if (!data || String(data.request_id || '') !== this.liveVoiceRequestId) return;
                this.sendLiveVoiceToolOutput(String(data.call_id || ''), data.result || {
                    status: 'error', message: 'The store lookup could not be completed.'
                });
            },

            sendLiveVoiceToolOutput(callId, result) {
                const channel = this.liveVoiceDataChannel;
                if (!callId || !channel || channel.readyState !== 'open') return;
                try {
                    channel.send(JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: callId,
                            output: JSON.stringify(result || { status: 'error', message: 'The store lookup could not be completed.' })
                        }
                    }));
                    channel.send(JSON.stringify({ type: 'response.create' }));
                } catch {
                    this.failLiveVoice('Live Voice lost its store connection.');
                } finally {
                    delete this.liveVoicePendingToolCalls[callId];
                }
            },

            appendLiveVoiceAssistantText(delta) {
                const text = String(delta || '');
                if (!text) return;
                const turn = this.liveVoiceTurns[this.liveVoiceCurrentTurnId];
                if (!turn) return;
                this.liveVoiceAssistantText += text;
                turn.assistantText += text;
                let message = this.messages[this.liveVoiceMessageIndex];
                if (!message || message.role !== 'assistant') {
                    message = {
                        role: 'assistant',
                        source: 'live_voice',
                        feedbackEnabled: false,
                        feedbackBusy: false,
                        parts: [this.createStreamingTextPart('')]
                    };
                    this.messages.push(message);
                    this.liveVoiceMessageIndex = this.messages.length - 1;
                    turn.assistantMessageIndex = this.liveVoiceMessageIndex;
                    this.hasStartedChat = true;
                }
                this.appendStreamingText(message.parts[0], text);
                this.scheduleStreamingScroll();
            },

            receiveLiveVoiceError(data) {
                if (data?.request_id && String(data.request_id) !== this.liveVoiceRequestId) return;
                this.failLiveVoice(data?.content || 'Live Voice could not be started.');
            },

            endLiveVoice() {
                this.persistLiveVoiceTurn(this.liveVoiceCurrentTurnId);
                const index = this.liveVoiceMessageIndex;
                if (index >= 0 && this.messages[index]?.parts?.[0]) this.finalizeStreamingText(this.messages[index].parts[0]);
                this.liveVoiceState = 'ending';
                closePeerConnection(this);
                this.liveVoiceState = 'idle';
                this.liveVoiceRequestId = '';
                this.liveVoiceStartedAt = 0;
                this.liveVoiceElapsedSeconds = 0;
                this.liveVoiceMessageIndex = -1;
                this.liveVoiceUserMessageIndex = -1;
                this.liveVoiceCurrentTurnId = '';
                this.liveVoicePendingToolCalls = {};
            },

            persistLiveVoiceTurn(turnId) {
                const key = String(turnId || '');
                const turn = this.liveVoiceTurns[key];
                if (!turn || turn.saveRequested || !turn.userText || !turn.assistantText || !this.socket || !this.wsConnected) return;
                turn.saveRequested = true;
                this.socket.send(JSON.stringify({
                    action: 'live_voice_save_turn',
                    request_id: this.liveVoiceRequestId || key,
                    turn_id: key,
                    conversation_id: Number(this.activeConversationId) || 0,
                    user_text: turn.userText,
                    assistant_text: turn.assistantText
                }));
            },

            receiveLiveVoiceSaved(data) {
                const turnId = String(data?.turn_id || '');
                const turn = this.liveVoiceTurns[turnId];
                const conversationId = Number(data?.conversation_id) || 0;
                if (conversationId) {
                    this.activeConversationId = conversationId;
                    this.scheduleCrossTabConversationSync(conversationId, 120);
                }
                const userMessage = turn ? this.messages[turn.userMessageIndex] : null;
                const assistantMessage = turn ? this.messages[turn.assistantMessageIndex] : null;
                if (userMessage && Number(data?.user_message_id) > 0) userMessage.entity_id = Number(data.user_message_id);
                if (assistantMessage && Number(data?.assistant_message_id) > 0) {
                    assistantMessage.entity_id = Number(data.assistant_message_id);
                    assistantMessage.feedbackEnabled = true;
                }
                this.scheduleGuestSessionSnapshot?.();
                if (turn) delete this.liveVoiceTurns[turnId];
            },

            receiveLiveVoiceSaveError(data) {
                // The visible transcript remains usable for this browser
                // session, but it was not written to server history.
                this.setTransportNotice(
                    'live-voice-save-failed',
                    'Voice transcript was not saved',
                    data?.content || 'The voice call ended, but its text could not be saved to chat history.'
                );
            },

            failLiveVoice(message) {
                this.liveVoiceState = 'ending';
                closePeerConnection(this);
                this.liveVoiceState = 'error';
                this.liveVoiceError = String(message || 'Live Voice could not be started.');
                this.liveVoiceRequestId = '';
                this.liveVoiceStartedAt = 0;
                this.liveVoiceElapsedSeconds = 0;
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
