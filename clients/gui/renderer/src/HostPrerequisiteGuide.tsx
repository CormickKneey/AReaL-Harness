import { useState } from "react";
import { Button } from "./components/ui/button.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import type { HostPrerequisite, PlatformServices } from "./services.js";

export function HostPrerequisiteGuide({
  prerequisite,
  services,
  pending,
  onRetry,
}: {
  prerequisite: HostPrerequisite;
  services: PlatformServices;
  pending: boolean;
  onRetry: () => void;
}) {
  const [requesting, setRequesting] = useState(false);
  const [message, setMessage] = useState("");
  const install = async () => {
    if (!services.installCommandLineTools) return;
    setRequesting(true);
    try {
      const result = await services.installCommandLineTools();
      setMessage(
        result.started ? prerequisite.requestedMessage : (result.message ?? prerequisite.detail),
      );
    } catch {
      setMessage(prerequisite.detail);
    } finally {
      setRequesting(false);
    }
  };
  return (
    <div data-testid="host-prerequisite-guide">
      <FeedbackNotice
        transient={false}
        tone="error"
        message={prerequisite.title}
        actions={
          <>
            {services.installCommandLineTools && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending || requesting}
                onClick={() => void install()}
              >
                {prerequisite.installLabel}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending || requesting}
              onClick={onRetry}
            >
              {prerequisite.retryLabel}
            </Button>
          </>
        }
      />
      <p className="text-ui-caption text-foreground-subtle" role="status">
        {message || prerequisite.detail}
      </p>
    </div>
  );
}
