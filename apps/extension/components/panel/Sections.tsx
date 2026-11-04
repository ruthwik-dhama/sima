import { useEffect, useState } from 'react';
import { LoaderCircle, ShieldAlert, Sparkles, Zap } from 'lucide-react';
import type { PageAnalysis, ProviderId, Settings, Task, TaskView } from '@sima/shared-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
  const setSettingsOpen = useTaskStore((s) => s.setSettingsOpen);
  useEffect(() => void load(), [panelError]);
  // Settings open in another tab, so pick up changes made there without a reload.
  useEffect(() => {
    const onChanged = () => void load();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  if (!settings) return null;
  const id = settings.activeProvider;
  const provider = providers[id];
  if (!settings.models[id]) {
    return (
      <Alert data-testid="model-missing">
        <AlertTitle>Choose an AI model to get started</AlertTitle>
        <AlertDescription>
          <p>Sima needs a model for {provider.name} before it can work through questions.</p>
          <Button
            size="sm"
            className="mt-2"
            data-testid="open-settings"
            onClick={() => setSettingsOpen(true)}
          >
            Open settings
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!provider.external || settings.acknowledgedProviders.includes(id)) return null;
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

export function Controls({ view, task }: { view: TaskView; task: Task }) {
  const run = useTaskStore((s) => s.run);
  const [asking, setAsking] = useState(false);
  const [running, setRunning] = useState<'fill' | 'explain' | null>(null);
  const busy = ['analyzing', 'reasoning', 'executing', 'navigating'].includes(task.status);
  const unsolved = view.questions.some(
    (r) => !Object.values(r.responses).some((values) => values.length > 0),
  );

  const start = async (kind: 'fill' | 'explain') => {
    setRunning(kind);
    await run(
      kind === 'fill' ? { type: 'AUTO_FILL', taskId: task.id } : { type: 'SOLVE', taskId: task.id },
    );
    setRunning(null);
  };

  const filling =
    task.status === 'executing' || (task.status === 'reasoning' && running !== 'explain');
  const explaining = task.status === 'reasoning' && running === 'explain';
  const iconClass = 'animate-spin';

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2" data-testid="controls">
        <Button
          className="h-10 rounded-xl"
          data-testid="auto-fill"
          disabled={busy}
          onClick={() => {
            if (task.fillAuthorizedAt === null) setAsking(true);
            else void start('fill');
          }}
        >
          {filling ? <LoaderCircle className={iconClass} /> : <Zap />}
          {filling ? 'Filling…' : 'Fill answers'}
        </Button>
        <Button
          className="h-10 rounded-xl bg-card"
          variant="outline"
          data-testid="solve-all"
          disabled={busy || !unsolved}
          onClick={() => void start('explain')}
        >
          {explaining ? <LoaderCircle className={iconClass} /> : <Sparkles />}
          {explaining ? 'Explaining…' : 'Explain only'}
        </Button>
      </div>
      {asking && (
        <div
          role="alertdialog"
          aria-labelledby="fill-permission-title"
          className="sima-card flex flex-col gap-3 rounded-xl bg-card p-4"
          data-testid="fill-permission"
        >
          <div>
            <p className="font-medium" id="fill-permission-title">
              Does your course allow AI help on this activity?
            </p>
            <p className="text-xs text-muted-foreground">Sima never submits for you.</p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="permission-cancel"
              onClick={() => setAsking(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="permission-yes"
              onClick={() => {
                setAsking(false);
                void run({ type: 'AUTHORIZE_FILL', taskId: task.id, authorized: true }).then(() =>
                  start('fill'),
                );
              }}
            >
              Yes, fill
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
