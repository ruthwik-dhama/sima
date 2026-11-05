import { useEffect, useState } from 'react';
import { FileDown, LoaderCircle, ShieldAlert, Sparkles, Zap } from 'lucide-react';
import type {
  CaptureResult,
  PageAnalysis,
  ProviderId,
  Settings,
  Task,
  TaskView,
} from '@sima/shared-types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AgeGate } from '@/components/AgeGate';
import { Button } from '@/components/ui/button';
import { sendCommand } from '@/services/messaging';
import { openSettings } from '@/services/open-settings';
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
  // Settings open in their own tab, so pick up changes made there.
  useEffect(() => {
    const onChanged = () => void load();
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  if (!settings) return null;
  if (settings.ageCheck === 'unset') return <AgeGate onDone={() => void load()} />;
  const id = settings.activeProvider;
  const provider = providers[id];
  if (!settings.models[id]) {
    return (
      <Alert data-testid="model-missing">
        <AlertTitle>
          {id === 'gemini' ? 'Turn on free AI' : 'Choose an AI model to get started'}
        </AlertTitle>
        <AlertDescription>
          <p>
            {id === 'gemini'
              ? 'It takes about a minute, and no payment is needed.'
              : `Sima needs a model for ${provider.name} before it can work through questions.`}
          </p>
          <Button size="sm" className="mt-2" data-testid="open-settings" onClick={openSettings}>
            {id === 'gemini' ? 'Set up Gemini' : 'Open settings'}
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
        {id === 'gemini' && (
          <p className="mt-1" data-testid="gemini-terms">
            On Gemini's free tier, Google may use what's sent to improve its products, and human
            reviewers may read it, so don't send personal information. It's only for people 18 or
            older, and isn't available in the EEA, Switzerland or the UK.
          </p>
        )}
        <Button
          size="sm"
          className="mt-2"
          onClick={() =>
            void sendCommand({ type: 'ACKNOWLEDGE_PROVIDER', provider: id }).then(load)
          }
        >
          {id === 'gemini' ? "I understand, and I'm not in those regions" : 'I understand'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Offered where Sima can't read a supported site's page, which is when a capture is needed. */
export function CaptureLayout({ tabId }: { tabId: number }) {
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const result = await sendCommand<CaptureResult>({ type: 'CAPTURE_PAGE', tabId });
      if (result.status === 'refused') {
        setMessage(result.reason);
        return;
      }
      const { capture } = result;
      const blob = new Blob([JSON.stringify(capture, null, 1)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `sima-page-${capture.platformId}-${capture.capturedOn}.json`;
      link.click();
      setMessage('Saved to your Downloads. Check it before sharing it.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not capture this page.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2" data-testid="capture-layout">
      <Button
        size="sm"
        variant="outline"
        data-testid="capture-page"
        disabled={saving}
        onClick={() => void save()}
      >
        <FileDown /> Save page layout
      </Button>
      <p className="text-xs text-muted-foreground">
        Saves how this page is built, without its questions, answers or names, so support for it can
        be added.
      </p>
      {message && (
        <p className="text-xs font-medium text-foreground" data-testid="capture-message">
          {message}
        </p>
      )}
    </div>
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

  // Reopening the dropdown mid-run loses which button started it, so stay neutral then.
  const filling =
    task.status === 'executing' || (task.status === 'reasoning' && running === 'fill');
  const explaining = task.status === 'reasoning' && running === 'explain';
  const working = task.status === 'reasoning' && running === null;
  const iconClass = 'animate-spin';

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2" data-testid="controls">
        <Button
          className="h-9 rounded-lg"
          data-testid="auto-fill"
          disabled={busy}
          onClick={() => {
            if (task.fillAuthorizedAt === null) setAsking(true);
            else void start('fill');
          }}
        >
          {filling || working ? <LoaderCircle className={iconClass} /> : <Zap />}
          <span data-testid="fill-label">
            {filling || working
              ? (task.activityNote ?? (working ? 'Working…' : 'Filling…'))
              : 'Fill answers'}
          </span>
        </Button>
        <Button
          className="h-9 rounded-lg"
          variant="outline"
          data-testid="solve-all"
          disabled={busy || !unsolved}
          onClick={() => void start('explain')}
        >
          {explaining ? <LoaderCircle className={iconClass} /> : <Sparkles />}
          {explaining ? (task.activityNote ?? 'Explaining…') : 'Explain only'}
        </Button>
      </div>
      {asking && (
        <div
          role="alertdialog"
          aria-labelledby="fill-permission-title"
          className="flex flex-col gap-2.5 rounded-lg bg-muted p-3"
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
