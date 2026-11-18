import { useEffect, useState, useSyncExternalStore } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { probeDictationAvailability } from "./lib/availability";
import { getSnapshot, recordingSupportError, recordingToBase64, registerComposer, startDictation, stopDictation, subscribe } from "./lib/dictation";
import { mountNativeMicrophoneGuard } from "./lib/native-microphone";
import "./app.css";

function useDictation() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [availability, setAvailability] = useState({ ready: false, message: "Проверка диктовки…" as string | null });
  useEffect(() => {
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      const message = recordingSupportError();
      if (message) { setAvailability({ ready: false, message }); return; }
      checking = true;
      try {
        const result = await probeDictationAvailability(() => rpc.call("dictationStatus", {}));
        if (!disposed) setAvailability(result);
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 30_000);
    window.addEventListener("focus", check);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [rpc]);
  // Cleanup меняет только учёт видимости. Микрофон принадлежит синглтону.
  useEffect(() => registerComposer(composer), [composer]);
  const toggle = () => {
    if (state.status === "recording") {
      stopDictation();
    } else if (state.status === "idle" && !state.isStarting && availability.ready) {
      void startDictation(composer, async (audio) => rpc.call("transcribeRecording", {
        base64: await recordingToBase64(audio), mime: audio.type,
      }), (message) => toast.error(message));
    }
  };
  return { state, toggle, availability };
}

function DictationButton() {
  const { state, toggle, availability } = useDictation();
  const recording = state.status === "recording";
  const busy = state.status === "transcribing" || state.isStarting;
  const duration = `${Math.floor(state.elapsedSecs / 60)}:${String(state.elapsedSecs % 60).padStart(2, "0")}`;
  const label = recording ? `Остановить диктовку, ${duration}`
    : busy ? (state.isStarting ? "Доступ к микрофону…" : "Расшифровка…")
    : !availability.ready ? availability.message ?? "Диктовка недоступна" : "Диктовка";
  return <button
    type="button"
    className="handy-voice-button"
    data-handy-voice-ready={recording || busy || (availability.ready && !state.lastError)}
    data-recording={recording}
    aria-label={label}
    aria-pressed={recording}
    aria-busy={busy}
    title={recording ? "Остановить запись и добавить текст в исходный черновик" : label}
    disabled={busy || (!recording && !availability.ready)}
    onClick={toggle}
  >
    <Icon name={recording ? "Square" : busy ? "LoaderCircle" : "Mic"}
      className={busy ? "handy-voice-icon handy-voice-spinner" : "handy-voice-icon"} aria-hidden />
    {recording ? <span className="handy-voice-time">{duration}</span> : null}
  </button>;
}

// BB скрывает actions в compact layout; здесь остаётся доступ к стоп-кнопке.
function DictationBanner() {
  const composer = useComposer();
  return composer.layout === "compact" ? <DictationButton /> : null;
}

function DictationAction() {
  const composer = useComposer();
  return composer.layout === "compact" ? null : <DictationButton />;
}

export default definePluginApp((app) => {
  app.contentScripts.register({ id: "native-microphone-guard", mount: () => mountNativeMicrophoneGuard() });
  app.composer.customize({
    id: "dictation",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "dictation", component: DictationAction }],
    banners: [{ id: "dictation-compact", chrome: "bare", component: DictationBanner }],
  });
});
