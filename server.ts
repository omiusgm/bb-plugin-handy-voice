// bb-plugin-handy-voice — локальная расшифровка голоса в BB через Handy.
//
// BB записывает голос в композере и отдаёт файл выбранной AI-службе.
// Этот плагин регистрирует службу «Handy (локально)»: аудио конвертируется
// локальным ffmpeg в WAV 16 кГц моно и расшифровывается headless-режимом
// Handy (`handy --transcribe-file`) на локальной модели (GigaAM и др.).
// Наружу ничего не уходит.
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const DEFAULT_HANDY = "/Applications/Handy.app/Contents/MacOS/handy";
const SYSTEM_FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
/** Потолок BB для голосовой службы — 10 с; свой запас для CLI-вызовов. */
const CLI_TIMEOUT_MS = 10 * 60_000;
/** Собственный предел записи; это не утверждение о лимите транспорта BB. */
const MAX_RECORDING_BYTES = 32 * 1024 * 1024;
const MAX_RECORDING_BASE64_CHARS = Math.ceil(MAX_RECORDING_BYTES / 3) * 4;
const RECORDING_MIME_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg"]);

export const rpcContract = defineRpcContract({
  transcribeRecording: {
    input: z.object({
      base64: z.string().min(4).max(MAX_RECORDING_BASE64_CHARS)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/)
        .refine((value) => value.length % 4 === 0, "Некорректная запись base64"),
      mime: z.string().trim().min(1).max(128).refine(
        (value) => RECORDING_MIME_TYPES.has(value.split(";")[0]!.trim().toLowerCase()),
        "Поддерживаются записи WebM, MP4 и Ogg",
      ),
    }).strict(),
    output: z.object({
      text: z.string(),
      audioSecs: z.number().finite().nonnegative().nullable(),
      ms: z.number().finite().nonnegative(),
    }).strict(),
  },
});

type ExecResult = { stdout: string; stderr: string };

function execFileAsync(
  file: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        signal: options.signal,
        timeout: options.timeoutMs ?? 0,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim().split("\n").slice(-4).join(" ");
          reject(new Error(`${file} failed: ${error.message}${detail ? ` — ${detail}` : ""}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.on("error", reject);
  });
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Возможные корни плагина: BB грузит бандл то как <root>/server.js,
 * то как <root>/dist/server.js, поэтому проверяем оба уровня.
 */
function pluginRoots(): string[] {
  const roots: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    roots.push(here, dirname(here));
  } catch {
    // бандл без import.meta.url
  }
  roots.push(process.cwd());
  return roots;
}

function pluginRoot(): string {
  return pluginRoots()[0] ?? process.cwd();
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
};

function extensionFor(type: string | undefined, name: string | undefined): string {
  const base = (type ?? "").split(";")[0]!.trim().toLowerCase();
  if (EXTENSIONS[base]) return EXTENSIONS[base]!;
  const dot = (name ?? "").lastIndexOf(".");
  if (dot > 0) return (name ?? "").slice(dot).toLowerCase();
  return ".webm";
}

/** Последняя строка stdout с JSON-результатом `--transcribe-file --json`. */
function parseHandyJson(stdout: string): { text: string; audioSecs: number | null } {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]!) as { text?: unknown; audio_secs?: unknown };
      if (typeof parsed.text === "string") {
        return {
          text: parsed.text,
          audioSecs: typeof parsed.audio_secs === "number" ? parsed.audio_secs : null,
        };
      }
    } catch {
      // пробуем предыдущую строку
    }
  }
  throw new Error("Handy не вернул JSON с расшифровкой");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    handyPath: {
      type: "string",
      label: "Путь к бинарнику Handy",
      description: "Пусто — /Applications/Handy.app/Contents/MacOS/handy",
      default: "",
    },
    model: {
      type: "string",
      label: "Модель Handy",
      description:
        "Пусто — модель, выбранная в самом Handy. Список: bb handy-voice models",
      default: "",
    },
    ffmpegPath: {
      type: "string",
      label: "Путь к ffmpeg",
      description: "Пусто — ffmpeg из node_modules плагина, затем системный",
      default: "",
    },
    warmOnLoad: {
      type: "boolean",
      label: "Прогревать модель при старте",
      description: "Один холостой прогон после загрузки плагина: первая диктовка не ждёт чтения модели с диска",
      default: true,
    },
  });
  const values = await settings.get();

  async function resolveHandy(): Promise<string> {
    const configured = String(values.handyPath ?? "").trim();
    const candidate = configured === "" ? DEFAULT_HANDY : configured;
    if (await isExecutable(candidate)) return candidate;
    throw new Error(
      `Не нашёл Handy по пути ${candidate}. Установите Handy.app или задайте путь: bb plugin config handy-voice set handyPath <путь>`,
    );
  }

  async function resolveFfmpeg(): Promise<string> {
    const configured = String(values.ffmpegPath ?? "").trim();
    const candidates = [
      ...(configured === "" ? [] : [configured]),
      ...pluginRoots().map((root) => join(root, "node_modules", "ffmpeg-static", "ffmpeg")),
      ...SYSTEM_FFMPEG,
    ];
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) return candidate;
    }
    throw new Error(
      "Не нашёл ffmpeg. Выполните npm install в папке плагина или задайте путь: bb plugin config handy-voice set ffmpegPath <путь>",
    );
  }

  const modelArgs = (): string[] => {
    const model = String(values.model ?? "").trim();
    return model === "" ? [] : ["--model", model];
  };

  /** Конвертирует любой контейнер в WAV 16 кГц моно и расшифровывает его. */
  async function transcribeBytes(
    bytes: Buffer,
    extension: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ text: string; audioSecs: number | null; ms: number }> {
    const started = Date.now();
    const handy = await resolveHandy();
    const directory = await mkdtemp(join(tmpdir(), "bb-handy-voice-"));
    const input = join(directory, `input${extension}`);
    const wav = join(directory, "audio.wav");
    try {
      await writeFile(input, bytes);
      // Handy ждёт строго WAV 16 кГц моно, поэтому через ffmpeg проходит и WAV.
      const ffmpeg = await resolveFfmpeg();
      await execFileAsync(
        ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          "-i", input,
          "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
          wav,
        ],
        options,
      );
      const { stdout } = await execFileAsync(
        handy,
        ["--transcribe-file", wav, "--json", ...modelArgs()],
        options,
      );
      const parsed = parseHandyJson(stdout);
      return { ...parsed, ms: Date.now() - started };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function transcribeFile(path: string, timeoutMs = CLI_TIMEOUT_MS) {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path);
    const dot = path.lastIndexOf(".");
    const extension = dot > 0 ? path.slice(dot).toLowerCase() : ".wav";
    return transcribeBytes(bytes, extension, { timeoutMs });
  }

  bb.rpc.register(rpcContract, {
    async transcribeRecording({ base64, mime }, { experimental_signal }) {
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0 || bytes.length > MAX_RECORDING_BYTES || bytes.toString("base64") !== base64) {
        throw new experimental_PluginRpcRefusal({
          code: "invalid",
          message: "Запись пуста, повреждена или превышает 32 МиБ",
        });
      }
      // Свой RPC не проходит через 10-секундный путь AI-службы.
      return transcribeBytes(bytes, extensionFor(mime, undefined), {
        signal: experimental_signal,
        timeoutMs: CLI_TIMEOUT_MS,
      });
    },
  });

  bb.experimental_aiServices.register({
    id: "handy",
    displayName: "Handy (локально)",
    transcribe: async (audio, { signal }) => {
      const bytes = Buffer.from(await audio.arrayBuffer());
      const extension = extensionFor(audio.type, audio.name);
      const result = await transcribeBytes(bytes, extension, { signal });
      bb.log.info(
        `transcribed locally: ${bytes.length} B, ${result.audioSecs ?? "?"} s audio, ${result.ms} ms`,
      );
      return result.text.trim();
    },
    status: async () => {
      const handy = String(values.handyPath ?? "").trim() || DEFAULT_HANDY;
      if (!(await isExecutable(handy))) {
        return { ready: false, message: "Handy.app не найден — установите handy.computer" };
      }
      try {
        await resolveFfmpeg();
      } catch {
        return { ready: false, message: "Нет ffmpeg — npm install в папке плагина" };
      }
      return { ready: true };
    },
  });

  if (values.warmOnLoad === true) {
    bb.background.service("warmup", {
      async start(signal) {
        try {
          // 0.5 с тишины: прогоняет модель через диск в page cache.
          const samples = Buffer.alloc(16_000, 0);
          const header = Buffer.alloc(44);
          header.write("RIFF", 0);
          header.writeUInt32LE(36 + samples.length, 4);
          header.write("WAVEfmt ", 8);
          header.writeUInt32LE(16, 16);
          header.writeUInt16LE(1, 20);
          header.writeUInt16LE(1, 22);
          header.writeUInt32LE(16_000, 24);
          header.writeUInt32LE(32_000, 28);
          header.writeUInt16LE(2, 32);
          header.writeUInt16LE(16, 34);
          header.write("data", 36);
          header.writeUInt32LE(samples.length, 40);
          const started = Date.now();
          await transcribeBytes(Buffer.concat([header, samples]), ".wav", {
            signal,
            timeoutMs: 120_000,
          });
          bb.log.info(`warmup done in ${Date.now() - started} ms`);
        } catch (error) {
          bb.log.warn(`warmup skipped: ${String(error)}`);
        }
        // Одноразовая работа: дальше просто ждём остановки.
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
  }

  const usage = [
    "Usage:",
    "  bb handy-voice status [--json]",
    "  bb handy-voice models [--json]",
    "  bb handy-voice transcribe <audio-file> [--json]",
  ].join("\n");

  bb.cli.register({
    name: "handy-voice",
    summary: "Локальная расшифровка голоса через Handy",
    commands: [
      { name: "status", summary: "Проверить Handy, ffmpeg и модель", usage: "bb handy-voice status [--json]" },
      { name: "models", summary: "Список моделей Handy", usage: "bb handy-voice models [--json]" },
      {
        name: "transcribe",
        summary: "Расшифровать аудиофайл локально",
        usage: "bb handy-voice transcribe <audio-file> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "status": {
            const handyPath = String(values.handyPath ?? "").trim() || DEFAULT_HANDY;
            const handyOk = await isExecutable(handyPath);
            let ffmpegPath: string | null = null;
            try {
              ffmpegPath = await resolveFfmpeg();
            } catch {
              ffmpegPath = null;
            }
            const model = String(values.model ?? "").trim();
            const payload = {
              handy: handyOk ? handyPath : null,
              ffmpeg: ffmpegPath,
              model: model === "" ? "(выбранная в Handy)" : model,
              ready: handyOk && ffmpegPath !== null,
            };
            const text = [
              `Handy:  ${payload.handy ?? "НЕ НАЙДЕН"}`,
              `ffmpeg: ${payload.ffmpeg ?? "НЕ НАЙДЕН"}`,
              `модель: ${payload.model}`,
              `готов:  ${payload.ready ? "да" : "нет"}`,
              `корни поиска: ${pluginRoots().join(", ")}`,
            ].join("\n");
            return { exitCode: payload.ready ? 0 : 1, stdout: json ? JSON.stringify(payload) : text };
          }
          case "models": {
            const handy = await resolveHandy();
            const { stdout } = await execFileAsync(handy, ["--list-models", "--json"], {
              timeoutMs: 60_000,
            });
            const start = stdout.indexOf("[");
            const raw = start >= 0 ? stdout.slice(start) : "[]";
            const models = JSON.parse(raw) as Array<{
              id: string;
              name: string;
              is_downloaded: boolean;
              supported_languages?: string[];
            }>;
            const text = models
              .map(
                (entry) =>
                  `${entry.is_downloaded ? "+" : " "} ${entry.id}  — ${entry.name}` +
                  (entry.supported_languages ? ` [${entry.supported_languages.join(",")}]` : ""),
              )
              .join("\n");
            return { exitCode: 0, stdout: json ? JSON.stringify(models) : text };
          }
          case "transcribe": {
            const path = args[0];
            if (path === undefined || args.length !== 1) break;
            const result = await transcribeFile(path);
            return {
              exitCode: 0,
              stdout: json ? JSON.stringify(result) : result.text,
            };
          }
        }
        return { exitCode: 1, stderr: usage };
      } catch (error) {
        return { exitCode: 1, stderr: String(error instanceof Error ? error.message : error) };
      }
    },
  });

  bb.log.info("handy-voice loaded");
}
