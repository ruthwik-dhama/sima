import { useEffect } from 'react';
import { ArrowLeft, CircleAlert, Settings, Sparkles } from 'lucide-react';
import { PROVIDER_ENDPOINTS } from '@sima/shared-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { SettingsPage } from '@/components/SettingsPage';
import { useTaskStore } from '@/stores/task-store';
import { Controls, Disclosure, Restricted } from './Sections';
import { QuestionCard } from './QuestionCard';

export function App() {
  const { view, error, setTab, refresh, dismissError, settingsOpen, setSettingsOpen } =
    useTaskStore();

  useEffect(() => {
    const fromQuery = Number(new URLSearchParams(location.search).get('tabId'));
    if (fromQuery) {
      void setTab(fromQuery);
    } else {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id !== undefined) void setTab(tab.id);
      });
      const onActivated = (info: { tabId: number }) => void setTab(info.tabId);
      chrome.tabs.onActivated.addListener(onActivated);
      return () => chrome.tabs.onActivated.removeListener(onActivated);
    }
  }, [setTab]);

  useEffect(() => {
    const onMessage = (message: unknown) => {
      if ((message as { type?: string } | null)?.type === 'STATE_CHANGED') void refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refresh]);

  const task = view?.task;
  const analysis = view?.analysis;
  const progress = view?.progress;

  return (
    <div className="flex min-h-screen flex-col">
      <header
        className="sticky top-0 z-10 flex flex-col gap-3 bg-background/90 px-4 pt-3 pb-3 backdrop-blur"
        data-testid="task-status"
        data-status={task?.status}
        data-page={analysis?.pagination.index}
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="font-semibold">Sima</span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-8 rounded-full text-muted-foreground"
            aria-label={settingsOpen ? 'Back to activity' : 'Open settings'}
            data-testid="settings-toggle"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            {settingsOpen ? <ArrowLeft className="size-4" /> : <Settings className="size-4" />}
          </Button>
        </div>
        {task && (
          <div className="flex min-w-0 flex-col gap-2">
            <h1
              className="truncate text-base leading-snug font-semibold"
              data-testid="activity-title"
            >
              {task.activityTitle}
            </h1>
            {progress && progress.total > 0 && (
              <div className="flex items-center gap-3">
                <Progress
                  className="h-1.5 flex-1"
                  value={(progress.answered / progress.total) * 100}
                />
                <span
                  className="shrink-0 text-xs text-muted-foreground"
                  data-testid="progress-text"
                >
                  {progress.answered} of {progress.total} answered
                </span>
              </div>
            )}
          </div>
        )}
      </header>

      {settingsOpen ? (
        <SettingsPage />
      ) : (
        <main className="flex flex-col gap-3 px-4 pt-1 pb-6">
          {error && (
            <Alert variant="destructive" data-testid="panel-error">
              <CircleAlert className="size-4" />
              <AlertDescription className="flex items-start justify-between gap-2">
                <span>{error}</span>
                <Button variant="ghost" size="sm" className="h-6" onClick={dismissError}>
                  Dismiss
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {task?.error && (
            <Alert variant="destructive">
              <AlertDescription>{task.error}</AlertDescription>
            </Alert>
          )}

          {!task && (
            <div className="py-8 text-center text-muted-foreground" data-testid="empty-state">
              <p className="font-medium text-foreground">No supported activity on this tab</p>
              <p>
                Open an activity on Gradescope, VHL Central or WebAssign, and Sima will read it
                here.
              </p>
            </div>
          )}

          {analysis?.warnings.map((warning) => (
            <Alert key={warning} data-testid="analysis-warning">
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))}

          {task?.status === 'blocked_restricted' && analysis ? (
            <Restricted analysis={analysis} />
          ) : (
            task &&
            view && (
              <>
                <Disclosure providers={PROVIDER_ENDPOINTS} />
                <Controls key={task.id} view={view} task={task} />
                {view.questions.map((record) => (
                  <QuestionCard
                    key={record.id}
                    record={record}
                    actions={view.actions}
                    blockers={view.plan.blockers}
                  />
                ))}
              </>
            )
          )}
        </main>
      )}
    </div>
  );
}
