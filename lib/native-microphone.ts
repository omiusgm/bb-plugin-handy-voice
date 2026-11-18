// Подключать только после согласования исключения из CONTRACT-ui.md.
// Сам модуль не запускается и не меняет DOM при импорте.
const ROOT = "[data-app-composer]";
const OWN = "button.handy-voice-button";
export const NATIVE_START = '[data-promptbox] button:is([aria-label="Start voice input"], [aria-label="Начать голосовой ввод"]):not(.handy-voice-button)';
const NATIVE_BUSY = '[data-promptbox] button:is([aria-label="Stop and add text"], [aria-label="Transcribing voice input"], [aria-label="Распознавание голосового ввода"]):not(.handy-voice-button)';
const MARK = "data-handy-voice-suppressed";

/** Fail open: неизвестная разметка, перевод или отсутствие своей кнопки ничего не скрывают. */
export function mountNativeMicrophoneGuard(): () => void {
  let disposed = false;
  let frame: number | null = null;
  const marked = new Set<Element>();
  const visible = (button: Element) => {
    const style = getComputedStyle(button);
    return button.getClientRects().length > 0 && style.visibility === "visible" && style.display !== "none";
  };
  const sync = () => {
    frame = null;
    if (disposed) return;
    const next = new Map<Element, string>();
    for (const root of Array.from(document.querySelectorAll(ROOT))) {
      // Вложенный вторичный композер не наследует готовность основного.
      const local = (selector: string) => Array.from(root.querySelectorAll<HTMLButtonElement>(selector))
        .filter((button) => button.closest(ROOT) === root);
      const own = local(OWN);
      if (local(NATIVE_BUSY).some(visible)) {
        for (const button of own) {
          if (button.dataset.recording !== "true" && button.getAttribute("aria-busy") !== "true") {
            next.set(button, "plugin");
          }
        }
      } else if (own.some((button) => button.dataset.handyVoiceReady === "true" && visible(button))) {
        for (const button of local(NATIVE_START)) {
          // Не прячем кнопку из-под клавиатурного фокуса.
          if (button !== document.activeElement) next.set(button, "native");
        }
      }
    }
    for (const element of marked) if (!next.has(element)) element.removeAttribute(MARK);
    for (const [element, value] of next) if (element.getAttribute(MARK) !== value) element.setAttribute(MARK, value);
    marked.clear();
    for (const element of next.keys()) marked.add(element);
  };
  const schedule = () => {
    // Фокус окончательно меняется после focusout/focusin; проверяем на кадре.
    if (frame === null && !disposed) frame = requestAnimationFrame(sync);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["aria-label", "aria-busy", "disabled", "class", "style", "hidden", "data-recording", "data-handy-voice-ready"],
  });
  window.addEventListener("resize", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  sync();
  return () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("focusin", schedule);
    document.removeEventListener("focusout", schedule);
    for (const element of marked) element.removeAttribute(MARK);
    marked.clear();
  };
}
