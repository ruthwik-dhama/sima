import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Pause,
  PenLine,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
} from 'lucide-react';
import type {
  ActionRecord,
  PageAnalysis,
  ProviderId,
  Settings,
  Task,
  TaskView,
} from '@sima/shared-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { sendCommand } from '@/services/messaging';
import { useTaskStore } from '@/stores/task-store';

export function Restricted({ analysis }: { analysis: PageAnalysis }) {
  return (
    <Alert data-testid="restricted-notice">
      <ShieldAlert className="size-4" />
      <AlertTitle>Sima is off for this activity</AlertTitle>
      <AlertDescription>
        <p>
          This looks like an exam, or an activity that doesn't allow outside help. Sima didn't read
          its questions and sent nothing to an AI provider.
        </p>
        <ul className="mt-1 list-disc pl-4">
          {analysis.restriction.signals.map((signal) => (
            <li key={`${signal.code}:${signal.evidence}`}>Found: "{signal.evidence}"</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

export function Disclosure({
  providers,
}: {
  providers: Record<ProviderId, { name: string; origin: string; external: boolean }>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const load = () =>
    sendCommand<{ settings: Settings }>({ type: 'GET_SETTINGS' }).then((r) =>
      setSettings(r.settings),
    );
  // Reload after an error too, since the fix is often a change on the Settings page.
  const panelError = useTaskStore((s) => s.error);
  useEffect(() => void load(), [panelError]);
  if (!settings) return null;
  const id = settings.activeProvider;
  const provider = providers[id];
  if (!provider.external) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="provider-note">
        Using {provider.name}. Question text stays on this computer.
      </p>
    );
  }
  if (settings.acknowledgedProviders.includes(id)) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="provider-note">
        Question text is sent to {provider.name} when you ask Sima to work through it.
      </p>
    );
  }
  return (
    <Alert data-testid="provider-disclosure">
      <AlertTitle>Question text will go to {provider.name}</AlertTitle>
      <AlertDescription>
        <p>
          When you ask Sima to work through a question, its text, tables and image descriptions are
          sent to {provider.origin} using your API key. Their data policy applies.
        </p>
        <Button
          size="sm"
          className="mt-2"
          onClick={() =>
            void sendCommand({ type: 'ACKNOWLEDGE_PROVIDER', provider: id }).then(load)
          }
        >
          I understand
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function Authorization({ task }: { task: Task }) {
  const run = useTaskStore((s) => s.run);
  return (
    <div className="flex items-start gap-2 rounded-md border p-2">
      <Checkbox
        id="fill-auth"
        data-testid="authorize-fill"
        checked={task.fillAuthorizedAt !== null}
        onCheckedChange={(checked) =>
          void run({ type: 'AUTHORIZE_FILL', taskId: task.id, authorized: checked === true })
        }
      />
      <Label htmlFor="fill-auth" className="block text-xs leading-snug font-normal">
        My instructor or course policy allows AI help on this activity, so Sima may enter answers I
        approve. Sima never submits: that's always up to you.
      </Label>
    </div>
  );
}

export function Controls({ view, task }: { view: TaskView; task: Task }) {
  const run = useTaskStore((s) => s.run);
  const id = task.id;
  const busy = ['analyzing', 'reasoning', 'executing', 'navigating'].includes(task.status);
  const paused = task.status === 'paused';
  const stopped = task.status === 'stopped' || task.status === 'completed';
  const unsolved = view.questions.some((r) => !r.solution);
  const actionable = view.plan.actions.length;
  const hasNext = view.analysis?.next != null;

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="controls">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || task.tabId === null}
        onClick={() => task.tabId !== null && void run({ type: 'ANALYZE', tabId: task.tabId })}
      >
        <RefreshCw /> Re-read page
      </Button>
      {!stopped && !paused && (
        <>
          <Button
            size="sm"
            data-testid="solve-all"
            disabled={busy || !unsolved}
            onClick={() => void run({ type: 'SOLVE', taskId: id })}
          >
            <Sparkles /> Work through
          </Button>
          <Button
            size="sm"
            data-testid="execute"
            disabled={busy || actionable === 0 || task.fillAuthorizedAt === null}
            onClick={() => void run({ type: 'EXECUTE', taskId: id })}
          >
            <PenLine /> Enter {actionable > 0 ? `${actionable} ` : ''}approved
          </Button>
          {hasNext && (
            <Button
              size="sm"
              variant="outline"
              data-testid="navigate-next"
              disabled={busy}
              onClick={() => void run({ type: 'NAVIGATE_NEXT', taskId: id })}
            >
              <ArrowRight /> {view.analysis?.next?.label ?? 'Next page'}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            data-testid="pause"
            onClick={() => void run({ type: 'PAUSE', taskId: id })}
          >
            <Pause /> Pause
          </Button>
        </>
      )}
      {paused && (
        <Button
          size="sm"
          data-testid="resume"
          onClick={() => void run({ type: 'RESUME', taskId: id })}
        >
          <Play /> Resume
        </Button>
      )}
      {!stopped && (
        <Button
          size="sm"
          variant="outline"
          data-testid="stop"
          onClick={() => void run({ type: 'STOP', taskId: id })}
        >
          <Square /> Stop
        </Button>
      )}
      {stopped && task.tabId !== null && (
        <Button
          size="sm"
          data-testid="restart"
          onClick={() => void run({ type: 'RESTART', taskId: id })}
        >
          <Play /> Restart
        </Button>
      )}
    </div>
  );
}

const ACTION_LABEL: Record<ActionRecord['action']['type'], string> = {
  fill_text: 'Filled',
  select_option: 'Selected',
  select_radio: 'Chose',
  set_checkbox: 'Toggled',
  navigate_next: 'Moved to next page',
};

export function ExecutionLog({ actions }: { actions: ActionRecord[] }) {
  if (actions.length === 0) return null;
  return (
    <details className="rounded-md border p-2 text-xs" data-testid="execution-log">
      <summary className="cursor-pointer font-medium">Activity log ({actions.length})</summary>
      <ul className="mt-1 flex flex-col gap-1">
        {actions.map((record) => (
          <li key={record.id} data-status={record.status}>
            <span className={record.status === 'failed' ? 'text-destructive' : 'text-success'}>
              {record.status === 'failed'
                ? 'Failed'
                : record.status === 'verified'
                  ? 'Verified'
                  : 'Started'}
            </span>{' '}
            {ACTION_LABEL[record.action.type]} {record.action.fieldKey}
            {record.result?.detail ? `: ${record.result.detail}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
