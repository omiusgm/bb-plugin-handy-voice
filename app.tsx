import { useEffect, useSyncExternalStore } from "react";
import { definePluginApp, experimental_Icon as Icon, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { getSnapshot, recordingToBase64, registerComposer, startDictation, stopDictation, subscribe } from "./lib/dictation";
import "./app.css";

function useDictation() {
  const composer = useComposer();
  const rpc = useRpc<typeof rpcContract>();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Cleanup меняет только учёт видимости. Микрофон принадлежит синглтону.
  useEffect(() => registerComposer(composer), [composer]);
  const toggle = () => {
    if (state.status === "recording") {
      stopDictation();
    } else if (state.status === "idle" && !state.isStarting) {
      void startDictation(composer, async (audio) => rpc.call("transcribeRecording", {
        base64: await recordingToBase64(audio), mime: audio.type,
      }), (message) => toast.error(message));
    }
  };
  return { state, toggle, composer };
}

function DictationButton() {
  const { state, toggle } = useDictation();
  const recording = state.status === "recording";
  const busy = state.status === "transcribing" || state.isStarting;
  const duration = `${Math.floor(state.elapsedSecs / 60)}:${String(state.elapsedSecs % 60).padStart(2, "0")}`;
  const label = recording ? `Остановить диктовку, ${duration}`
    : busy ? (state.isStarting ? "Доступ к микрофону…" : "Расшифровка…") : "Диктовка";
  return <button
    type="button"
    className="handy-voice-button"
    data-recording={recording}
    aria-label={label}
    aria-pressed={recording}
    aria-busy={busy}
    title={recording ? "Остановить запись и добавить текст в исходный черновик" : label}
    disabled={busy}
    onClick={toggle}
  >
    <Icon name={recording ? "Square" : busy ? "LoaderCircle" : "Mic"}
      className={busy ? "handy-voice-icon handy-voice-spinner" : "handy-voice-icon"} aria-hidden />
    {recording ? <span className="handy-voice-time">{duration}</span> : null}
  </button>;
}

// BB скрывает actions в compact layout; здесь остаётся доступ к стоп-кнопке.
function DictationBanner() {
  const { composer } = useDictation();
  return composer.layout === "compact" ? <DictationButton /> : null;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "dictation",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "dictation", component: DictationButton }],
    banners: [{ id: "dictation-compact", chrome: "bare", component: DictationBanner }],
  });
});
