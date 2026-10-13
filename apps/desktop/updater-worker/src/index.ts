/**
 * Glintmotion update delivery: serves the `glintmotion-releases` R2 bucket read-only.
 *
 *   stable/releases.json       Squirrel.Mac feed (serverType "json"), polled by the app
 *   stable/whats-new.json      notes shown in the app's "Quoi de neuf" window
 *   stable/<version>/<files>   the signed, notarised app zip and the notes video
 *
 * Range requests are answered here so an update download cut by sleep or a network change
 * picks up where it stopped (Squirrel.Mac resumes when the server honours Range and ETag).
 */

export interface Env {
  RELEASES: R2Bucket;
}

function byteRange(range: R2Range, size: number): { offset: number; length: number } {
  if ("suffix" in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = "offset" in range && range.offset !== undefined ? range.offset : 0;
  const length = "length" in range && range.length !== undefined ? range.length : size - offset;
  return { offset, length: Math.min(length, size - offset) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
    if (!key) return new Response("Glintmotion updates", { status: 200 });

    const wantsRange = request.headers.has("range");
    const object = await env.RELEASES.get(key, wantsRange ? { range: request.headers } : undefined);
    if (!object) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("last-modified", object.uploaded.toUTCString());
    headers.set("accept-ranges", "bytes");
    // The feeds change with each release; a version's files never do.
    headers.set(
      "cache-control",
      key.endsWith(".json") ? "public, max-age=60" : "public, max-age=31536000, immutable",
    );
    if (key.endsWith(".json")) headers.set("content-type", "application/json; charset=utf-8");

    let status = 200;
    if (wantsRange && object.range) {
      const { offset, length } = byteRange(object.range, object.size);
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("content-length", String(length));
      status = 206;
    } else {
      headers.set("content-length", String(object.size));
    }
    return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
  },
} satisfies ExportedHandler<Env>;
