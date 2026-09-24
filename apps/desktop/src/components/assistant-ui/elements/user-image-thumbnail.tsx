"use client";

import { useCallback, useState, type ComponentProps, type FC } from "react";
import { Image } from "./image";

const MAX_SIDE = 192;

function thumbnailSize(width: number, height: number) {
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, MAX_SIDE / width, MAX_SIDE / height);
  return Math.max(1, Math.round(width * scale));
}

export const UserImageThumbnail: FC<ComponentProps<typeof Image>> = (part) => {
  const { image, filename, status } = part;
  const [measured, setMeasured] = useState<{ image: string; width: number } | null>(null);
  const onNaturalSize = useCallback((width: number, height: number) => {
    const fittedWidth = thumbnailSize(width, height);
    if (fittedWidth !== null) setMeasured((current) =>
      current?.image === image && current.width === fittedWidth ? current : { image, width: fittedWidth },
    );
  }, [image]);

  if (status?.type === "running" || status?.type === "incomplete") return <Image {...part} />;

  return (
    <Image.Root
      className="q-user-image-thumbnail shrink-0"
      title={filename}
      style={{ width: measured?.image === image ? measured.width : 128 }}
    >
      <Image.Zoom src={image} alt={filename || "Image attachment"}>
        <Image.Preview src={image} alt={filename || "Image attachment"} onNaturalSize={onNaturalSize} />
      </Image.Zoom>
      <Image.Filename>{filename}</Image.Filename>
    </Image.Root>
  );
};
