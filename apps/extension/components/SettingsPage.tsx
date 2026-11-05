import { useEffect, useState } from 'react';
import type { OllamaStatus, Settings } from '@sima/shared-types';
import { LocalSetup } from '@/components/LocalSetup';
import { OllamaAccess } from '@/components/OllamaAccess';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ADAPTERS } from '@/services/adapters';
import { sendCommand } from '@/services/messaging';

const PRIVACY_URL = 'https://github.com/ruthwik-dhama/sima/blob/main/docs/PRIVACY.md';

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = async () => {
    const result = await sendCommand<{ settings: Settings }>({ type: 'GET_SETTINGS' });
    setSettings(result.settings);
  };
  useEffect(() => {
    void load();
    // Setup can finish in the background or from the dropdown.
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ('settings' in changes) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const check = async (): Promise<OllamaStatus> => {
    const result = await sendCommand<OllamaStatus>({ type: 'CHECK_OLLAMA' });
    setBlocked(result.status === 'blocked');
    if (result.status === 'ready') setModels(result.models);
    return result;
  };
  const ready = Boolean(settings?.model);
  // A model can be chosen while Ollama still refuses Sima, so say so here, not on the first question.
  useEffect(() => {
    if (ready) void check().catch(() => undefined);
  }, [ready]);

  if (!settings) return null;

  const update = async (next: Settings) => {
    setSettings(next);
    try {
      await sendCommand({ type: 'SAVE_SETTINGS', settings: next });
      setMessage(null);
    } catch {
      setMessage({ kind: 'error', text: 'Check the highlighted setting. It was not saved.' });
    }
  };

  const say = (kind: 'ok' | 'error', text: string) => setMessage({ kind, text });

  const testConnection = async () => {
    const result = await check().catch(() => null);
    if (result?.status === 'ready') {
      say('ok', `Connected to Ollama. ${result.models.length} models installed.`);
    } else if (result?.status === 'blocked') {
      setMessage(null);
    } else {
      say('error', "Sima can't find Ollama at this address. Make sure Ollama is open.");
    }
  };

  const deleteTaskData = async () => {
    await sendCommand({ type: 'DELETE_TASK_DATA' });
    say('ok', 'Deleted all saved activities, answers and logs.');
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-3 sm:p-6">
      <h1 className="text-xl font-medium">Sima settings</h1>
      {message && (
        <Alert
          variant={message.kind === 'error' ? 'destructive' : 'default'}
          data-testid="settings-message"
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Local AI</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!ready && <LocalSetup />}
          {ready && blocked && <OllamaAccess onCheck={() => check().then(() => undefined)} />}
          <div className="flex flex-col gap-1">
            <Label htmlFor="base-url">Ollama address</Label>
            <Input
              id="base-url"
              data-testid="ollama-url"
              value={settings.ollamaBaseUrl}
              onChange={(e) => void update({ ...settings, ollamaBaseUrl: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Local addresses only, so question text stays on this computer.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="model">Model</Label>
            <Input
              id="model"
              list="model-list"
              data-testid="model"
              value={settings.model}
              onChange={(e) => void update({ ...settings, model: e.target.value })}
            />
            <datalist id="model-list">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Setup picks one for you. Test the connection to list the models Ollama has.
            </p>
          </div>
          <Button
            className="self-start"
            variant="outline"
            data-testid="test-connection"
            onClick={() => void testConnection()}
          >
            Test connection
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Platforms</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {ADAPTERS.map((adapter) => (
            <div key={adapter.id} className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{adapter.displayName}</p>
                {adapter.compatibility === 'verified_live' && (
                  <p className="text-xs text-muted-foreground">Tested on the live site</p>
                )}
              </div>
              <Switch
                data-testid={`platform-${adapter.id}`}
                checked={!settings.disabledPlatforms.includes(adapter.id)}
                onCheckedChange={(on) =>
                  void update({
                    ...settings,
                    disabledPlatforms: on
                      ? settings.disabledPlatforms.filter((p) => p !== adapter.id)
                      : [...settings.disabledPlatforms, adapter.id],
                  })
                }
              />
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="font-medium">Show floating assistant</p>
            <Switch
              checked={settings.floatingEnabled}
              onCheckedChange={(on) => void update({ ...settings, floatingEnabled: on })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>
            Sima reads pages only on the platforms above, and sends question text only to Ollama on
            this computer. It has no online AI providers and needs no API key.
          </p>
          <p>
            It can't submit work, and it stays off on exams and on activities that prohibit AI help.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Privacy and data</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground" data-testid="privacy-summary">
            Activities, answers and logs are stored only in this browser, and question text never
            leaves this computer.{' '}
            <a className="underline" href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Read the full privacy terms
            </a>
            .
          </p>
          <Button
            variant="outline"
            className="self-start"
            data-testid="delete-tasks"
            onClick={() => void deleteTaskData()}
          >
            Delete saved activities
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
