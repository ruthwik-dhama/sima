import { useEffect, useRef, useState } from 'react';
import { chooseDefaultGeminiModel } from '@sima/model-providers';
import type { Settings } from '@sima/shared-types';
import { Check, ClipboardPaste, ExternalLink, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendCommand } from '@/services/messaging';

const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 500;

/** Checked before anything leaves the page, since the clipboard could hold anything. */
function looksLikeKey(text: string): boolean {
  return (
    text.length >= MIN_KEY_LENGTH &&
    text.length <= MAX_KEY_LENGTH &&
    !/\s/.test(text) &&
    !text.includes('://')
  );
}

/** Only blames the key when Google actually rejected it. */
function plainError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/location is not supported/i.test(message)) {
    return "Google's free AI isn't available where you are. Choose a local model below instead.";
  }
  if (/could not reach/i.test(message)) {
    return "Sima couldn't reach Google. Check your internet connection, then try again.";
  }
  if (!/^Provider returned/.test(message) && /busy|limit/i.test(message)) return message;
  return "That key didn't work. Go back to Google's page, copy the key again, and paste it here.";
}

type Stage = 'agree' | 'paste' | 'checking' | 'done';

/** First-run Gemini setup for someone who has never heard of an API key. */
export function GeminiSetup({
  settings,
  onChanged,
  onUseLocal,
}: {
  settings: Settings;
  onChanged: () => Promise<void>;
  onUseLocal: () => void;
}) {
  const agreed = settings.acknowledgedProviders.includes('gemini');
  const [stage, setStage] = useState<Stage>(agreed ? 'paste' : 'agree');
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const box = useRef<HTMLInputElement>(null);

  // People come back from Google's page with the key copied, so be ready for it.
  useEffect(() => {
    if (stage !== 'paste') return;
    const focus = () => box.current?.focus();
    focus();
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [stage]);

  const agreeAndOpen = async () => {
    window.open(GEMINI_KEY_URL, '_blank', 'noopener');
    setStage('paste');
    await sendCommand({ type: 'ACKNOWLEDGE_PROVIDER', provider: 'gemini' });
    await onChanged();
  };

  const check = async (raw: string) => {
    const key = raw.trim();
    setTyped('');
    if (!looksLikeKey(key)) {
      setError("That doesn't look like a key. On Google's page, click the copy button next to it.");
      return;
    }
    setError(null);
    setStage('checking');
    try {
      await sendCommand({ type: 'SET_API_KEY', provider: 'gemini', apiKey: key });
      const models = await sendCommand<string[]>({ type: 'TEST_PROVIDER', provider: 'gemini' });
      const model = chooseDefaultGeminiModel(models);
      if (!model) throw new Error('No model available');
      const { settings: latest } = await sendCommand<{ settings: Settings }>({
        type: 'GET_SETTINGS',
      });
      await sendCommand({
        type: 'SAVE_SETTINGS',
        settings: { ...latest, models: { ...latest.models, gemini: model } },
      });
      setStage('done');
    } catch (reason) {
      await sendCommand({ type: 'SET_API_KEY', provider: 'gemini', apiKey: '' }).catch(() => {});
      setError(plainError(reason));
      setStage('paste');
    }
  };

  const pasteFromClipboard = async () => {
    try {
      await check(await navigator.clipboard.readText());
    } catch {
      setError('Click the box above, then press Cmd+V (Mac) or Ctrl+V (Windows) to paste.');
      box.current?.focus();
    }
  };

  if (stage === 'done') {
    return (
      <div className="flex flex-col gap-3 rounded-lg bg-muted p-4" data-testid="gemini-ready">
        <p className="flex items-center gap-2 text-base font-semibold">
          <Check className="size-5 text-success" /> You're all set
        </p>
        <p className="text-sm">
          Go back to your activity, click the Sima icon, then click Fill answers or Explain only.
        </p>
        <Button
          className="self-start"
          data-testid="gemini-setup-close"
          onClick={() => {
            void onChanged();
            window.close();
          }}
        >
          Back to my activity
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-muted p-4" data-testid="gemini-setup">
      <div>
        <p className="text-base font-semibold">Turn on free AI, in about a minute</p>
        <p className="text-sm text-muted-foreground">
          Sima uses Google Gemini's free tier. You just need a free key from Google, like a password
          that lets Sima ask Gemini for you. No payment or card needed.
        </p>
      </div>

      {stage === 'agree' && (
        <>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-testid="gemini-agreement">
            <li>You're 18 or older, and not in the EEA, Switzerland or the UK.</li>
            <li>
              Question text goes to Google when you use Sima. On the free tier, Google may use it to
              improve its products and human reviewers may read it, so don't send personal
              information.
            </li>
          </ul>
          <Button
            className="self-start"
            data-testid="gemini-agree"
            onClick={() => void agreeAndOpen()}
          >
            <ExternalLink /> I agree, get my free key
          </Button>
        </>
      )}

      {stage !== 'agree' && (
        <>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm" data-testid="gemini-steps">
            <li>
              On{' '}
              <a
                className="underline"
                href={GEMINI_KEY_URL}
                target="_blank"
                rel="noreferrer"
                data-testid="gemini-key-link"
              >
                Google's page
              </a>
              , sign in and accept the terms if asked.
            </li>
            <li>
              Click <strong>Create API key</strong> if you don't see a key yet. If it asks for a
              project, choose <strong>Create project</strong>, type any name, and continue.
            </li>
            <li>Click the copy button next to your key.</li>
            <li>Come back to this page and paste it here:</li>
          </ol>
          <div className="flex flex-wrap gap-2">
            <Input
              ref={box}
              type="password"
              autoComplete="off"
              className="min-w-48 flex-1 bg-background"
              placeholder="Paste your key here"
              aria-label="Your Gemini key"
              data-testid="gemini-key"
              disabled={stage === 'checking'}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onPaste={(event) => {
                event.preventDefault();
                void check(event.clipboardData.getData('text'));
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void check(typed);
              }}
            />
            <Button
              variant="outline"
              className="bg-background"
              data-testid="gemini-paste"
              disabled={stage === 'checking'}
              onClick={() => void pasteFromClipboard()}
            >
              {stage === 'checking' ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ClipboardPaste />
              )}
              {stage === 'checking' ? 'Checking your key…' : 'Paste my key'}
            </Button>
          </div>
          {error && (
            <p className="text-sm font-medium text-destructive" data-testid="gemini-setup-error">
              {error}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Your key is stored only in this browser. Treat it like a password and don't share it.
          </p>
        </>
      )}

      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline"
        data-testid="gemini-use-local"
        onClick={onUseLocal}
      >
        I'd rather use a local model, or I'm in the EEA, Switzerland or the UK
      </button>
    </div>
  );
}
