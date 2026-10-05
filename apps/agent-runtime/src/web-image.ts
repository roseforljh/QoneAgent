import type { ImageContent } from "@earendil-works/pi-ai";

export const MAX_WEB_IMAGE_BYTES = 10 * 1024 * 1024;
export const WEB_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Validate binary input before forwarding it to a model as an image. */
export function webImage(bytes: Uint8Array, mimeType: string): ImageContent {
  if (!bytes.length || bytes.length > MAX_WEB_IMAGE_BYTES) throw new Error("Image is empty or exceeds 10 MiB");
  const header = Buffer.from(bytes.subarray(0, 12));
  const valid = mimeType === "image/png" ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === "image/jpeg" ? header[0] === 255 && header[1] === 216 && header[2] === 255
    : mimeType === "image/gif" ? ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii"))
    : mimeType === "image/webp" && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new Error("Unsupported or invalid image response");
  return { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") };
}

export function browserScreenshotResult(output: string) {
  const raw = output.trim();
  let data = raw;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const candidate = parsed.screenshot ?? parsed.image ?? parsed.data;
      if (typeof candidate === "string") data = candidate;
    } catch { /* Treat non-JSON output as raw base64 below. */ }
  }
  data = data.replace(/^data:image\/png;base64,/, "").replace(/\s+/g, "");
  if (data.length > Math.ceil(MAX_WEB_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("Invalid or oversized OpenCLI screenshot");
  }
  return {
    content: [{ type: "text" as const, text: "Current Chrome page screenshot. Inspect the image; only the captured area is visible." }, webImage(Buffer.from(data, "base64"), "image/png")],
    details: { contentType: "image/png" },
  };
}
