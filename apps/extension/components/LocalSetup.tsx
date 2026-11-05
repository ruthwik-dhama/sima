import { useCallback, useEffect, useState } from 'react';
import {
  MODEL_DOWNLOAD_KEY,
  ModelDownloadSchema,
  type ModelDownload,
  type OllamaStatus,
} from '@sima/shared-types';
import { Download, ExternalLink, LoaderCircle } from 'lucide-react';
import { OllamaAccess } from '@/components/OllamaAccess';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { sendCommand } from '@/services/messaging';

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
/** How often to look for Ollama while the user installs, opens or restarts it. */
const POLL_MS = 3000;
/** The background writes at least every 10 seconds while downloading, so silence means it stopped. */
const STALE_MS = 45_000;

async function readDownload(): Promise<ModelDownload | null> {
  const stored = await chrome.storage.local.get(MODEL_DOWNLOAD_KEY);
  const parsed = ModelDownloadSchema.safeParse(stored[MODEL_DOWNLOAD_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Local AI setup, used as onboarding in the dropdown and in Settings. It finds Ollama by itself,
 * so the user only installs it, allows Sima if Ollama asks, and starts the model download.
 * Settings change once a model is ready, and whoever shows this then moves on.
 */
export function LocalSetup() {
  const [ollama, setOllama] = useState<OllamaStatus['status'] | 'looking'>('looking');
  const [download, setDownload] = useState<ModelDownload | null>(null);
  const [now, setNow] = useState(Date.now());

  const check = useCallback(async () => {
    const result = await sendCommand<OllamaStatus>({ type: 'CHECK_OLLAMA' }).catch(() => null);
    setOllama(result?.status ?? 'not_running');
  }, []);

  useEffect(() => {
    void readDownload().then(setDownload);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (MODEL_DOWNLOAD_KEY in changes) void readDownload().then(setDownload);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const running = download?.state === 'running' && now - download.updatedAt < STALE_MS;
  // Once Ollama answers, an old refusal from a download no longer applies.
  const blocked = ollama === 'blocked' || (download?.state === 'blocked' && ollama !== 'ready');
  const stopped = download !== null && !running;

  // Keep looking until Ollama answers, so installing or restarting it moves setup along.
  useEffect(() => {
    void check();
    if (ollama === 'ready' && !blocked) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void check();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [check, ollama, blocked]);

  // While downloading, only the clock needs to move, to notice a download that died.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(timer);
  }, [running]);

  const startDownload = async () => {
    setNow(Date.now());
    await sendCommand({ type: 'DOWNLOAD_MODEL' });
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-muted p-4" data-testid="local-setup">
      <div>
        <p className="text-base font-semibold">Set up your free local AI</p>
        <p className="text-sm text-muted-foreground">
          Sima runs AI on this computer with a free app called Ollama, so your questions never leave
          it. There's no account or key. Check every answer, since the AI can be wrong.
        </p>
      </div>

      {ollama === 'looking' && !running && (
        <p className="flex items-center gap-2 text-sm" data-testid="local-looking">
          <LoaderCircle className="size-4 animate-spin" /> Looking for Ollama…
        </p>
      )}

      {ollama === 'not_running' && !running && (
        <div className="flex flex-col gap-3" data-testid="local-install">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm" data-testid="local-steps">
            <li>Download Ollama, then install it.</li>
            <li>Open Ollama. Sima notices by itself and moves to the next step.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="bg-background"
              data-testid="ollama-download"
              onClick={() => window.open(OLLAMA_DOWNLOAD_URL, '_blank', 'noopener')}
            >
              <ExternalLink /> Download Ollama
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" /> Waiting for Ollama
            </span>
          </div>
        </div>
      )}

      {blocked && !running && <OllamaAccess onCheck={check} />}

      {ollama === 'ready' && !blocked && !running && (
        <div className="flex flex-col gap-3" data-testid="local-model-step">
          <p className="text-sm">
            Ollama is ready. Last step: download the AI model. It needs about 5 GB of free space and
            can take a while on slower connections. You can close Sima while it downloads.
          </p>
          {stopped && (
            <p className="text-sm font-medium text-destructive" data-testid="local-setup-error">
              The download stopped. Check your internet connection and free disk space, make sure
              Ollama is open, then try again. It picks up where it left off.
            </p>
          )}
          <Button
            className="self-start"
            data-testid="ollama-pull"
            onClick={() => void startDownload()}
          >
            <Download /> {stopped ? 'Try the download again' : 'Download the AI model'}
          </Button>
        </div>
      )}

      {download && running && (
        <div className="flex flex-col gap-2" data-testid="local-downloading">
          <Progress value={(download.fraction ?? 0) * 100} />
          <p className="text-sm">
            {download.fraction === null
              ? 'Starting the download…'
              : `${Math.round(download.fraction * 100)}% downloaded.`}{' '}
            You can close Sima. The download keeps going while Chrome is open.
          </p>
        </div>
      )}
    </div>
  );
}
