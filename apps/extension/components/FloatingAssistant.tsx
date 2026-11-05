import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
// Bundled as data, so no web-accessible file exists for a page to fingerprint Sima with.
import logo from '@/assets/logo.png?inline';
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
    : state.note
      ? state.note
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
        className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full pr-3.5 pl-2 hover:bg-muted"
      >
        <img
          src={logo}
          alt=""
          className="size-5 shrink-0 rounded-[5px]"
          data-testid="sima-floating-logo"
        />
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
