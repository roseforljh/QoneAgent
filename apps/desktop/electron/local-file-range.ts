import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/**
 * Electron's file:// loader ignores `Range` and always streams the whole file
 * with 200 (electron/electron#38749), so long local videos cannot seek. Media
 * elements always send `Range`; answer it here with a 206 slice from disk.
 */
export async function localRangeResponse(filePath: string, range: string, method = "GET"): Promise<Response> {
  let size: number;
  try { size = (await stat(filePath)).size; } catch { return new Response("Not Found", { status: 404 }); }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${size}`,
  };
  if (method === "HEAD") return new Response(null, { status: 206, headers });
  return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, { status: 206, headers });
}
