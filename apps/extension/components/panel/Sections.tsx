import { useEffect, useState } from 'react';
import { ShieldAlert, Sparkles, Zap } from 'lucide-react';
import type { PageAnalysis, ProviderId, Settings, Task, TaskView } from '@sima/shared-types';
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
        My instructor or course policy allows AI help on this activity, so Sima may enter answers
        for me to check. Sima never submits: that's always up to you.
      </Label>
    </div>
  );
}

export function Controls({ view, task }: { view: TaskView; task: Task }) {
  const run = useTaskStore((s) => s.run);
  const busy = ['analyzing', 'reasoning', 'executing', 'navigating'].includes(task.status);
  const unsolved = view.questions.some(
    (r) => !Object.values(r.responses).some((values) => values.length > 0),
  );

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="controls">
      <Button
        size="sm"
        data-testid="auto-fill"
        disabled={busy || task.fillAuthorizedAt === null}
        title={task.fillAuthorizedAt === null ? 'Tick the box above to allow filling' : undefined}
        onClick={() => void run({ type: 'AUTO_FILL', taskId: task.id })}
      >
        <Zap /> Fill answers
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid="solve-all"
        disabled={busy || !unsolved}
        onClick={() => void run({ type: 'SOLVE', taskId: task.id })}
      >
        <Sparkles /> Explain only
      </Button>
    </div>
  );
}
