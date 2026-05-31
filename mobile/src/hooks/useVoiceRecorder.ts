// Push-to-talk voice capture for the live 911 operator call.
//
// Records a short utterance with expo-av (works in Expo Go — no custom dev
// build needed), then reads the file as base64 so it can be POSTed to the
// backend, where Gemini transcribes it. Hold the mic to record, release to stop;
// `stop()` resolves to { base64, mime } ready for api.operatorMessage.
//
// A 911 call must never be blocked on the mic: on permission denial or any
// failure the hook surfaces an `error` and the caller can simply type instead.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';

export type RecordedClip = { base64: string; mime: string };

function mimeForUri(uri: string): string {
  const ext = (uri.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'wav':
      return 'audio/wav';
    case 'caf':
      return 'audio/x-caf';
    case '3gp':
    case '3gpp':
      return 'audio/3gpp';
    default:
      return 'audio/mp4';
  }
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live mic feedback while recording: input level (0..1) + elapsed time, so the
  // caller can SEE that their voice is being captured in real time.
  const [level, setLevel] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);

  // Make sure we never leave a dangling recording / hot mic if the screen closes.
  useEffect(() => {
    return () => {
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (rec) {
        rec.stopAndUnloadAsync().catch(() => {});
      }
      Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (recordingRef.current) return; // already recording
    setIsBusy(true);
    setLevel(0);
    setDurationMs(0);
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setError('Microphone permission denied — you can type your message instead.');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const recording = new Audio.Recording();
      // Metering on → live input level for the on-screen meter.
      await recording.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recording.setProgressUpdateInterval(120);
      recording.setOnRecordingStatusUpdate((st) => {
        if (!st.isRecording) return;
        setDurationMs(st.durationMillis ?? 0);
        // metering is dBFS (~ -160 silence … 0 loud). Map the useful -60..0 band to 0..1.
        const m = typeof st.metering === 'number' ? st.metering : -60;
        setLevel(Math.max(0, Math.min(1, (m + 60) / 60)));
      });
      await recording.startAsync();
      recordingRef.current = recording;
      setIsRecording(true);
    } catch (e: any) {
      setError(e?.message ? `Couldn't start recording: ${e.message}` : "Couldn't start recording.");
      recordingRef.current = null;
    } finally {
      setIsBusy(false);
    }
  }, []);

  const stop = useCallback(async (): Promise<RecordedClip | null> => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return null;
    setIsBusy(true);
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
      const uri = recording.getURI();
      if (!uri) {
        setError("Couldn't capture audio — please type your message.");
        return null;
      }
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Best-effort cleanup of the temp clip — it's already in memory now.
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      if (!base64) {
        setError("Couldn't read the recording — please type your message.");
        return null;
      }
      return { base64, mime: mimeForUri(uri) };
    } catch (e: any) {
      setError(e?.message ? `Recording failed: ${e.message}` : 'Recording failed.');
      return null;
    } finally {
      setIsRecording(false);
      setIsBusy(false);
      setLevel(0);
    }
  }, []);

  const cancel = useCallback(async () => {
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (recording) {
      await recording.stopAndUnloadAsync().catch(() => {});
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
    }
    setIsRecording(false);
    setIsBusy(false);
    setLevel(0);
    setDurationMs(0);
  }, []);

  return { isRecording, isBusy, error, level, durationMs, start, stop, cancel };
}
