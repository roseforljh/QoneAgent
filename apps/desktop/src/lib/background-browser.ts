/** Native child browser settings for background work. Keep this in one place so
 * page bridges and OpenCLI do not drift into different hidden-window behavior. */
export const BACKGROUND_BROWSER_BOUNDS = { x: -32000, y: -32000, w: 1280, h: 720 } as const;
export const BROWSER_POLL_INTERVAL_MS = 500;
export const DOUYIN_VIDEO_TIMEOUT_MS = 30_000;
export const DOUYIN_AUTHOR_TIMEOUT_MS = 90_000;
export const DOUYIN_STALL_TIMEOUT_MS = 15_000;
