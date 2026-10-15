import {
  medianInterval,
  rhythm,
  snapper,
  type AudioAnalysisProvider,
  type AudioCapability,
  type AudioSignal,
  type Snapper,
} from "@hyperframes/core/audio-analysis";
import { AVAILABLE, encodeWav, perSignal, rounded, unavailable } from "./shared.js";

/**
 * The audio analysis service contract.
 *
 * Request: `POST <HYPERFRAMES_AUDIO_API_URL>`, exactly as configured, with
 * `Authorization: Bearer <HYPERFRAMES_AUDIO_API_KEY>` and a `multipart/form-data` body of two parts:
 * - `request`: `application/json`, an {@link AudioApiRequest};
 * - `audio`: `audio/wav`, 16-bit PCM of the analyzed span, channels as decoded.
 *
 * Response: `200` with `application/json`, an {@link AudioApiResponse}. Every time is in seconds from the start of the
 * uploaded audio. A capability the service cannot answer is left out of the response. Any other status is a failure;
 * its body may be `{ "error": { "message": string } }`.
 */
export interface AudioApiRequest {
  version: 1;
  capabilities: AudioApiCapability[];
  audio: { sampleRate: number; channels: number; duration: number };
}

export type AudioApiCapability = "beats" | "downbeats" | "sections" | "describe";

export interface AudioApiResponse {
  version: 1;
  /** What answered, as the service wants it reported. */
  source?: string;
  beats?: { times: number[] };
  downbeats?: { times: number[]; meter?: number | null };
  sections?: { spans: { start: number; end: number; label?: string }[] };
  describe?: { text?: string; tags: { label: string; score: number }[] };
}

const URL_ENV = "HYPERFRAMES_AUDIO_API_URL";
const KEY_ENV = "HYPERFRAMES_AUDIO_API_KEY";
const TIMEOUT_ENV = "HYPERFRAMES_AUDIO_API_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS = 120_000;

/** Beats and downbeats come from one request; the others each from their own. */
const askedTogether = (capability: AudioApiCapability): AudioApiCapability[] =>
  capability === "beats" || capability === "downbeats" ? ["beats", "downbeats"] : [capability];

function config() {
  const url = process.env[URL_ENV]?.trim();
  const key = process.env[KEY_ENV]?.trim();
  const timeout = Number(process.env[TIMEOUT_ENV]);
  return { url, key, timeoutMs: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS };
}

const isNumberList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((t) => typeof t === "number" && Number.isFinite(t));

function checked(capability: AudioApiCapability, body: AudioApiResponse): void {
  const value = body[capability] as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object")
    throw new Error(`the service did not answer ${capability}`);
  const valid = {
    beats: () => isNumberList(value.times),
    downbeats: () => isNumberList(value.times),
    sections: () =>
      Array.isArray(value.spans) &&
      value.spans.every((s: { start?: unknown; end?: unknown }) => isNumberList([s.start, s.end])),
    describe: () =>
      Array.isArray(value.tags) &&
      value.tags.every(
        (t: { label?: unknown; score?: unknown }) =>
          typeof t.label === "string" && typeof t.score === "number",
      ),
  }[capability];
  if (!valid())
    throw new Error(`the service answered ${capability} in a shape this CLI cannot read`);
}

async function failure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  let detail = text.slice(0, 200);
  try {
    detail = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? detail;
  } catch {
    // not JSON: keep the text
  }
  return new Error(`the service answered ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function ask(signal: AudioSignal, capabilities: AudioApiCapability[]) {
  const { url, key, timeoutMs } = config();
  if (!url || !key) throw new Error(`${URL_ENV} and ${KEY_ENV} must both be set`);
  const request: AudioApiRequest = {
    version: 1,
    capabilities,
    audio: {
      sampleRate: signal.sampleRate,
      channels: signal.channels.length,
      duration: (signal.channels[0]?.length ?? 0) / signal.sampleRate,
    },
  };
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  form.append(
    "audio",
    new Blob([new Uint8Array(encodeWav(signal))], { type: "audio/wav" }),
    "audio.wav",
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as AudioApiResponse;
}

const requests = new Map<string, (signal: AudioSignal) => Promise<AudioApiResponse>>();

function answerFor(signal: AudioSignal, capability: AudioApiCapability) {
  const together = askedTogether(capability);
  const key = together.join(",");
  let request = requests.get(key);
  if (!request) requests.set(key, (request = perSignal((s) => ask(s, together))));
  return request(signal);
}

/** The signal's own beats, which an answer's times move onto when one is within a quarter of the answer's beat. */
function beatSnapper(signal: AudioSignal, beatSeconds: number | null): Snapper {
  const measured = rhythm(signal).beats.times;
  const period = beatSeconds ?? medianInterval(measured) ?? 0;
  return snapper(measured, period / 4, "signal beats");
}

function snappedBeats(signal: AudioSignal, body: AudioApiResponse) {
  const times = body.beats!.times;
  const onBeat = beatSnapper(signal, medianInterval(times));
  return { times: rounded(times.map(onBeat.snap)), snap: onBeat.report() };
}

function snappedDownbeats(signal: AudioSignal, body: AudioApiResponse) {
  const { times, meter = null } = body.downbeats!;
  const beat = body.beats ? medianInterval(body.beats.times) : null;
  const bar = medianInterval(times);
  const onBeat = beatSnapper(signal, beat ?? (bar && meter ? bar / meter : null));
  return { times: rounded(times.map(onBeat.snap)), meter, snap: onBeat.report() };
}

function snappedSections(signal: AudioSignal, body: AudioApiResponse) {
  const onBeat = beatSnapper(signal, null);
  const end = (signal.channels[0]?.length ?? 0) / signal.sampleRate;
  const move = (t: number) => (t <= 0 || t >= end ? t : onBeat.snap(t));
  const spans = body.sections!.spans.map((s) => ({
    ...s,
    start: rounded([move(s.start)])[0]!,
    end: rounded([move(s.end)])[0]!,
  }));
  return { spans, snap: onBeat.report() };
}

/** The answer for one capability, its times moved onto what the signal measured. */
function measured(capability: AudioApiCapability, signal: AudioSignal, body: AudioApiResponse) {
  const value =
    capability === "beats"
      ? snappedBeats(signal, body)
      : capability === "downbeats"
        ? snappedDownbeats(signal, body)
        : capability === "sections"
          ? snappedSections(signal, body)
          : body.describe!;
  return body.source ? { ...value, source: body.source } : value;
}

const API_CAPABILITIES: readonly AudioCapability[] = ["beats", "downbeats", "sections", "describe"];

/** HeyGen's audio analysis service, or any service that speaks {@link AudioApiRequest}, configured by environment. */
export const apiProvider: AudioAnalysisProvider<AudioSignal> = {
  id: "api",
  local: false,
  capabilities: API_CAPABILITIES,
  available() {
    const { url, key } = config();
    if (!url) return unavailable(`${URL_ENV} is not set`);
    if (!key) return unavailable(`${KEY_ENV} is not set`);
    return AVAILABLE;
  },
  async analyze(capability, signal) {
    const asked = capability as AudioApiCapability;
    const body = await answerFor(signal, asked);
    checked(asked, body);
    return measured(asked, signal, body);
  },
};
