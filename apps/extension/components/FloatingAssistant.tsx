import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import type { FloatingState } from '@sima/shared-types';

interface Props {
  initial: FloatingState | undefined;
  subscribe: (setter: (state: FloatingState) => void) => void;
  onOpen: () => void;
  onDismiss: () => void;
}

export function FloatingAssistant({ initial, subscribe, onOpen, onDismiss }: Props) {
  const [state, setState] = useState<FloatingState | undefined>(initial);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => subscribe(setState), [subscribe]);

  if (!state?.visible || dismissed) return null;

  const detail = state.restricted
    ? 'Not available'
    : state.total > 0
      ? `${state.done} of ${state.total}`
      : null;

  return (
    <div
      data-testid="sima-floating"
      className="sima-float group fixed right-4 bottom-4 z-[2147483000] rounded-full border border-border bg-card text-sm text-foreground"
    >
      <button
        type="button"
        data-testid="sima-floating-open"
        aria-label={`Open Sima: ${state.activityTitle}`}
        title={`${state.activityTitle} · ${state.status}`}
        onClick={onOpen}
        className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3.5 hover:bg-muted"
      >
        <Sparkles className="size-4 shrink-0 text-primary" />
        <span className="font-semibold">Sima</span>
        {detail && (
          <span
            data-testid="sima-floating-status"
            className={state.restricted ? 'text-warning' : 'text-muted-foreground'}
          >
            · {detail}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label="Dismiss Sima"
        data-testid="sima-floating-dismiss"
        className="absolute -top-1.5 -right-1.5 grid size-5 cursor-pointer place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
        onClick={() => {
          setDismissed(true);
          onDismiss();
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
