import { useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Steps {
  open: string;
  restart: string;
  command: string;
  note?: string;
}

/** Ollama's documented setting, limited to this one extension rather than all of them. */
export function ollamaSteps(extensionId: string, userAgent: string): Steps {
  const origin = `chrome-extension://${extensionId}`;
  if (/Windows/.test(userAgent)) {
    return {
      open: 'Open the Start menu, type Command Prompt, and open it.',
      restart: 'Quit Ollama from its icon near the clock, then open it again.',
      command: `setx OLLAMA_ORIGINS "${origin}"`,
    };
  }
  if (/Mac/.test(userAgent)) {
    return {
      open: 'Press Command and Space, type Terminal, and press Return.',
      restart: 'Quit Ollama from its icon in the menu bar, then open it again.',
      command: `launchctl setenv OLLAMA_ORIGINS "${origin}"`,
      note: 'Your Mac forgets this setting when it restarts. If Sima shows this again, repeat these steps.',
    };
  }
  return {
    open: 'Quit Ollama, then open a terminal.',
    restart: 'Leave that terminal open while you use Sima.',
    command: `OLLAMA_ORIGINS="${origin}" ollama serve`,
  };
}

/** Shown when Ollama refuses Sima. Ollama only accepts extensions the user has listed. */
export function OllamaAccess({ onCheck }: { onCheck: () => Promise<void> }) {
  const steps = ollamaSteps(chrome.runtime.id, navigator.userAgent);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(steps.command);
    setCopied(true);
  };
  const check = async () => {
    setChecking(true);
    try {
      await onCheck();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted p-4" data-testid="ollama-blocked">
      <div>
        <p className="text-base font-semibold">Let Ollama work with Sima</p>
        <p className="text-sm text-muted-foreground">
          Ollama only answers Chrome extensions you've approved. This one setting approves Sima, and
          no other extension.
        </p>
      </div>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>{steps.open}</li>
        <li>
          Copy this, paste it there, and press Return.
          <code
            className="mt-1 block rounded bg-background p-2 text-xs break-all"
            data-testid="ollama-command"
          >
            {steps.command}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="mt-1 bg-background"
            data-testid="ollama-copy"
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </li>
        <li>{steps.restart}</li>
      </ol>
      {steps.note && <p className="text-xs text-muted-foreground">{steps.note}</p>}
      <Button
        className="self-start"
        data-testid="ollama-recheck"
        disabled={checking}
        onClick={() => void check()}
      >
        {checking && <LoaderCircle className="animate-spin" />}
        {checking ? 'Checking…' : 'Check again'}
      </Button>
    </div>
  );
}
