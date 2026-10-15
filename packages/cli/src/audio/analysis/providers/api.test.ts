import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  rhythm,
  signalProvider,
  type AudioSignal,
  type AudioCapability,
} from "@hyperframes/core/audio-analysis";
import { analyzeSignal } from "../analyze.js";
import { apiProvider, type AudioApiRequest, type AudioApiResponse } from "./api.js";

const RATE = 22_050;

/** Clicks every half second from 0.25 s: a grid the signal tracker finds. */
function clicks(seconds: number): AudioSignal {
  const samples = new Float32Array(seconds * RATE);
  let state = 7;
  for (let t = 0.25; t < seconds; t += 0.5)
    for (let i = 0; i < 0.05 * RATE; i++) {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      samples[Math.round(t * RATE) + i]! +=
        0.5 * ((state / 2_147_483_648) * 2 - 1) * Math.exp(-i / (0.01 * RATE));
    }
  return { sampleRate: RATE, channels: [samples] };
}

interface Received {
  method: string;
  authorization: string | undefined;
  request: AudioApiRequest;
  audio: { type: string; bytes: Uint8Array };
}

let server: Server;
let received: Received[] = [];
let reply: (request: AudioApiRequest) => { status: number; body: unknown } = () => ({
  status: 500,
  body: {},
});

async function readForm(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const form = await new Request("http://stand-in", {
    method: "POST",
    headers: { "content-type": req.headers["content-type"]! },
    body: Buffer.concat(chunks),
  }).formData();
  const audio = form.get("audio") as Blob;
  return {
    request: JSON.parse(await (form.get("request") as Blob).text()) as AudioApiRequest,
    audio: { type: audio.type, bytes: new Uint8Array(await audio.arrayBuffer()) },
  };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const form = await readForm(req);
    received.push({ method: req.method!, authorization: req.headers.authorization, ...form });
    const { status, body } = reply(form.request);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

afterEach(() => {
  received = [];
  delete process.env.HYPERFRAMES_AUDIO_API_URL;
  delete process.env.HYPERFRAMES_AUDIO_API_KEY;
});

function configure() {
  process.env.HYPERFRAMES_AUDIO_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio`;
  process.env.HYPERFRAMES_AUDIO_API_KEY = "test-key";
}

describe("apiProvider", () => {
  it("is unavailable until both the URL and the key are set", () => {
    expect(apiProvider.available!()).toEqual({
      ok: false,
      reason: "HYPERFRAMES_AUDIO_API_URL is not set",
    });
    process.env.HYPERFRAMES_AUDIO_API_URL = "http://127.0.0.1:1/";
    expect(apiProvider.available!()).toEqual({
      ok: false,
      reason: "HYPERFRAMES_AUDIO_API_KEY is not set",
    });
    process.env.HYPERFRAMES_AUDIO_API_KEY = "k";
    expect(apiProvider.available!()).toEqual({ ok: true });
  });

  it("posts the audio and the capabilities, and snaps each answered beat onto the signal's own", async () => {
    configure();
    const signal = clicks(12);
    const measured = rhythm(signal).beats.times;
    // The service is 30 ms late on every beat, and invents one between two real beats.
    const answered = [...measured.map((t) => t + 0.03), 3.5].sort((a, b) => a - b);
    reply = () => ({
      status: 200,
      body: {
        version: 1,
        source: "stand-in",
        beats: { times: answered },
        downbeats: { times: measured.filter((_, k) => k % 4 === 0).map((t) => t - 0.02), meter: 4 },
      } satisfies AudioApiResponse,
    });
    const analysis = await analyzeSignal(signal, { capabilities: ["beats", "downbeats", "bpm"] }, [
      apiProvider,
      signalProvider,
    ]);

    expect(received).toHaveLength(1);
    const [call] = received;
    expect(call).toMatchObject({ method: "POST", authorization: "Bearer test-key" });
    expect(call!.request).toEqual({
      version: 1,
      capabilities: ["beats", "downbeats"],
      audio: { sampleRate: RATE, channels: 1, duration: 12 },
    });
    expect(call!.audio.type).toBe("audio/wav");
    expect(Buffer.from(call!.audio.bytes.subarray(0, 4)).toString()).toBe("RIFF");
    expect(call!.audio.bytes.length).toBe(44 + 12 * RATE * 2);

    expect(analysis.provenance).toEqual({ beats: "api", downbeats: "api", bpm: "api" });
    const beats = analysis.values.beats as { times: number[]; snap: object; source: string };
    expect(beats.times).toEqual([...measured, 3.5].sort((a, b) => a - b));
    expect(beats.source).toBe("stand-in");
    expect(beats.snap).toEqual({
      reference: "signal beats",
      toleranceMs: 125,
      snapped: measured.length,
      unsnapped: [3.5],
      medianShiftMs: 30,
    });
    expect((analysis.values.downbeats as { times: number[] }).times).toEqual(
      measured.filter((_, k) => k % 4 === 0),
    );
    expect((analysis.values.bpm as { value: number }).value).toBeCloseTo(120, 0);
  });

  it.each<{ capabilities: AudioCapability[] }>([
    { capabilities: ["bpm"] },
    { capabilities: ["beats", "bpm"] },
    { capabilities: ["bpm", "beats"] },
  ])("keeps a BPM signal pin local for $capabilities", async ({ capabilities }) => {
    configure();
    reply = () => ({ status: 200, body: { version: 1, beats: { times: [0.5, 1, 1.5] } } });
    const analysis = await analyzeSignal(clicks(8), {
      capabilities,
      provider: { bpm: "signal" },
    });
    expect(received).toHaveLength(0);
    expect(analysis.provenance.bpm).toBe("signal");
    expect(analysis.values.bpm).toMatchObject({ value: expect.any(Number) });
    if (capabilities.includes("beats")) expect(analysis.provenance.beats).toBe("signal");
  });

  it.each([
    { beats: "api", bpm: "signal" },
    { beats: "signal", bpm: "api" },
  ])(
    "rejects conflicting beats/BPM pins before any capability uploads audio: %j",
    async (provider) => {
      configure();
      reply = () => ({
        status: 200,
        body: { version: 1, describe: { tags: [] }, beats: { times: [0.5, 1] } },
      });
      await expect(
        analyzeSignal(clicks(8), {
          capabilities: ["describe", "beats", "bpm"],
          provider,
        }),
      ).rejects.toThrow("beats and bpm must use the same provider");
      expect(received).toHaveLength(0);
    },
  );

  it("asks for sections and describe on their own, and moves inner section boundaries onto beats", async () => {
    configure();
    const signal = clicks(12);
    const beat = rhythm(signal).beats.times.find((t) => Math.abs(t - 6.25) < 0.05)!;
    reply = () => ({
      status: 200,
      body: {
        version: 1,
        sections: {
          spans: [
            { start: 0, end: 6.3, label: "intro" },
            { start: 6.3, end: 12 },
          ],
        },
        describe: { text: "clicks", tags: [{ label: "click", score: 0.9 }] },
      },
    });
    const analysis = await analyzeSignal(signal, { capabilities: ["sections", "describe"] }, [
      apiProvider,
      signalProvider,
    ]);
    expect(received.map((r) => r.request.capabilities)).toEqual([["sections"], ["describe"]]);
    expect(analysis.values.sections).toMatchObject({
      spans: [
        { start: 0, end: beat, label: "intro" },
        { start: beat, end: 12 },
      ],
      snap: { snapped: 2, unsnapped: [] },
    });
    expect(analysis.values.describe).toEqual({
      text: "clicks",
      tags: [{ label: "click", score: 0.9 }],
    });
  });

  it("falls through to signal processing with a warning when the service fails or answers in another shape", async () => {
    configure();
    reply = () => ({ status: 503, body: { error: { message: "busy" } } });
    const failed = await analyzeSignal(clicks(8), { capabilities: ["beats"] }, [
      apiProvider,
      signalProvider,
    ]);
    expect(failed.provenance.beats).toBe("signal");
    expect(failed.warnings).toEqual([
      "beats: used signal; api failed (the service answered 503: busy)",
    ]);

    reply = () => ({ status: 200, body: { version: 1, beats: { times: ["soon"] } } });
    const garbled = await analyzeSignal(clicks(8), { capabilities: ["beats"] }, [
      apiProvider,
      signalProvider,
    ]);
    expect(garbled.provenance.beats).toBe("signal");
    expect(garbled.warnings[0]).toContain("api failed (the service answered beats in a shape");
  });

  it("never sends the key anywhere but the authorization header", async () => {
    configure();
    reply = () => ({ status: 401, body: { error: { message: "bad key" } } });
    const analysis = await analyzeSignal(clicks(8), { capabilities: ["describe"] }, [apiProvider]);
    expect(JSON.stringify(analysis)).not.toContain("test-key");
  });
});
