import { Fragment, useEffect, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { acquireNativeOverlayLock } from "../../lib/dock-browser-session";

export interface WizardStepItem {
  id: string;
  label: string;
}

interface TeamWizardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  steps: readonly WizardStepItem[];
  currentStep: number;
  onStepChange: (index: number) => void;
  /** 允许用户通过顶部步骤条跳转到的最大步骤索引。 */
  maxReachableStep?: number;
  /** nested 用于从建群向导内二次打开新建机器人向导时的层级叠加。 */
  nested?: boolean;
  children: ReactNode;
  footer: ReactNode;
}

/** 通用多步骤桌面端向导壳：宽敞布局、顶部可点击步骤条、平滑步骤切换与防穿透锁。 */
export function TeamWizardDialog({
  open,
  onOpenChange,
  title,
  steps,
  currentStep,
  onStepChange,
  maxReachableStep = steps.length - 1,
  nested = false,
  children,
  footer,
}: TeamWizardDialogProps) {
  const { t } = useLocale();
  useEffect(() => (open ? acquireNativeOverlayLock() : undefined), [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={cn("team-wizard-overlay", nested && "is-nested")} />
        <Dialog.Content
          className={cn("team-wizard-dialog", nested && "is-nested")}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          aria-describedby={undefined}
        >
          <header className="team-wizard-header">
            <div className="flex items-start justify-between gap-3">
              <Dialog.Title className="text-[16px] font-semibold tracking-tight text-foreground">
                {title}
              </Dialog.Title>
              <Dialog.Close className="nested-dialog-close" aria-label={t("common.close")}>
                <X size={16} />
              </Dialog.Close>
            </div>

            <nav className="team-wizard-stepper" aria-label={t("team.dialog.stepCounter", { current: currentStep + 1, total: steps.length })}>
              {steps.map((step, index) => {
                const isActive = index === currentStep;
                const isDone = index < currentStep;
                const disabled = index > maxReachableStep;
                return (
                  <Fragment key={step.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onStepChange(index)}
                      aria-current={isActive ? "step" : undefined}
                      className={cn(
                        "team-wizard-step",
                        isActive && "is-active",
                        isDone && "is-done",
                        disabled && "cursor-not-allowed opacity-45",
                      )}
                    >
                      <span className="team-wizard-step-badge">
                        {isDone ? <Check size={12} /> : index + 1}
                      </span>
                      <span>{step.label}</span>
                    </button>
                    {index < steps.length - 1 && (
                      <span className="team-wizard-step-line" aria-hidden="true" />
                    )}
                  </Fragment>
                );
              })}
            </nav>
          </header>

          <div className="team-wizard-body">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={steps[currentStep]?.id ?? currentStep}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="flex min-h-0 flex-1 flex-col"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="team-wizard-footer">{footer}</footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
