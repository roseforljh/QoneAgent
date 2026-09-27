import { Slider as RadixSlider } from "radix-ui";
import { cn } from "../../lib/utils";

export function Slider({
  value,
  min,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  onValueChange,
  className,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  ariaLabel: string;
  onValueChange: (value: number) => void;
  className?: string;
}) {
  return (
    <RadixSlider.Root
      className={cn("qone-slider", className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={ariaLabel}
      onValueChange={(next) => {
        const nextValue = next[0];
        if (nextValue !== undefined) onValueChange(nextValue);
      }}
    >
      <RadixSlider.Track className="qone-slider-track">
        <RadixSlider.Range className="qone-slider-range" />
      </RadixSlider.Track>
      <RadixSlider.Thumb className="qone-slider-thumb" />
    </RadixSlider.Root>
  );
}
