import type { PluginComposerApi } from "@get-bb/plugin-sdk";

export type Transcription = { text: string; audioSecs: number | null; ms: number };
export type DictationSnapshot = Readonly<{
  status: "idle" | "recording" | "transcribing";
  elapsedSecs: number;
  isStarting: boolean;
  targetKey: string | null;
  lastError: string | null;
}>;

type Session = {
  composer: PluginComposerApi;
  transcribe: (audio: Blob) => Promise<Transcription>;
  onError: (message: string) => void;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: Blob[];
  startedAt: number;
  timer: ReturnType<typeof setInterval> | null;
};

// Владелец записи — модуль, а не экземпляр React-компонента.
let session: Session | null = null;
let snapshot: DictationSnapshot = Object.freeze({
  status: "idle", elapsedSecs: 0, isStarting: false, targetKey: null, lastError: null,
});
const subscribers = new Set<() => void>();
const visibleComposers = new Map<string, number>();

export function getSnapshot(): DictationSnapshot { return snapshot; }

export function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  // Отписка UI никогда не останавливает запись.
  return () => { subscribers.delete(listener); };
}

/** Учёт видимости нужен только для focus(), не для владения записью. */
export function registerComposer(composer: PluginComposerApi): () => void {
  const key = composer.key;
  visibleComposers.set(key, (visibleComposers.get(key) ?? 0) + 1);
  return () => {
    const count = (visibleComposers.get(key) ?? 1) - 1;
    if (count === 0) visibleComposers.delete(key);
    else visibleComposers.set(key, count);
  };
}

function publish(next: Partial<DictationSnapshot>): void {
  snapshot = Object.freeze({ ...snapshot, ...next });
  for (const listener of subscribers) listener();
}

function releaseMicrophone(current: Session): void {
  if (current.timer !== null) clearInterval(current.timer);
  current.timer = null;
  current.stream?.getTracks().forEach((track) => track.stop());
  current.stream = null;
}

function reset(current: Session): void {
  releaseMicrophone(current);
  current.chunks = [];
  if (session !== current) return;
  session = null;
  publish({ status: "idle", elapsedSecs: 0, isStarting: false, targetKey: null });
}

function fail(current: Session, message: string): void {
  if (session !== current) return;
  // Сначала отсоединяем обработчики: stop() может породить поздний onstop.
  const recorder = current.recorder;
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // Даже при сбое MediaRecorder освобождаем микрофон и блокировку.
    }
  }
  reset(current);
  publish({ lastError: message });
  current.onError(message);
}

/** Проверка возможностей не запрашивает доступ и не включает микрофон. */
export function recordingSupportError(): string | null {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return "Запись недоступна. Откройте BB в приложении или браузере с поддержкой микрофона.";
  }
  if (!["audio/webm", "audio/mp4", "audio/ogg"].some((mime) => MediaRecorder.isTypeSupported(mime))) {
    return "Браузер не поддерживает запись WebM, MP4 или Ogg.";
  }
  return null;
}

async function finishRecording(current: Session): Promise<void> {
  if (session !== current) return;
  releaseMicrophone(current);
  publish({ status: "transcribing", isStarting: false });
  try {
    // onstop приходит после последнего dataavailable, включая финальный чанк.
    const audio = new Blob(current.chunks, { type: current.recorder!.mimeType });
    current.chunks = [];
    if (audio.size === 0) {
      fail(current, "Запись пуста. Проверьте микрофон и повторите диктовку.");
      return;
    }
    const result = await current.transcribe(audio);
    const text = result.text.trim();
    if (!text) {
      fail(current, "Речь не распознана. Повторите диктовку.");
      return;
    }
    // Этот handle захвачен в startDictation, а не взят из текущего треда.
    current.composer.insert(text, { at: "end" });
    if (visibleComposers.has(current.composer.key)) current.composer.focus();
    reset(current);
  } catch {
    fail(current, "Не удалось расшифровать или вставить запись. Проверьте Handy и повторите диктовку.");
  }
}

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Нет доступа к микрофону. Разрешите его для BB и повторите диктовку.";
  }
  if (name === "NotFoundError") return "Микрофон не найден. Подключите его и повторите диктовку.";
  if (name === "NotReadableError") return "Микрофон недоступен. Проверьте его подключение и повторите диктовку.";
  return "Не удалось начать запись. Проверьте микрофон и повторите диктовку.";
}

export async function startDictation(
  composer: PluginComposerApi,
  transcribe: Session["transcribe"],
  onError: Session["onError"],
): Promise<void> {
  if (session !== null) return;
  const current: Session = {
    composer, transcribe, onError, recorder: null, stream: null,
    chunks: [], startedAt: 0, timer: null,
  };
  // Блокировка и целевой handle сохраняются до запроса разрешения микрофона.
  session = current;
  publish({ isStarting: true, targetKey: composer.key, lastError: null });
  try {
    const supportError = recordingSupportError();
    if (supportError) {
      fail(current, supportError);
      return;
    }
    const mimeType = ["audio/webm", "audio/mp4", "audio/ogg"]
      .find((mime) => MediaRecorder.isTypeSupported(mime));
    if (!mimeType) {
      fail(current, "Браузер не поддерживает запись WebM, MP4 или Ogg.");
      return;
    }
    current.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(current.stream, { mimeType });
    current.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (session === current && event.data.size > 0) current.chunks.push(event.data);
    };
    recorder.onerror = () => fail(current, "Запись прервалась из-за ошибки микрофона. Повторите диктовку.");
    recorder.onstop = () => { void finishRecording(current); };
    recorder.start(1_000);
    current.startedAt = Date.now();
    current.timer = setInterval(() => {
      publish({ elapsedSecs: Math.floor((Date.now() - current.startedAt) / 1_000) });
    }, 1_000);
    publish({ status: "recording", isStarting: false, elapsedSecs: 0 });
  } catch (error) {
    fail(current, microphoneError(error));
  }
}

export function stopDictation(): void {
  const current = session;
  if (!current?.recorder || snapshot.status !== "recording") return;
  publish({ status: "transcribing" });
  if (current.timer !== null) clearInterval(current.timer);
  current.timer = null;
  try {
    current.recorder.stop();
  } catch {
    fail(current, "Не удалось завершить запись. Проверьте микрофон и повторите диктовку.");
  }
}

export function recordingToBase64(audio: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать запись"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) {
        reject(new Error("Не удалось прочитать запись"));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(audio);
  });
}
