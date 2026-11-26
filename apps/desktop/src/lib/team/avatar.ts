import { DEFAULT_TEAM_BOT_PRESETS } from "./presets";
import type { TeamBot } from "./types";

export interface TeamAvatarDesign {
  color: string;
  outline: string;
  gaze: string;
  border?: string;
  faceplate?: { color: string; outline: string };
  face?: string;
  detail?: string;
}

// 保留最初的顺序，用于未显式选择头像的旧成员。
const classicAvatars = {
  orbit: { color: "#396DF2", outline: "M32 4C46 3 57 14 59 28C61 44 50 57 34 59C18 61 5 50 4 35C2 20 16 5 32 4Z", gaze: "translate(33 22) rotate(-26)" },
  ember: { color: "#DD5523", outline: "M7 27C9 13 19 5 32 6C46 6 55 16 58 33C61 48 52 57 36 58C18 60 4 51 5 39Z", gaze: "translate(19 26) rotate(15)" },
  jade: { color: "#008E7C", outline: "M24 5H40C54 5 59 12 59 26V39C59 53 50 59 38 59H25C12 59 5 52 5 38V24C5 10 12 5 24 5Z", gaze: "translate(31 24) rotate(-12)" },
  ruby: { color: "#DB4265", outline: "M24 12C34 9 46 10 53 16C62 23 63 37 56 46C50 54 39 55 27 54C12 54 4 47 3 34C2 23 11 15 24 12Z", gaze: "translate(34 27) rotate(-26)" },
  petal: { color: "#C6378E", outline: "M25 10C29 3 37 4 41 11L57 39C63 50 57 57 46 57H18C7 57 2 50 7 40Z", gaze: "translate(30 32) rotate(-18)" },
  prism: { color: "#7751DF", outline: "M28 5Q32 3 36 5L54 15Q60 18 60 24V40Q60 47 54 50L36 60Q32 62 27 59L10 49Q4 46 4 39V24Q4 18 10 15Z", gaze: "translate(19 29) rotate(16)" },
  cloud: { color: "#A96705", outline: "M21 18C24 6 45 5 47 20C58 19 63 29 59 38C61 48 53 54 44 53C37 60 24 60 19 53C8 55 2 48 4 39C0 28 9 18 21 18Z", gaze: "translate(28 28) rotate(-17)" },
  ink: { color: "#49536B", outline: "M27 7Q32 1 38 9C47 19 57 28 56 40C55 53 46 59 32 59C16 59 8 50 8 38C8 28 19 18 27 7Z", gaze: "translate(30 33) rotate(-25)" },
} as const satisfies Record<string, TeamAvatarDesign>;

export const TEAM_AVATARS = {
  ...classicAvatars,
  mochi: {
    color: "#FFFFFF",
    border: "#202020",
    outline: "M7 33C7 18 16 11 32 11C48 11 57 18 57 34C57 49 46 55 32 55C17 55 7 48 7 33Z",
    face: "#202020",
    gaze: "translate(23 25) rotate(-7)",
    detail: "M29 40Q32 43 35 40Q36 39 37 41Q36 45 32 45Q28 45 27 41Q28 39 29 40Z",
  },
  panda: {
    color: "#FFFFFF",
    border: "#202020",
    outline: "M8 24C2 20 4 10 10 7C16 4 22 7 24 13Q32 11 40 13C42 7 48 4 54 7C60 10 62 20 56 24Q61 32 59 41C57 53 46 58 32 58C18 58 7 53 5 41Q3 32 8 24Z",
    faceplate: { color: "#202020", outline: "M8 24C2 20 4 10 10 7C16 4 22 7 24 13Q14 15 8 24ZM40 13C42 7 48 4 54 7C60 10 62 20 56 24Q50 15 40 13Z" },
    face: "#202020",
    gaze: "translate(22 25)",
    detail: "M29 42Q32 39 35 42Q35 45 32 46Q29 45 29 42Z",
  },
  penguin: {
    color: "#171717",
    border: "#717171",
    outline: "M32 5C46 5 55 18 56 34C58 50 48 59 32 59C16 59 6 50 8 34C9 18 18 5 32 5Z",
    faceplate: { color: "#FFFFFF", outline: "M32 25C22 15 12 27 13 39C14 50 21 55 32 55C43 55 50 50 51 39C52 27 42 15 32 25Z" },
    face: "#171717",
    gaze: "translate(23 30)",
    detail: "M29 44Q32 42 35 44Q35 45 32 48Q29 45 29 44Z",
  },
  helmet: {
    color: "#FFFFFF",
    border: "#202020",
    outline: "M15 14Q16 6 23 6Q28 6 29 12H40C51 12 57 20 57 31V41C57 51 50 58 39 58H24C13 58 7 51 7 40V30Q7 19 15 14Z",
    faceplate: { color: "#202020", outline: "M24 21H41C48 21 52 26 52 34C52 42 47 46 40 46H24C17 46 12 41 12 34C12 26 17 21 24 21Z" },
    gaze: "translate(26 26) rotate(-10)",
  },
  peach: {
    color: "#FFAD96",
    outline: "M5 35Q5 15 22 15H24V11Q24 4 32 4Q39 4 39 11V15H42Q59 15 59 35V40Q59 56 43 56H21Q5 56 5 40Z",
    face: "#552A38",
    gaze: "translate(21 26) rotate(8)",
    detail: "M27 42Q31 45 35 42Q35 47 31 47Q27 47 27 42Z",
  },
  lilac: {
    color: "#C8AEFF",
    outline: "M16 19C10 12 13 5 19 4C25 3 28 9 29 15Q32 14 36 15C37 8 41 3 47 5C54 7 52 16 48 21Q58 28 58 40C58 52 48 58 32 58C16 58 6 52 6 40Q6 27 16 19Z",
    face: "#39285C",
    gaze: "translate(25 29) rotate(-10)",
    detail: "M29 44Q32 47 35 44Q36 48 32 49Q28 48 29 44Z",
  },
  mint: {
    color: "#80DEBA",
    outline: "M16 17C15 9 26 5 32 12C38 5 49 9 48 17C58 17 62 27 56 33C63 40 57 51 49 50C47 59 36 61 32 54C27 61 16 59 15 50C7 51 1 40 8 33C2 27 6 17 16 17Z",
    face: "#16483C",
    gaze: "translate(22 24) rotate(12)",
    detail: "M26 41Q30 44 34 41Q34 46 30 46Q26 46 26 41Z",
  },
  butter: {
    color: "#F8D46C",
    outline: "M9 32C11 22 17 16 28 15V11C22 8 25 2 30 2C35 2 38 8 34 11V15C46 15 54 20 56 32Q60 34 60 39V42Q60 47 54 48C50 55 43 58 32 58C21 58 14 55 10 48Q4 47 4 42V39Q4 34 9 32Z",
    face: "#513918",
    gaze: "translate(24 27) rotate(-5)",
    detail: "M29 43Q32 46 35 43Q35 48 32 48Q29 48 29 43Z",
  },
} as const satisfies Record<string, TeamAvatarDesign>;

export type TeamAvatarId = keyof typeof TEAM_AVATARS;
const LEGACY_AVATAR_IDS = Object.keys(classicAvatars) as (keyof typeof classicAvatars)[];
export const TEAM_AVATAR_IDS = Object.keys(TEAM_AVATARS) as TeamAvatarId[];

export const AVATAR_CROP_VIEW_SIZE = 260;
export const AVATAR_OUTPUT_SIZE = 256;
export const AVATAR_MIN_ZOOM = 1;
export const AVATAR_MAX_ZOOM = 3;
const MAX_AVATAR_DATA_URL_LENGTH = 150_000;
const CUSTOM_AVATAR_PATTERN = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** 判断是否为协议允许的自定义图片 Data URL。 */
export function isCustomAvatar(value?: string): value is string {
  return Boolean(value && value.length <= 160_000 && CUSTOM_AVATAR_PATTERN.test(value));
}

export function customAvatarOf(bot: Pick<TeamBot, "avatar">): string | undefined {
  return isCustomAvatar(bot.avatar) ? bot.avatar : undefined;
}

/** 计算图片完全覆盖正方形裁剪视口所需的基础缩放比例。 */
export function computeBaseScale(naturalWidth: number, naturalHeight: number, viewSize: number): number {
  const shortest = Math.min(naturalWidth, naturalHeight);
  return shortest > 0 ? viewSize / shortest : 1;
}

/** 将拖拽偏移限制在图像覆盖范围内，避免裁剪圆框露出空白边缘。 */
export function clampCropOffset(
  offset: { x: number; y: number },
  naturalWidth: number,
  naturalHeight: number,
  viewSize: number,
  zoom: number,
): { x: number; y: number } {
  const safeZoom = Math.min(AVATAR_MAX_ZOOM, Math.max(AVATAR_MIN_ZOOM, zoom));
  const scale = computeBaseScale(naturalWidth, naturalHeight, viewSize) * safeZoom;
  const maxX = Math.max(0, (naturalWidth * scale - viewSize) / 2);
  const maxY = Math.max(0, (naturalHeight * scale - viewSize) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

/** 按当前视口偏移与缩放将原图裁剪导出为定尺寸头像 Data URL，自动控制体积在协议上限内。 */
export function renderCroppedAvatar(
  image: HTMLImageElement,
  crop: { offsetX: number; offsetY: number; zoom: number; viewSize: number },
): string {
  const { naturalWidth, naturalHeight } = image;
  const { viewSize, zoom } = crop;
  const clamped = clampCropOffset({ x: crop.offsetX, y: crop.offsetY }, naturalWidth, naturalHeight, viewSize, zoom);
  const viewScale = computeBaseScale(naturalWidth, naturalHeight, viewSize) * zoom;

  const drawAtSize = (outputSize: number, mime: "image/webp" | "image/jpeg" | "image/png", quality?: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const ratio = outputSize / viewSize;
    const drawW = naturalWidth * viewScale * ratio;
    const drawH = naturalHeight * viewScale * ratio;
    const dx = (outputSize - drawW) / 2 + clamped.x * ratio;
    const dy = (outputSize - drawH) / 2 + clamped.y * ratio;
    ctx.drawImage(image, dx, dy, drawW, drawH);
    return canvas.toDataURL(mime, quality);
  };

  // 优先 WebP（体积小且保留透明通道），若运行环境不支持或超体积上限则依次降档。
  const candidates: Array<[number, "image/webp" | "image/jpeg" | "image/png", number | undefined]> = [
    [AVATAR_OUTPUT_SIZE, "image/webp", 0.88],
    [AVATAR_OUTPUT_SIZE, "image/webp", 0.72],
    [AVATAR_OUTPUT_SIZE, "image/jpeg", 0.86],
    [192, "image/jpeg", 0.8],
    [AVATAR_OUTPUT_SIZE, "image/png", undefined],
  ];
  for (const [size, mime, quality] of candidates) {
    const url = drawAtSize(size, mime, quality);
    if (url.startsWith(`data:${mime};base64,`) && url.length <= MAX_AVATAR_DATA_URL_LENGTH) {
      return url;
    }
  }
  return drawAtSize(160, "image/jpeg", 0.75);
}

/** 已选头像优先；旧数据按预设角色或原种子映射，无需改写已保存的成员。 */
export function avatarIdOf(bot: Pick<TeamBot, "id" | "avatar" | "presetKey">): TeamAvatarId {
  const seed = bot.avatar || bot.id;
  const saved = TEAM_AVATAR_IDS.find((id) => id === seed);
  if (saved) return saved;
  const preset = DEFAULT_TEAM_BOT_PRESETS.find((item) => item.presetKey === bot.presetKey);
  if (preset) return preset.avatar;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (Math.imul(31, hash) + seed.charCodeAt(i)) >>> 0;
  return LEGACY_AVATAR_IDS[hash % LEGACY_AVATAR_IDS.length];
}
