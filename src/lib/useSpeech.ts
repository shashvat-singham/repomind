"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice-to-text via the browser's built-in Web Speech API. No keys, no network
 * of ours — transcription runs on-device / in the browser, which keeps the
 * project's zero-dependency-secret promise intact. Emits interim results so the
 * textbox fills in live as you speak, and a final result when you pause.
 *
 * Gracefully reports `supported: false` on browsers without the API (e.g.
 * Firefox) so the UI can hide the mic rather than show a dead button.
 */

// The Web Speech API isn't in the standard TS DOM lib; declare the slice we use.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseSpeech {
  supported: boolean;
  listening: boolean;
  /** Start dictation. `base` is the existing text to append onto. */
  start: (base: string, onText: (text: string) => void) => void;
  stop: () => void;
  error: string | null;
}

export function useSpeech(): UseSpeech {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setSupported(getCtor() !== null);
    return () => recRef.current?.abort();
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback((base: string, onText: (text: string) => void) => {
    const Ctor = getCtor();
    if (!Ctor) return;
    setError(null);

    const rec = new Ctor();
    rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
    rec.continuous = true;
    rec.interimResults = true;

    let finalText = "";
    const prefix = base.trim().length ? base.trimEnd() + " " : "";

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        const chunk = res[0].transcript;
        if (res.isFinal) finalText += chunk;
        else interim += chunk;
      }
      onText((prefix + finalText + interim).replace(/\s+/g, " ").trimStart());
    };
    rec.onerror = (ev) => {
      setError(ev.error === "not-allowed" ? "Microphone permission denied" : ev.error);
      setListening(false);
    };
    rec.onend = () => setListening(false);

    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws if already started; ignore.
    }
  }, []);

  return { supported, listening, start, stop, error };
}
