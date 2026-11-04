import { useEffect } from 'react';
import { ArrowLeft, CircleAlert, Settings, Sparkles } from 'lucide-react';
import { PROVIDER_ENDPOINTS } from '@sima/shared-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { SettingsPage } from '@/components/SettingsPage';
import { useTaskStore } from '@/stores/task-store';
import { Authorization, Controls, Disclosure, ExecutionLog, Restricted } from './Sections';
import { QuestionCard } from './QuestionCard';

const STATUS_LABEL: Record<string, string> = {
  analyzing: 'Reading page',
  blocked_restricted: 'Not available',
  ready: 'Ready',
  reasoning: 'Working',
  review: 'Review',
  executing: 'Filling',
  navigating: 'Changing page',
  paused: 'Paused',
  completed: 'Finished',
  stopped: 'Stopped',
  error: 'Needs attention',
};

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
      <header className="sticky top-0 z-10 flex flex-col gap-2 border-b bg-background px-3 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="font-medium">Sima</span>
          {task && (
            <Badge variant="secondary" data-testid="task-status" data-status={task.status}>
              {STATUS_LABEL[task.status] ?? task.status}
            </Badge>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7"
            aria-label={settingsOpen ? 'Back to activity' : 'Open settings'}
            data-testid="settings-toggle"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            {settingsOpen ? <ArrowLeft className="size-4" /> : <Settings className="size-4" />}
          </Button>
        </div>
        {task && (
          <div className="min-w-0">
            <p className="truncate font-medium" data-testid="activity-title">
              {task.activityTitle}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="page-position">
              {task.platformName}
              {analysis && analysis.pagination.total > 1
                ? ` · Page ${analysis.pagination.index} of ${analysis.pagination.total}`
                : ''}
              {progress && progress.total > 0
                ? ` · ${progress.answered} of ${progress.total} answered`
                : ''}
            </p>
            {progress && progress.total > 0 && (
              <Progress className="mt-1 h-1" value={(progress.answered / progress.total) * 100} />
            )}
          </div>
        )}
      </header>

      {settingsOpen ? (
        <SettingsPage />
      ) : (
        <main className="flex flex-col gap-3 p-3">
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
                <Authorization task={task} />
                <Controls view={view} task={task} />
                {analysis?.instructions && (
                  <p className="rounded-md bg-muted p-2 text-xs" data-testid="instructions">
                    {analysis.instructions}
                  </p>
                )}
                {view.questions.map((record) => (
                  <QuestionCard
                    key={record.id}
                    record={record}
                    actions={view.actions}
                    blockers={view.plan.blockers}
                  />
                ))}
                <ExecutionLog actions={view.actions} />
              </>
            )
          )}
        </main>
      )}
    </div>
  );
}
