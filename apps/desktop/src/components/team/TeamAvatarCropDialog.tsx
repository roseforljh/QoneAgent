import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Dialog } from "radix-ui";
import { ImagePlus, Minus, Plus, RotateCcw, X } from "lucide-react";
import {
  AVATAR_CROP_VIEW_SIZE,
  AVATAR_MAX_ZOOM,
  AVATAR_MIN_ZOOM,
  clampCropOffset,
  computeBaseScale,
  renderCroppedAvatar,
} from "../../lib/team/avatar";
import { acquireNativeOverlayLock } from "../../lib/dock-browser-session";
import { useLocale } from "../../localization";

interface TeamAvatarCropDialogProps {
  open: boolean;
  /** 本地图片的 Object URL；弹窗关闭或更换文件后由父组件释放。 */
  imageUrl: string | null;
  onOpenChange: (open: boolean) => void;
  onRechoose: () => void;
  onConfirm: (dataUrl: string) => void;
}

/** 圆形头像裁剪弹窗：支持拖拽定位、滚轮与滑块缩放，导出 256px 紧凑图片。 */
export function TeamAvatarCropDialog({
  open,
  imageUrl,
  onOpenChange,
  onRechoose,
  onConfirm,
}: TeamAvatarCropDialogProps) {
  const { t } = useLocale();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(AVATAR_MIN_ZOOM);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loadError, setLoadError] = useState(false);

  useEffect(() => (open ? acquireNativeOverlayLock() : undefined), [open]);

  // 每次更换源图片或开关弹窗时复位缩放与位移。
  useEffect(() => {
    if (!open || !imageUrl) {
      setNatural(null);
      setZoom(AVATAR_MIN_ZOOM);
      setOffset({ x: 0, y: 0 });
      setLoadError(false);
      dragRef.current = null;
      return;
    }
    setNatural(null);
    setZoom(AVATAR_MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    setLoadError(false);
    dragRef.current = null;
  }, [imageUrl, open]);

  const applyZoom = useCallback(
    (nextZoom: number) => {
      const clampedZoom = Math.min(AVATAR_MAX_ZOOM, Math.max(AVATAR_MIN_ZOOM, Number(nextZoom.toFixed(3))));
      setZoom(clampedZoom);
      if (natural) {
        setOffset((prev) => clampCropOffset(prev, natural.width, natural.height, AVATAR_CROP_VIEW_SIZE, clampedZoom));
      }
    },
    [natural],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!natural || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !natural) return;
    const next = clampCropOffset(
      {
        x: drag.originX + (event.clientX - drag.startX),
        y: drag.originY + (event.clientY - drag.startY),
      },
      natural.width,
      natural.height,
      AVATAR_CROP_VIEW_SIZE,
      zoom,
    );
    setOffset(next);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!natural) return;
    event.preventDefault();
    const delta = -event.deltaY * 0.0018;
    applyZoom(zoom + delta);
  };

  const handleReset = () => {
    setZoom(AVATAR_MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
  };

  const handleConfirm = () => {
    const img = imgRef.current;
    if (!img || !natural || loadError) return;
    try {
      const dataUrl = renderCroppedAvatar(img, {
        offsetX: offset.x,
        offsetY: offset.y,
        zoom,
        viewSize: AVATAR_CROP_VIEW_SIZE,
      });
      onConfirm(dataUrl);
      onOpenChange(false);
    } catch {
      setLoadError(true);
    }
  };

  const displayScale = natural ? computeBaseScale(natural.width, natural.height, AVATAR_CROP_VIEW_SIZE) * zoom : 1;
  const displayWidth = natural ? natural.width * displayScale : AVATAR_CROP_VIEW_SIZE;
  const displayHeight = natural ? natural.height * displayScale : AVATAR_CROP_VIEW_SIZE;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nested-dialog-overlay" />
        <Dialog.Content
          className="nested-dialog"
          onEscapeKeyDown={(event) => event.stopPropagation()}
          aria-describedby={undefined}
        >
          <header>
            <div>
              <Dialog.Title asChild>
                <h2>{t("team.dialog.avatarCropTitle")}</h2>
              </Dialog.Title>
              <p>{t("team.dialog.avatarCropHint")}</p>
            </div>
            <Dialog.Close className="nested-dialog-close" aria-label={t("common.close")}>
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="nested-dialog-body items-center">
            <div
              className="team-avatar-crop-stage"
              style={{ width: AVATAR_CROP_VIEW_SIZE, height: AVATAR_CROP_VIEW_SIZE }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onWheel={handleWheel}
            >
              {imageUrl && !loadError && (
                <img
                  ref={imgRef}
                  src={imageUrl}
                  alt=""
                  draggable={false}
                  className="team-avatar-crop-image"
                  onLoad={(event) => {
                    const el = event.currentTarget;
                    setNatural({ width: el.naturalWidth, height: el.naturalHeight });
                    setLoadError(false);
                  }}
                  onError={() => setLoadError(true)}
                  style={{
                    width: displayWidth,
                    height: displayHeight,
                    transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
                    opacity: natural ? 1 : 0,
                  }}
                />
              )}
              {loadError && (
                <div className="flex h-full w-full items-center justify-center px-6 text-center text-xs text-destructive">
                  {t("team.dialog.avatarLoadError")}
                </div>
              )}
              <div className="team-avatar-crop-mask" aria-hidden="true" />
            </div>

            <div className="team-avatar-crop-controls">
              <button
                type="button"
                className="team-avatar-crop-step"
                disabled={!natural || zoom <= AVATAR_MIN_ZOOM}
                onClick={() => applyZoom(zoom - 0.15)}
                aria-label={`${t("team.dialog.avatarCropZoom")} -`}
              >
                <Minus size={14} />
              </button>
              <input
                type="range"
                min={AVATAR_MIN_ZOOM}
                max={AVATAR_MAX_ZOOM}
                step={0.01}
                value={zoom}
                disabled={!natural}
                aria-label={t("team.dialog.avatarCropZoom")}
                onChange={(event) => applyZoom(Number(event.target.value))}
                className="team-avatar-crop-slider"
              />
              <button
                type="button"
                className="team-avatar-crop-step"
                disabled={!natural || zoom >= AVATAR_MAX_ZOOM}
                onClick={() => applyZoom(zoom + 0.15)}
                aria-label={`${t("team.dialog.avatarCropZoom")} +`}
              >
                <Plus size={14} />
              </button>
              <span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="team-avatar-crop-step"
                disabled={!natural || (zoom === AVATAR_MIN_ZOOM && offset.x === 0 && offset.y === 0)}
                onClick={handleReset}
                title={t("team.dialog.avatarCropReset")}
                aria-label={t("team.dialog.avatarCropReset")}
              >
                <RotateCcw size={13} />
              </button>
            </div>
          </div>

          <footer className="is-split">
            <button
              type="button"
              className="team-dialog-btn"
              onClick={onRechoose}
            >
              <ImagePlus size={13} />
              <span>{t("team.dialog.avatarCropRechoose")}</span>
            </button>
            <div className="flex items-center gap-2.5">
              <button type="button" className="team-dialog-btn" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="team-dialog-btn is-primary"
                disabled={!natural || loadError}
                onClick={handleConfirm}
              >
                {t("team.dialog.avatarCropConfirm")}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
