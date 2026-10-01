import { isRuntimeMessageKey, runtimeMessage } from "@qone/protocol";
import { getLanguageSetting, resolveLocale, translateCurrent } from "../localization";

/** Preserve provider/system diagnostics; translate only our own structured errors. */
export function localizeError(error: unknown): string {
  const locale = resolveLocale(getLanguageSetting());
  if (error && typeof error === "object") {
    const record = error as { code?: unknown; values?: unknown; localization?: unknown; message?: unknown };
    if (record.localization && typeof record.localization === "object" && isRuntimeMessageKey((record.localization as { code?: unknown }).code)) return localizeError(record.localization);
    if (isRuntimeMessageKey(record.code)) {
      return runtimeMessage(locale, record.code, record.values && typeof record.values === "object" ? record.values as Record<string, unknown> : undefined);
    }
    if (typeof record.code === "string" && record.code.startsWith("native.")) {
      const key = record.code as keyof typeof nativeKeys;
      if (Object.hasOwn(nativeKeys, key)) {
        const values = record.values && typeof record.values === "object" ? record.values as Record<string, string | number> : undefined;
        return translateCurrent(nativeKeys[key], values);
      }
    }
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}

const nativeKeys = {
  "native.attachmentRead": "native.attachmentRead",
  "native.attachmentType": "native.attachmentType",
  "native.previewPath": "native.previewPath",
  "native.previewFolder": "native.previewFolder",
  "native.previewFailed": "native.previewFailed",
  "native.filePreviewPath": "native.filePreviewPath",
  "native.filePreviewType": "native.filePreviewType",
  "native.filePreviewScope": "native.filePreviewScope",
  "native.filePreviewFailed": "native.filePreviewFailed",
  "native.imageDecode": "native.imageDecode",
  "native.imageEmpty": "native.imageEmpty",
  "native.imageSave": "native.imageSave",
} as const;
