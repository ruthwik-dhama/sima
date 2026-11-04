import { useEffect, useState } from 'react';
import { ChevronDown, PanelRight, Sparkles, X } from 'lucide-react';
import type { FloatingState } from '@sima/shared-types';

interface Props {
  initial: FloatingState | undefined;
  subscribe: (setter: (state: FloatingState) => void) => void;
  onOpen: () => void;
  onDismiss: () => void;
}

export function FloatingAssistant({ initial, subscribe, onOpen, onDismiss }: Props) {
  const [state, setState] = useState<FloatingState | undefined>(initial);
  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribe(setState), [subscribe]);

  if (!state?.visible || dismissed) return null;

  const iconButton =
    'grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted';

  if (minimized) {
    return (
      <button
        type="button"
        aria-label="Expand Sima"
        data-testid="sima-floating-expand"
        onClick={() => setMinimized(false)}
        className="sima-float fixed right-4 bottom-4 z-[2147483000] grid size-9 place-items-center rounded-full bg-background text-primary"
      >
        <Sparkles className="size-4" />
      </button>
    );
  }

  return (
    <div
      data-testid="sima-floating"
      className="sima-float fixed right-4 bottom-4 z-[2147483000] flex w-64 flex-col gap-2 rounded-lg border border-border bg-background p-3 text-sm text-foreground"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 shrink-0 text-primary" />
        <span className="font-medium">Sima</span>
        <span className="ml-auto flex items-center">
          <button
            type="button"
            aria-label="Minimize Sima"
            data-testid="sima-floating-minimize"
            className={iconButton}
            onClick={() => setMinimized(true)}
          >
            <ChevronDown className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Dismiss Sima"
            data-testid="sima-floating-dismiss"
            className={iconButton}
            onClick={() => {
              setDismissed(true);
              onDismiss();
            }}
          >
            <X className="size-4" />
          </button>
        </span>
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{state.activityTitle}</p>
        <p
          data-testid="sima-floating-status"
          className={state.restricted ? 'font-medium text-warning' : 'font-medium'}
        >
          {state.status}
          {!state.restricted && state.total > 0
            ? ` · ${state.done} of ${state.total} answered`
            : ''}
        </p>
      </div>
      <button
        type="button"
        data-testid="sima-floating-open"
        onClick={onOpen}
        className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary font-medium text-primary-foreground hover:opacity-90"
      >
        <PanelRight className="size-4" />
        Open Sima
      </button>
    </div>
  );
}
