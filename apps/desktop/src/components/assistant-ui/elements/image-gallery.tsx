"use client";

import { ImageOffIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "../../../lib/utils";
import { ImageLightbox } from "./image";

export interface GalleryImage {
  id: string;
  src: string;
  alt: string;
  filename?: string;
  caption?: string;
}

export interface ImageGalleryProps extends Omit<ComponentProps<"div">, "children"> {
  images: readonly GalleryImage[];
  maxVisible?: number;
  onOpen?: (id: string) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The assistant-ui image gallery pattern with the same preview as single images. */
export function ImageGallery({ images, maxVisible = 6, onOpen, className, ...props }: ImageGalleryProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const visibleCount = Math.max(1, Math.min(Math.floor(maxVisible), images.length));
  const activeIndexSafe = activeIndex === null ? 0 : clamp(activeIndex, 0, Math.max(0, images.length - 1));
  const active = activeIndex === null ? undefined : images[activeIndexSafe];

  const close = useCallback(() => {
    setActiveIndex(null);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && activeIndexSafe > 0) {
        event.preventDefault();
        setActiveIndex(activeIndexSafe - 1);
      } else if (event.key === "ArrowRight" && activeIndexSafe < images.length - 1) {
        event.preventDefault();
        setActiveIndex(activeIndexSafe + 1);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, activeIndexSafe, images.length]);

  if (images.length === 0) return null;

  const open = (index: number, trigger: HTMLButtonElement) => {
    const image = images[index];
    if (!image) return;
    triggerRef.current = trigger;
    setActiveIndex(index);
    onOpen?.(image.id);
  };

  return (
    <div data-slot="image-gallery" className={cn("w-full max-w-md", className)} {...props}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {images.slice(0, visibleCount).map((image, index) => {
          const isOverflow = index === visibleCount - 1 && images.length > visibleCount;
          return (
            <button
              key={image.id}
              type="button"
              aria-label={`Open image: ${image.alt}`}
              onClick={(event) => open(index, event.currentTarget)}
              className="relative aspect-square overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.03] outline-none transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {failed.has(image.id) ? (
                <span className="flex size-full items-center justify-center text-foreground/35"><ImageOffIcon aria-hidden className="size-6" /></span>
              ) : (
                <img src={image.src} alt={image.alt} loading="lazy" className="size-full object-cover" onError={() => setFailed((current) => new Set(current).add(image.id))} />
              )}
              {isOverflow && <span className="absolute inset-0 flex items-center justify-center bg-foreground/65 text-lg font-medium text-background">+{images.length - visibleCount}</span>}
            </button>
          );
        })}
      </div>
      {active && <ImageLightbox key={active.id} src={active.src} alt={active.alt} filename={active.filename} onClose={close}>
        <span>{activeIndexSafe + 1} / {images.length}</span>
      </ImageLightbox>}
    </div>
  );
}
