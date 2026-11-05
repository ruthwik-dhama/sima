import { useState } from 'react';
import {
  chooseDefaultOllamaModel,
  pullOllamaModel,
  RECOMMENDED_OLLAMA_MODEL,
} from '@sima/model-providers';
import type { Settings } from '@sima/shared-types';
import { Download, ExternalLink, LoaderCircle } from 'lucide-react';
import { SetupDone } from '@/components/GeminiSetup';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { sendCommand } from '@/services/messaging';
import { originPattern, providerOrigin } from '@/services/reasoner';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/\b403\b/.test(message)) {
    return "Your version of Ollama can't talk to Sima. Download the newest version, install it, then try again.";
  }
  return "Sima can't find Ollama yet. Make sure it's installed and open, then try again.";
}

type Stage = 'install' | 'checking' | 'model' | 'downloading' | 'done';

/** First-run local model setup, with no Terminal needed. */
export function LocalSetup({
  settings,
  onDone,
  onManual,
}: {
  settings: Settings;
  onDone: () => Promise<void>;
  onManual: () => void;
}) {
  const [stage, setStage] = useState<Stage>('install');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const useModel = async (model: string) => {
    const { settings: latest } = await sendCommand<{ settings: Settings }>({
      type: 'GET_SETTINGS',
    });
    await sendCommand({
      type: 'SAVE_SETTINGS',
      settings: { ...latest, models: { ...latest.models, ollama: model } },
    });
    setStage('done');
  };

  const check = async () => {
    setError(null);
    // Permission prompts need the click itself, so this request comes first.
    const origins = [originPattern(providerOrigin('ollama', settings))];
    const granted = await chrome.permissions.request({ origins }).catch(() => false);
    if (!granted) {
      setError("Sima can't reach Ollama unless you click Allow when Chrome asks.");
      return;
    }
    setStage('checking');
    try {
      const found = await sendCommand<string[]>({ type: 'TEST_PROVIDER', provider: 'ollama' });
      const model = chooseDefaultOllamaModel(found);
      if (model) await useModel(model);
      else setStage('model');
    } catch (reason) {
      setError(plainError(reason));
      setStage('install');
    }
  };

  const download = async () => {
    setError(null);
    setProgress(null);
    setStage('downloading');
    try {
      await pullOllamaModel(settings.ollamaBaseUrl, RECOMMENDED_OLLAMA_MODEL, setProgress);
      await useModel(RECOMMENDED_OLLAMA_MODEL);
    } catch {
      setError(
        'The download stopped. Check your internet connection and free disk space, make sure Ollama is open, then try again. It picks up where it left off.',
      );
      setStage('model');
    }
  };

  if (stage === 'done') {
    return (
      <SetupDone
        testId="local-ready"
        onClose={() => {
          void onDone();
          window.close();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-muted p-4" data-testid="local-setup">
      <div>
        <p className="text-base font-semibold">Set up your free local AI</p>
        <p className="text-sm text-muted-foreground">
          Sima will use a free app called Ollama to run AI on this computer, so question text stays
          here. Local AI can be slower and less accurate than online AI, so check every answer.
        </p>
      </div>

      {(stage === 'install' || stage === 'checking') && (
        <>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm" data-testid="local-steps">
            <li>Download Ollama, then install and open it.</li>
            <li>Come back here and click Ollama is open.</li>
            <li>If Chrome asks, click Allow so Sima can talk to Ollama.</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="bg-background"
              data-testid="ollama-download"
              onClick={() => window.open(OLLAMA_DOWNLOAD_URL, '_blank', 'noopener')}
            >
              <ExternalLink /> Download Ollama
            </Button>
            <Button
              data-testid="ollama-ready"
              disabled={stage === 'checking'}
              onClick={() => void check()}
            >
              {stage === 'checking' && <LoaderCircle className="animate-spin" />}
              {stage === 'checking' ? 'Looking for Ollama…' : 'Ollama is open'}
            </Button>
          </div>
        </>
      )}

      {stage === 'model' && (
        <>
          <p className="text-sm" data-testid="local-model-step">
            Ollama is ready. Now download the AI model. It needs about 5 GB of free space and can
            take a while on slower connections.
          </p>
          <Button className="self-start" data-testid="ollama-pull" onClick={() => void download()}>
            <Download /> Download the AI model
          </Button>
        </>
      )}

      {stage === 'downloading' && (
        <div className="flex flex-col gap-2" data-testid="local-downloading">
          <Progress value={(progress ?? 0) * 100} />
          <p className="text-sm">
            {progress === null
              ? 'Starting the download…'
              : `${Math.round(progress * 100)}% downloaded`}
            . Keep this tab open.
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm font-medium text-destructive" data-testid="local-setup-error">
          {error}
        </p>
      )}

      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline"
        data-testid="local-manual"
        onClick={onManual}
      >
        I'll enter the Ollama address and model myself
      </button>
    </div>
  );
}
