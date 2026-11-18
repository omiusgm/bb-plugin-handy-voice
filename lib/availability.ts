export type DictationAvailability = { ready: boolean; message: string | null };

/** Поздний ответ после таймаута не может снова скрыть резервную кнопку. */
export async function probeDictationAvailability(
  call: () => Promise<DictationAvailability>,
  timeoutMs = 5_000,
): Promise<DictationAvailability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unavailable = { ready: false, message: "Нет связи с диктовкой. Проверьте Handy Voice." };
  try {
    return await Promise.race([
      call(),
      new Promise<DictationAvailability>((resolve) => { timer = setTimeout(() => resolve(unavailable), timeoutMs); }),
    ]);
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
  }
}
