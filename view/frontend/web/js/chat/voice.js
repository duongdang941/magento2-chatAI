/**
 * Composer dictation lifecycle. Audio stays in memory only until Node returns
 * a transcript; the transcript still needs an explicit customer Send action.
 */
(function (modules) {
    'use strict';

    const SUPPORTED_TYPES = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/x-m4a',
        'audio/aac'
    ];

    modules.voiceMethods = function (context) {
        const config = context.config || {};

        return {
            initVoiceDictation() {
                this.voiceEnabled = config.voiceEnabled === true;
                this.voiceMaximumDuration = Math.max(5, Math.min(300, Number(config.voiceMaximumDuration) || 120));
                this.voiceSupported = this.voiceEnabled
                    && !!navigator.mediaDevices?.getUserMedia
                    && typeof window.MediaRecorder === 'function';
                if (!this.voiceEnabled || this.voiceSupported) return;
                this.voiceError = 'Voice dictation is not supported by this browser.';
            },

            canStartVoiceDictation() {
                return this.voiceSupported
                    && !this.isLoading
                    && !this.isReadingAttachments
                    && !this.humanSupportActive
                    && this.liveVoiceState === 'idle'
                    && ['idle', 'error'].includes(this.voiceState);
            },

            isVoiceBusy() {
                return ['requesting_permission', 'recording', 'transcribing'].includes(this.voiceState);
            },

            voiceButtonLabel() {
                switch (this.voiceState) {
                    case 'requesting_permission': return 'Requesting microphone permission';
                    case 'recording': return `Stop recording (${this.voiceDurationSeconds}s)`;
                    case 'transcribing': return 'Transcribing voice message';
                    case 'error': return this.voiceError || 'Retry voice dictation';
                    default: return 'Dictate message';
                }
            },

            chooseVoiceMimeType() {
                return SUPPORTED_TYPES.find(type => MediaRecorder.isTypeSupported(type)) || '';
            },

            async toggleVoiceDictation() {
                if (this.voiceState === 'recording') {
                    this.stopVoiceDictation('transcribe');
                    return;
                }
                if (!this.canStartVoiceDictation()) return;
                await this.startVoiceDictation();
            },

            async startVoiceDictation() {
                this.voiceError = '';
                this.voiceState = 'requesting_permission';
                this.voiceStopIntent = 'discard';
                this.voiceChunks = [];
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        }
                    });
                    const mimeType = this.chooseVoiceMimeType();
                    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
                    this.voiceStream = stream;
                    this.voiceRecorder = recorder;
                    this.voiceMimeType = recorder.mimeType || mimeType || 'audio/webm';
                    this.voiceStartedAt = Date.now();
                    this.voiceDurationSeconds = 0;
                    recorder.addEventListener('dataavailable', event => {
                        if (event.data?.size) this.voiceChunks.push(event.data);
                    });
                    recorder.addEventListener('stop', () => this.finalizeVoiceRecording());
                    recorder.addEventListener('error', () => this.handleVoiceError('The microphone recording could not be completed.'));
                    recorder.start(250);
                    this.voiceState = 'recording';
                    this.voiceDurationTimer = window.setInterval(() => {
                        const elapsed = Math.floor((Date.now() - this.voiceStartedAt) / 1000);
                        this.voiceDurationSeconds = Math.max(0, elapsed);
                        if (elapsed >= this.voiceMaximumDuration) this.stopVoiceDictation('transcribe');
                    }, 250);
                } catch (error) {
                    this.handleVoiceError(this.describeVoiceCaptureError(error));
                }
            },

            describeVoiceCaptureError(error) {
                const name = String(error?.name || '');
                if (name === 'NotAllowedError') {
                    if (window.isSecureContext === false) {
                        return 'Microphone access requires HTTPS (or localhost). Open this store using its secure URL and try again.';
                    }
                    return 'Microphone permission was denied for this site. Select the lock icon beside the address bar, allow Microphone, then reload the page.';
                }
                if (name === 'SecurityError') {
                    return 'This page is not allowed to use the microphone. Check the browser permission and any site security policy.';
                }
                if (name === 'NotFoundError') {
                    return 'No microphone was found. Connect or enable a microphone, then try again.';
                }
                if (name === 'NotReadableError') {
                    return 'The microphone is being used by another application. Close that application and try again.';
                }
                if (name === 'AbortError') {
                    return 'Microphone access was interrupted. Please try again.';
                }
                return 'The microphone is unavailable. Please check your browser and device settings.';
            },

            stopVoiceDictation(intent = 'discard') {
                this.voiceStopIntent = intent;
                if (this.voiceDurationTimer) {
                    window.clearInterval(this.voiceDurationTimer);
                    this.voiceDurationTimer = null;
                }
                const recorder = this.voiceRecorder;
                if (recorder && recorder.state !== 'inactive') {
                    recorder.stop();
                    return;
                }
                this.releaseVoiceStream();
                if (intent === 'discard') this.resetVoiceDictation();
            },

            cancelVoiceDictation() {
                this.stopVoiceDictation('discard');
            },

            async finalizeVoiceRecording() {
                const intent = this.voiceStopIntent;
                const chunks = this.voiceChunks;
                const type = this.voiceMimeType;
                const durationSeconds = Math.max(1, this.voiceDurationSeconds || Math.ceil((Date.now() - this.voiceStartedAt) / 1000));
                this.releaseVoiceStream();
                this.voiceRecorder = null;
                this.voiceChunks = [];

                if (intent !== 'transcribe' || !chunks.length) {
                    this.resetVoiceDictation();
                    return;
                }

                const audio = new Blob(chunks, { type });
                try {
                    this.voiceState = 'transcribing';
                    const base64 = await this.voiceBlobToBase64(audio);
                    const requestId = `voice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                    this.voiceRequestId = requestId;
                    if (!this.socket || !this.wsConnected) {
                        await this.connectWebSocket();
                        await this.waitForSecureSocket();
                    }
                    if (!this.socket || !this.wsConnected) throw new Error('The secure chat connection is unavailable.');
                    this.socket.send(JSON.stringify({
                        action: 'voice_transcribe',
                        request_id: requestId,
                        mime_type: type,
                        duration_seconds: durationSeconds,
                        audio: base64
                    }));
                } catch (error) {
                    this.handleVoiceError(error?.message || 'Voice transcription could not be started.');
                }
            },

            voiceBlobToBase64(blob) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
                    reader.onerror = () => reject(new Error('The recording could not be read.'));
                    reader.readAsDataURL(blob);
                });
            },

            receiveVoiceTranscript(data) {
                if (!data || String(data.request_id || '') !== this.voiceRequestId) return;
                const transcript = String(data.text || '').trim();
                if (!transcript) {
                    this.handleVoiceError('No speech was detected. Please try again.');
                    return;
                }
                const separator = this.userInput.trim() ? ' ' : '';
                this.userInput = `${this.userInput}${separator}${transcript}`;
                this.resetVoiceDictation();
                this.$nextTick(() => {
                    this.resizeComposerInput();
                    this.$refs.composerInput?.focus();
                });
            },

            receiveVoiceError(data) {
                if (data?.request_id && String(data.request_id) !== this.voiceRequestId) return;
                this.handleVoiceError(data?.content || 'Voice transcription could not be completed.');
            },

            handleVoiceError(message) {
                this.releaseVoiceStream();
                if (this.voiceDurationTimer) {
                    window.clearInterval(this.voiceDurationTimer);
                    this.voiceDurationTimer = null;
                }
                this.voiceRecorder = null;
                this.voiceChunks = [];
                this.voiceError = String(message || 'Voice dictation could not be completed.');
                this.voiceState = 'error';
            },

            releaseVoiceStream() {
                this.voiceStream?.getTracks?.().forEach(track => track.stop());
                this.voiceStream = null;
            },

            resetVoiceDictation() {
                this.releaseVoiceStream();
                if (this.voiceDurationTimer) {
                    window.clearInterval(this.voiceDurationTimer);
                    this.voiceDurationTimer = null;
                }
                this.voiceRecorder = null;
                this.voiceChunks = [];
                this.voiceMimeType = '';
                this.voiceStartedAt = 0;
                this.voiceDurationSeconds = 0;
                this.voiceStopIntent = 'discard';
                this.voiceRequestId = '';
                this.voiceError = '';
                this.voiceState = 'idle';
            }
        };
    };
}(window.AfdAiChat = window.AfdAiChat || {}));
