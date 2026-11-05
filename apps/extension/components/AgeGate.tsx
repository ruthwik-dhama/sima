import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { sendCommand } from '@/services/messaging';

/** The one-time birth date step. The date itself is never saved or sent anywhere. */
export function AgeGate({ onDone }: { onDone: () => void }) {
  const [birthDate, setBirthDate] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await sendCommand({ type: 'SET_BIRTH_DATE', birthDate });
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enter a real birth date.');
    }
  };

  return (
    <form
      className="flex flex-col gap-2 rounded-lg bg-muted p-3"
      data-testid="age-gate"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Label htmlFor="birth-date" className="font-medium">
        Enter your birth date to set up Sima
      </Label>
      <Input
        id="birth-date"
        type="date"
        className="bg-background"
        data-testid="birth-date"
        value={birthDate}
        onChange={(event) => setBirthDate(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        If you're 18 or older, Sima uses Google Gemini's free tier by default. If you're under 18,
        Sima uses a local model through Ollama. You can only enter this once, and your birth date
        isn't saved or sent anywhere.
      </p>
      {error && (
        <p className="text-xs font-medium text-destructive" data-testid="age-gate-error">
          {error}
        </p>
      )}
      <Button size="sm" type="submit" className="self-start" data-testid="birth-date-submit">
        Continue
      </Button>
    </form>
  );
}
