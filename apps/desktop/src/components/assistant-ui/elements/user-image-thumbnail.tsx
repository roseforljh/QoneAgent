"use client";

import type { ComponentProps, FC } from "react";
import { Image } from "./image";
import { useLocale } from "../../../localization";

/**
 * Keep the message geometry stable while the image is loading. The top-anchor
 * measures the user message before the browser has decoded the image, so a
 * content-sized thumbnail would initially contribute zero height.
 */
export const UserImageThumbnail: FC<ComponentProps<typeof Image>> = (part) => {
  const { t } = useLocale();
  const { filename, status } = part;

  if (status?.type === "running" || status?.type === "incomplete") return <Image {...part} />;

  return (
    <Image.Root
      className="q-user-image-thumbnail q-message-attachment-card shrink-0"
      title={filename}
      style={{
        width: "var(--q-message-attachment-image-size)",
        height: "var(--q-message-attachment-image-size)",
      }}
    >
      <Image.Zoom src={part.image} alt={filename || t("attachment.imageAlt")} filename={filename}>
        <Image.Preview src={part.image} alt={filename || t("attachment.imageAlt")} />
      </Image.Zoom>
    </Image.Root>
  );
};
