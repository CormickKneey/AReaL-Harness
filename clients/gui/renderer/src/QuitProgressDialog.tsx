import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog.js";
import { Spinner } from "./components/ui/spinner.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { QuitProgress } from "./services.js";

export function QuitProgressDialog({ progress }: { progress: QuitProgress }) {
  const { t } = useI18n();
  return <Dialog open={progress.state === "quitting"} disablePointerDismissal onOpenChange={(_open, event) => event.cancel()}>
    <DialogContent showCloseButton={false} className="max-w-sm" data-quit-progress={progress.state === "quitting" ? progress.phase : undefined}>
      <div className="flex items-center gap-3">
        <Spinner className="size-5 shrink-0" />
        <div className="grid gap-1" aria-live="polite">
          <DialogTitle>{t("operations.quitting")}</DialogTitle>
          <DialogDescription>{progress.state === "quitting" ? t(`operations.quit.${progress.phase}`) : null}</DialogDescription>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
