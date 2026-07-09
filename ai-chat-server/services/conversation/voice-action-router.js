import { handleVoiceTranscription } from './voice-transcription-handler.js';
import { handleLiveVoiceSession } from './live-voice-handler.js';
import { persistLiveVoiceTurn } from './live-voice-persistence.js';
import { handleLiveVoiceToolCall } from './live-voice-tool-handler.js';

/** Keep all customer microphone feature routing outside the gateway root. */
export async function routeVoiceAction(context) {
    if (context?.data?.action === 'voice_transcribe') {
        return handleVoiceTranscription(context);
    }
    if (context?.data?.action === 'live_voice_session') {
        return handleLiveVoiceSession(context);
    }
    if (context?.data?.action === 'live_voice_save_turn') {
        return persistLiveVoiceTurn(context);
    }
    if (context?.data?.action === 'live_voice_tool_call') {
        return handleLiveVoiceToolCall(context);
    }
}
