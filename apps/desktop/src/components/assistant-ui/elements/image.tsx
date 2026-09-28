"use client";

import {
  memo,
  useState,
  useEffect,
  useCallback,
  useRef,
  type PropsWithChildren,
} from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { cva, type VariantProps } from "class-variance-authority";
import {
  DownloadIcon,
  ImageIcon,
  ImageOffIcon,
  Loader2Icon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import type {
  ImageMessagePart,
  ImageMessagePartComponent,
} from "@assistant-ui/react";
import { cn } from "../../../lib/utils";
import { useStore } from "../../../store";

const extensionForMimeType = (mimeType?: string): string => {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
};

const dataUriToBlob = (dataUri: string): Blob | null => {
  const commaIndex = dataUri.indexOf(",");
  const meta = commaIndex >= 0 ? dataUri.slice(0, commaIndex) : dataUri;
  const data = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : "";
  const mime =
    meta.match(/data:([^;]+)/i)?.[1]?.toLowerCase() ??
    "application/octet-stream";
  if (!/;base64/i.test(meta)) {
    const parts: BlobPart[] = [];
    let last = 0;
    for (const match of data.matchAll(/(?:%[\da-f]{2})+/gi)) {
      if (match.index > last) parts.push(data.slice(last, match.index));
      const run = match[0];
      const escaped = new Uint8Array(run.length / 3);
      for (let index = 0; index < escaped.length; index++) {
        escaped[index] = Number.parseInt(
          run.slice(index * 3 + 1, index * 3 + 3),
          16,
        );
      }
      parts.push(escaped);
      last = match.index + run.length;
    }
    parts.push(data.slice(last));
    return new Blob(parts, { type: mime });
  }
  let bytes: string;
  try {
    const base64 = data.replace(/%([\da-f]{2})/gi, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    bytes = atob(base64);
  } catch {
    return null;
  }
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
};

const mimeFromImage = (image: string): string | undefined =>
  image.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase();

const defaultFilenameFromImage = (image: string): string => {
  const mime = mimeFromImage(image);
  if (mime) return `image.${extensionForMimeType(mime)}`;
  try {
    const path = new URL(image, document.baseURI).pathname;
    const encodedBasename = path.split("/").pop() ?? "";
    let basename = encodedBasename;
    try {
      basename = decodeURIComponent(encodedBasename);
    } catch {}
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(basename)) return basename;
  } catch {}
  return "image.png";
};

const saveImagePart = async (
  part: Pick<ImageMessagePart, "image" | "filename">,
): Promise<void> => {
  const filename = part.filename ?? defaultFilenameFromImage(part.image);
  const isDataUri = /^data:/i.test(part.image);
  const native = isTauri();
  const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }> }).showSaveFilePicker;
  if (!native && !picker) {
    const blob = isDataUri ? dataUriToBlob(part.image) : null;
    if (isDataUri && !blob) throw new Error("Image data could not be read");
    const objectUrl = blob ? URL.createObjectURL(blob) : null;
    const a = document.createElement("a");
    a.href = objectUrl ?? part.image;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 40_000);
    return;
  }
  const blob = isDataUri ? dataUriToBlob(part.image) : await fetch(part.image).then((response) => {
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    return response.blob();
  });
  if (!blob) throw new Error("Image data could not be read");
  if (native) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const encoded = String(reader.result).split(",", 2)[1];
        if (encoded) resolve(encoded);
        else reject(new Error("Image data could not be read"));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    await invoke("save_image_as", { filename, data });
    return;
  }
  if (picker) {
    try {
      const file = await picker.call(window, { suggestedName: filename });
      const writable = await file.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
  }
};

function reportSaveError(error: unknown): void {
  useStore.setState({ lastError: error instanceof Error ? error.message : String(error) });
}

const imageVariants = cva(
  "aui-image-root relative overflow-hidden rounded-lg",
  {
    variants: {
      variant: {
        outline: "border-border border",
        ghost: "",
        muted: "bg-muted/50",
      },
      size: {
        sm: "max-w-64",
        default: "max-w-96",
        lg: "max-w-[512px]",
        full: "w-full",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

export type ImageRootProps = React.ComponentProps<"div"> &
  VariantProps<typeof imageVariants>;

function ImageRoot({
  className,
  variant,
  size,
  children,
  ...props
}: ImageRootProps) {
  return (
    <div
      data-slot="image-root"
      data-variant={variant}
      data-size={size}
      className={cn(imageVariants({ variant, size, className }))}
      {...props}
    >
      {children}
    </div>
  );
}

type ImagePreviewProps = Omit<React.ComponentProps<"img">, "children"> & {
  containerClassName?: string;
  onNaturalSize?: (width: number, height: number) => void;
};

function ImagePreview({
  className,
  containerClassName,
  onLoad,
  onError,
  onNaturalSize,
  alt = "Image content",
  src,
  ...props
}: ImagePreviewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | undefined>(undefined);
  const [errorSrc, setErrorSrc] = useState<string | undefined>(undefined);

  const loaded = loadedSrc === src;
  const error = errorSrc === src;

  useEffect(() => {
    const image = imgRef.current;
    if (typeof src !== "string" || !image?.complete) return;
    if (image.naturalWidth > 0) {
      setLoadedSrc(src);
      onNaturalSize?.(image.naturalWidth, image.naturalHeight);
    }
    else setErrorSrc(src);
  }, [src, onNaturalSize]);

  return (
    <div
      data-slot="image-preview"
      className={cn("relative min-h-32", containerClassName)}
    >
      {!loaded && !error && (
        <div
          data-slot="image-preview-loading"
          className="bg-muted/50 absolute inset-0 flex items-center justify-center"
        >
          <ImageIcon className="text-muted-foreground size-8 animate-pulse" />
        </div>
      )}
      {error ? (
        <div
          data-slot="image-preview-error"
          className="bg-muted/50 flex min-h-32 items-center justify-center p-4"
        >
          <ImageOffIcon className="text-muted-foreground size-8" />
        </div>
      ) : (
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className={cn(
            "block h-auto w-full object-contain",
            !loaded && "invisible",
            className,
          )}
          onLoad={(e) => {
            if (typeof src === "string") {
              setLoadedSrc(src);
              onNaturalSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
            }
            onLoad?.(e);
          }}
          onError={(e) => {
            if (typeof src === "string") setErrorSrc(src);
            onError?.(e);
          }}
          {...props}
        />
      )}
    </div>
  );
}

function ImageFilename({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  if (!children) return null;

  return (
    <span
      data-slot="image-filename"
      className={cn(
        "text-muted-foreground block truncate px-2 py-1.5 text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

type ImageZoomProps = PropsWithChildren<{
  src: string;
  alt?: string;
  filename?: string;
}>;

export function ImageLightbox({ src, alt, filename, onClose, children }: {
  src: string;
  alt: string;
  filename?: string;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string>();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusables?.[0];
      const last = focusables?.[focusables.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  return createPortal(
    <div
      ref={overlayRef}
      data-slot="image-zoom-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      className="aui-image-zoom-overlay fade-in animate-in fixed inset-0 z-50 flex flex-col gap-3 bg-black/90 p-4 duration-200 sm:p-6"
      onClick={onClose}
    >
      <div className="flex h-10 w-full shrink-0 items-center justify-end gap-2" onClick={(event) => event.stopPropagation()}>
        {children && <div className="me-auto text-xs tabular-nums text-white/55">{children}</div>}
        <button
          type="button"
          disabled={saving || failedSrc === src}
          data-slot="image-save-as"
          aria-label="Save image as"
          title="Save image as"
          className="inline-flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
          onClick={async () => {
            setSaving(true);
            try { await saveImagePart({ image: src, filename }); }
            catch (error) { reportSaveError(error); }
            finally { setSaving(false); }
          }}
        >
          <DownloadIcon className="size-5" />
        </button>
        <button
          ref={closeRef}
          type="button"
          data-slot="image-close"
          aria-label="Close image preview"
          title="Close"
          onClick={onClose}
          className="inline-flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <XIcon className="size-5" />
        </button>
      </div>
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        {failedSrc === src
          ? <ImageOffIcon className="size-10 text-white/40" aria-label="Image could not be loaded" />
          : <img
              data-slot="image-zoom-content"
              src={src}
              alt={alt}
              className="aui-image-zoom-content max-h-full max-w-full object-contain"
              onClick={(event) => event.stopPropagation()}
              onError={() => setFailedSrc(src)}
            />}
      </div>
    </div>,
    document.body,
  );
}

function ImageZoom({ src, alt = "Image preview", filename, children }: ImageZoomProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const handleClose = useCallback(() => {
    setIsOpen(false);
    triggerRef.current?.focus();
  }, []);

  return <>
    <div
      ref={triggerRef}
      onClick={() => setIsOpen(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); setIsOpen(true); }
        else if (event.key === " ") event.preventDefault();
      }}
      onKeyUp={(event) => { if (event.key === " ") setIsOpen(true); }}
      role="button"
      tabIndex={0}
      className="aui-image-zoom-trigger cursor-pointer"
      aria-label="Open image preview"
    >
      {children}
    </div>
    {isOpen && <ImageLightbox src={src} alt={alt} filename={filename} onClose={handleClose} />}
  </>;
}

function ImageGenerating({ className }: { className?: string }) {
  return (
    <div
      data-slot="image-generating"
      className={cn(
        "bg-muted/50 flex min-h-32 items-center justify-center p-4",
        className,
      )}
    >
      <Loader2Icon className="text-muted-foreground size-8 animate-spin" />
      <span className="sr-only">Generating image…</span>
    </div>
  );
}

function ImageContentFilterError({
  className,
  reason,
}: {
  className?: string;
  reason?: string;
}) {
  return (
    <div
      data-slot="image-content-filter-error"
      className={cn(
        "bg-muted/50 flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center",
        className,
      )}
    >
      <ShieldAlertIcon className="text-muted-foreground size-8" />
      <p className="text-sm font-medium">Image could not be generated</p>
      {reason && <p className="text-muted-foreground text-xs">{reason}</p>}
    </div>
  );
}

const ImageImpl: ImageMessagePartComponent = (props) => {
  const { image, filename, status } = props;

  if (status?.type === "running") {
    return (
      <ImageRoot>
        <ImageGenerating />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    );
  }

  if (status?.type === "incomplete" && status.reason === "content-filter") {
    return (
      <ImageRoot>
        <ImageContentFilterError reason="The provider blocked this image." />
      </ImageRoot>
    );
  }

  if (status?.type === "incomplete") {
    return (
      <ImageRoot>
        <ImageContentFilterError reason={status.reason === "error" ? "Image generation failed." : "Image could not be loaded."} />
        <ImageFilename>{filename}</ImageFilename>
      </ImageRoot>
    );
  }

  return (
    <ImageRoot>
      <ImageZoom src={image} alt={filename || "Image content"} filename={filename}>
        <ImagePreview src={image} alt={filename || "Image content"} />
      </ImageZoom>
      <ImageFilename>{filename}</ImageFilename>
    </ImageRoot>
  );
};

const Image = memo(ImageImpl) as unknown as ImageMessagePartComponent & {
  Root: typeof ImageRoot;
  Preview: typeof ImagePreview;
  Filename: typeof ImageFilename;
  Zoom: typeof ImageZoom;
  Generating: typeof ImageGenerating;
  ContentFilterError: typeof ImageContentFilterError;
};

Image.displayName = "Image";
Image.Root = ImageRoot;
Image.Preview = ImagePreview;
Image.Filename = ImageFilename;
Image.Zoom = ImageZoom;
Image.Generating = ImageGenerating;
Image.ContentFilterError = ImageContentFilterError;

export {
  Image,
  ImageRoot,
  ImagePreview,
  ImageFilename,
  ImageZoom,
  ImageGenerating,
  ImageContentFilterError,
  imageVariants,
};
