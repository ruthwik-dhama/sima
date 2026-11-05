import { useEffect, useState } from 'react';
import logo from '@/assets/logo.png?inline';
import { CircleAlert, Settings } from 'lucide-react';
import { findAdapter } from '@sima/adapter-core';
import { PROVIDER_ENDPOINTS } from '@sima/shared-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ADAPTERS } from '@/services/adapters';
import { openSettings } from '@/services/open-settings';
import { useTaskStore } from '@/stores/task-store';
import { CaptureLayout, Controls, Disclosure, Restricted } from './Sections';
import { QuestionCard } from './QuestionCard';

function isSupported(url: string): boolean {
  try {
    return findAdapter(ADAPTERS, new URL(url)) !== null;
  } catch {
    return false;
  }
}

export function App() {
  const { tabId, view, error, setTab, refresh, dismissError } = useTaskStore();
  const [onSupportedSite, setOnSupportedSite] = useState(false);

  useEffect(() => {
    const fromQuery = Number(new URLSearchParams(location.search).get('tabId'));
    if (fromQuery) {
      void setTab(fromQuery);
    } else {
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id !== undefined) void setTab(tab.id);
      });
    }
  }, [setTab]);

  useEffect(() => {
    const onMessage = (message: unknown) => {
      if ((message as { type?: string } | null)?.type === 'STATE_CHANGED') void refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [refresh]);

  // Whether this tab is on a site Sima has an adapter for, even if it can't read this page.
  useEffect(() => {
    if (tabId === null) return;
    void chrome.tabs
      .get(tabId)
      .then((tab) => setOnSupportedSite(tab.url ? isSupported(tab.url) : false))
      .catch(() => setOnSupportedSite(false));
  }, [tabId, view?.task?.id]);

  const task = view?.task;
  const analysis = view?.analysis;
  const progress = view?.progress;
  const restricted = task?.status === 'blocked_restricted';

  return (
    <div className="flex max-h-[600px] w-[380px] flex-col bg-background">
      <header
        className="flex shrink-0 flex-col gap-3 border-b p-4"
        data-testid="task-status"
        data-status={task?.status}
        data-page={analysis?.pagination.index}
      >
        <div className="flex items-center gap-2">
          <img src={logo} alt="" className="size-6 rounded-[6px]" data-testid="sima-logo" />
          <span className="font-semibold">Sima</span>
          <Button
            variant="ghost"
            size="icon"
            className="-my-1 ml-auto size-8 rounded-full text-muted-foreground"
            aria-label="Open settings"
            data-testid="open-settings-gear"
            onClick={openSettings}
          >
            <Settings className="size-4" />
          </Button>
        </div>
        {task && (
          <div className="flex min-w-0 flex-col gap-2">
            <h1
              className="truncate text-sm leading-snug font-semibold"
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
                  {progress.answered} of {progress.total}
                </span>
              </div>
            )}
          </div>
        )}
        {task && view && !restricted && <Controls key={task.id} view={view} task={task} />}
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {(error || task?.error || analysis?.warnings.length || (task && view)) && (
          <div className="flex flex-col gap-2 empty:hidden [&:has(>*)]:p-3">
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
            {analysis?.warnings.map((warning) => (
              <Alert key={warning} data-testid="analysis-warning">
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            ))}
            {restricted && analysis && <Restricted analysis={analysis} />}
            {!restricted && <Disclosure providers={PROVIDER_ENDPOINTS} />}
          </div>
        )}

        {!task && (
          <div className="px-6 py-8 text-center text-muted-foreground" data-testid="empty-state">
            {onSupportedSite ? (
              <div className="flex flex-col gap-3">
                <p className="font-medium text-foreground">Sima can't read this page yet</p>
                {tabId !== null && <CaptureLayout tabId={tabId} />}
              </div>
            ) : (
              <>
                <p className="font-medium text-foreground">No supported activity on this tab</p>
                <p>Open an activity on Gradescope, VHL Central or WebAssign to use Sima.</p>
              </>
            )}
          </div>
        )}

        {task && view && !restricted && view.questions.length === 0 && tabId !== null && (
          <div className="px-6 py-6">
            <CaptureLayout tabId={tabId} />
          </div>
        )}

        {task &&
          view &&
          !restricted &&
          view.questions.map((record) => (
            <QuestionCard
              key={record.id}
              record={record}
              actions={view.actions}
              blockers={view.plan.blockers}
            />
          ))}
      </main>
    </div>
  );
}
