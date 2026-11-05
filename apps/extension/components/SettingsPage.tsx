import { useEffect, useState } from 'react';
import { chooseDefaultGeminiModel } from '@sima/model-providers';
import { PROVIDER_ENDPOINTS, type ProviderId, type Settings } from '@sima/shared-types';
import { AgeGate } from '@/components/AgeGate';
import { GeminiSetup } from '@/components/GeminiSetup';
import { LocalSetup } from '@/components/LocalSetup';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ADAPTERS } from '@/services/adapters';
import { sendCommand } from '@/services/messaging';
import { originPattern, providerOrigin } from '@/services/reasoner';

const PROVIDERS: ProviderId[] = ['gemini', 'ollama', 'openai', 'anthropic'];
const PRIVACY_URL = 'https://github.com/ruthwik-dhama/sima/blob/main/docs/PRIVACY.md';

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [configured, setConfigured] = useState<ProviderId[]>([]);
  const [manualLocal, setManualLocal] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = async () => {
    const result = await sendCommand<{ settings: Settings; configured: ProviderId[] }>({
      type: 'GET_SETTINGS',
    });
    setSettings(result.settings);
    setConfigured(result.configured);
  };
  useEffect(() => void load(), []);

  if (!settings) return null;
  const id = settings.activeProvider;
  const needsGeminiSetup = id === 'gemini' && !configured.includes('gemini');
  const needsLocalSetup = id === 'ollama' && !settings.models.ollama && !manualLocal;

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
    // Permission prompts need the click itself, so this request comes first.
    const origins = [originPattern(providerOrigin(id, settings))];
    const granted = await chrome.permissions.request({ origins }).catch(() => false);
    if (!granted)
      return say(
        'error',
        `Sima can't reach ${PROVIDER_ENDPOINTS[id].name} without that permission.`,
      );
    try {
      if (apiKey) {
        await sendCommand({ type: 'SET_API_KEY', provider: id, apiKey });
        setApiKey('');
        await load();
      }
      const found = await sendCommand<string[]>({ type: 'TEST_PROVIDER', provider: id });
      setModels(found);
      if (id === 'gemini' && !settings.models.gemini) {
        const model = chooseDefaultGeminiModel(found);
        if (model) await update({ ...settings, models: { ...settings.models, gemini: model } });
      }
      say('ok', `Connected to ${PROVIDER_ENDPOINTS[id].name}. ${found.length} models available.`);
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'Connection failed.');
    }
  };

  const deleteTaskData = async () => {
    await sendCommand({ type: 'DELETE_TASK_DATA' });
    say('ok', 'Deleted all saved activities, answers and logs.');
  };
  const deleteKeys = async () => {
    await sendCommand({ type: 'DELETE_API_KEYS' });
    await load();
    say('ok', 'Deleted all API keys.');
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

      {settings.ageCheck === 'unset' && <AgeGate onDone={() => void load()} />}

      {settings.ageCheck !== 'unset' && (
        <Card>
          <CardHeader>
            <CardTitle>AI provider</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label>Provider</Label>
              <Select
                value={id}
                onValueChange={(value) => {
                  setModels([]);
                  void update({ ...settings, activeProvider: value as ProviderId });
                }}
              >
                <SelectTrigger className="w-full" data-testid="provider-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.filter(
                    (p) => settings.ageCheck === 'adult' || !PROVIDER_ENDPOINTS[p].external,
                  ).map((p) => (
                    <SelectItem key={p} value={p}>
                      {PROVIDER_ENDPOINTS[p].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {settings.ageCheck === 'minor' && (
              <p className="text-xs text-muted-foreground" data-testid="minor-note">
                You're under 18, so Sima uses a local model through Ollama. Question text stays on
                this computer.
              </p>
            )}
            {id === 'gemini' && !needsGeminiSetup && (
              <p className="text-xs text-muted-foreground" data-testid="gemini-terms-settings">
                Google may use what's sent on the free tier to improve its products, and human
                reviewers may read it. It's only for people 18 or older, and isn't available in the
                EEA, Switzerland or the UK. If you're in those regions, choose Ollama instead.
              </p>
            )}
            {needsGeminiSetup && (
              <GeminiSetup
                settings={settings}
                onChanged={load}
                onUseLocal={() => void update({ ...settings, activeProvider: 'ollama' })}
              />
            )}
            {needsLocalSetup && (
              <LocalSetup settings={settings} onDone={load} onManual={() => setManualLocal(true)} />
            )}
            {!needsGeminiSetup && !needsLocalSetup && (
              <>
                {id === 'ollama' ? (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="base-url">Server URL</Label>
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
                ) : (
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="api-key">
                      API key{' '}
                      {configured.includes(id) && (
                        <span className="font-normal text-muted-foreground">(saved)</span>
                      )}
                    </Label>
                    <Input
                      id="api-key"
                      type="password"
                      autoComplete="off"
                      data-testid="api-key"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={configured.includes(id) ? 'Enter a new key to replace it' : ''}
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored unencrypted in this browser profile, and only used by Sima's background
                      worker to call {PROVIDER_ENDPOINTS[id].origin}.
                    </p>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <Label htmlFor="model">Model</Label>
                  <Input
                    id="model"
                    list="model-list"
                    data-testid="model"
                    value={settings.models[id] ?? ''}
                    onChange={(e) =>
                      void update({
                        ...settings,
                        models: { ...settings.models, [id]: e.target.value },
                      })
                    }
                  />
                  <datalist id="model-list">
                    {models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <p className="text-xs text-muted-foreground">
                    Test the connection to list the models available to you.
                  </p>
                </div>
                <Button
                  className="self-start"
                  data-testid="test-connection"
                  onClick={() => void testConnection()}
                >
                  Save and test connection
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

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
            Sima reads pages only on the platforms above. It can reach Google Gemini, but sends
            nothing until you add a key, and it asks before reaching any other online provider.
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
          <p className="text-xs text-muted-foreground">
            Activities, answers and logs are stored only in this browser. Question text leaves it
            only when you ask Sima to work through a question using an online provider.
          </p>
          <p className="text-xs text-muted-foreground" data-testid="privacy-summary">
            Your birth date only decides your provider, and isn't saved. Online providers are for
            people 18 or older, and Gemini's free tier isn't available in the EEA, Switzerland or
            the UK.{' '}
            <a className="underline" href={PRIVACY_URL} target="_blank" rel="noreferrer">
              Read the full privacy terms
            </a>
            .
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              data-testid="delete-tasks"
              onClick={() => void deleteTaskData()}
            >
              Delete saved activities
            </Button>
            <Button variant="outline" data-testid="delete-keys" onClick={() => void deleteKeys()}>
              Delete API keys
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
