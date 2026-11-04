import { useState } from 'react';
import { CircleCheck, CircleX, ImageOff, TriangleAlert } from 'lucide-react';
import type { ActionRecord, AnswerField, PlanBlocker, QuestionRecord } from '@sima/shared-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useTaskStore } from '@/stores/task-store';

function FieldEditor({ record, field }: { record: QuestionRecord; field: AnswerField }) {
  const run = useTaskStore((s) => s.run);
  const values = record.responses[field.key] ?? [];
  const edit = (next: string[]) =>
    run({ type: 'EDIT_RESPONSE', recordId: record.id, fieldKey: field.key, values: next });
  const [draft, setDraft] = useState<string | null>(null);
  const testId = `response-${field.key}`;

  if (field.kind === 'checkbox_group') {
    return (
      <div className="flex flex-col gap-1" data-testid={testId}>
        {field.options.map((option) => (
          <label key={option.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.includes(option.id)}
              onCheckedChange={(checked) =>
                void edit(
                  checked === true ? [...values, option.id] : values.filter((v) => v !== option.id),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    );
  }
  if (field.options.length > 0) {
    return (
      <Select value={values[0] ?? ''} onValueChange={(value) => void edit([value])}>
        <SelectTrigger size="sm" className="w-full" data-testid={testId}>
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label || option.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const Control = field.kind === 'text' ? Input : Textarea;
  return (
    <Control
      data-testid={testId}
      aria-label={field.label || field.key}
      value={draft ?? values[0] ?? ''}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) {
          void edit(draft === '' ? [] : [draft]);
          setDraft(null);
        }
      }}
    />
  );
}

function FieldRow({
  record,
  field,
  actions,
  blockers,
}: {
  record: QuestionRecord;
  field: AnswerField;
  actions: ActionRecord[];
  blockers: PlanBlocker[];
}) {
  const run = useTaskStore((s) => s.run);
  const latest = actions
    .filter((a) => a.action.fieldKey === field.key && a.action.questionId === record.question.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const blocker = blockers.find(
    (b) => b.fieldKey === field.key && b.questionId === record.question.id,
  );
  const entered = field.currentValues.length > 0;
  return (
    <div className="flex flex-col gap-1" data-testid={`field-${field.key}`}>
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">
          {field.label || (record.question.fields.length === 1 ? 'Response' : field.key)}
        </Label>
        <span className="text-[11px] text-muted-foreground" title={field.mappingReason}>
          match {Math.round(field.mappingConfidence * 100)}%
        </span>
        {latest?.status === 'failed' ? (
          <Badge variant="destructive" data-testid={`field-state-${field.key}`} className="ml-auto">
            Not entered
          </Badge>
        ) : entered && latest?.status === 'verified' ? (
          <Badge
            variant="secondary"
            data-testid={`field-state-${field.key}`}
            className="ml-auto text-success"
          >
            <CircleCheck /> Entered
          </Badge>
        ) : entered ? (
          <Badge variant="outline" data-testid={`field-state-${field.key}`} className="ml-auto">
            Has a value
          </Badge>
        ) : null}
      </div>
      <FieldEditor record={record} field={field} />
      {latest?.status === 'failed' && (
        <p className="text-xs text-destructive">{latest.result?.detail}</p>
      )}
      {blocker?.code === 'low_mapping_confidence' && (
        <div
          className="flex items-center justify-between gap-2 rounded-md bg-warning-surface p-1.5 text-xs text-warning"
          data-testid={`confirm-${field.key}`}
        >
          <span>Sima can't tell which blank this is. Check the page before confirming.</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6"
            onClick={() =>
              void run({ type: 'CONFIRM_FIELD', recordId: record.id, fieldKey: field.key })
            }
          >
            Confirm
          </Button>
        </div>
      )}
      {blocker?.code === 'existing_value' && (
        <div
          className="flex items-center justify-between gap-2 rounded-md bg-warning-surface p-1.5 text-xs text-warning"
          data-testid={`overwrite-${field.key}`}
        >
          <span>This field holds "{field.currentValues.join(', ').slice(0, 60)}".</span>
          <Button
            size="sm"
            variant="outline"
            className="h-6"
            onClick={() =>
              void run({ type: 'ALLOW_OVERWRITE', recordId: record.id, fieldKey: field.key })
            }
          >
            Replace it
          </Button>
        </div>
      )}
    </div>
  );
}

export function QuestionCard({
  record,
  actions,
  blockers,
}: {
  record: QuestionRecord;
  actions: ActionRecord[];
  blockers: PlanBlocker[];
}) {
  const run = useTaskStore((s) => s.run);
  const { question, solution } = record;
  const [followUp, setFollowUp] = useState('');
  const confidence = solution ? Math.round(solution.adjustedConfidence * 100) : null;
  const failedChecks = solution?.checks.filter((c) => c.status === 'fail') ?? [];

  return (
    <Card className="gap-2 py-3" data-testid={`question-${question.id}`}>
      <CardContent className="flex flex-col gap-2 px-3">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline">Q{question.number}</Badge>
          <span className="text-xs text-muted-foreground">{question.format.replace('_', ' ')}</span>
          {confidence !== null && (
            <span
              className="ml-auto text-xs text-muted-foreground"
              data-testid={`confidence-${question.id}`}
            >
              {confidence}% confident
            </span>
          )}
        </div>
        <p data-testid={`prompt-${question.id}`}>{question.prompt}</p>
        {question.tables.map((table, t) => (
          <table key={t} className="w-full border-collapse text-xs">
            <tbody>
              {table.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border px-1.5 py-0.5">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {question.images.map((image, i) => (
          <p key={i} className="flex items-center gap-1 text-xs text-muted-foreground">
            <ImageOff className="size-3" /> Image, not sent to the model:{' '}
            {image.alt || 'no description'}
          </p>
        ))}
        {question.suspiciousText.length > 0 && (
          <Alert data-testid={`injection-${question.id}`}>
            <TriangleAlert className="size-4" />
            <AlertDescription>
              This question contains text aimed at AI tools. Sima treats it as page content and
              doesn't follow it, but check the answer yourself: "{question.suspiciousText[0]}"
            </AlertDescription>
          </Alert>
        )}
        {record.solveError && (
          <Alert variant="destructive" data-testid={`solve-error-${question.id}`}>
            <AlertDescription>{record.solveError}</AlertDescription>
          </Alert>
        )}

        {solution && (
          <details
            open
            className="rounded-md bg-muted p-2 text-xs"
            data-testid={`explanation-${question.id}`}
          >
            <summary className="cursor-pointer font-medium">Explanation</summary>
            <p className="mt-1">{solution.explanation}</p>
            {solution.steps.length > 0 && (
              <ol className="mt-1 list-decimal pl-4">
                {solution.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
            {solution.checks.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-0.5" data-testid={`checks-${question.id}`}>
                {solution.checks.map((check, i) => (
                  <li key={i} className="flex items-start gap-1" data-check={check.status}>
                    {check.status === 'pass' ? (
                      <CircleCheck className="mt-0.5 size-3 shrink-0 text-success" />
                    ) : check.status === 'fail' ? (
                      <CircleX className="mt-0.5 size-3 shrink-0 text-destructive" />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-3 shrink-0 text-warning" />
                    )}
                    <span>
                      {check.name}: {check.detail}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
        {failedChecks.length > 0 && (
          <p className="text-xs font-medium text-destructive">
            A check failed. Don't rely on this answer without working it through yourself.
          </p>
        )}
        {record.followUps.map((item) => (
          <div key={item.at} className="text-xs" data-testid="follow-up-entry">
            <p className="font-medium">{item.question}</p>
            <p>{item.answer}</p>
          </div>
        ))}

        {(solution || Object.keys(record.responses).length > 0) && (
          <>
            {question.fields.map((field) => (
              <FieldRow
                key={field.key}
                record={record}
                field={field}
                actions={actions}
                blockers={blockers}
              />
            ))}
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                data-testid={`approve-${question.id}`}
                checked={record.approved}
                onCheckedChange={(checked) =>
                  void run({
                    type: 'SET_APPROVED',
                    recordId: record.id,
                    approved: checked === true,
                  })
                }
              />
              Approve this response
            </label>
            <form
              className="flex gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!followUp.trim()) return;
                void run({ type: 'FOLLOW_UP', recordId: record.id, question: followUp.trim() });
                setFollowUp('');
              }}
            >
              <Input
                data-testid={`follow-up-${question.id}`}
                className="h-7 text-xs"
                placeholder="Ask about this, or for another explanation"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
              />
              <Button type="submit" size="sm" variant="outline" className="h-7">
                Ask
              </Button>
            </form>
          </>
        )}
        {!solution && (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            data-testid={`solve-${question.id}`}
            onClick={() =>
              void run({ type: 'SOLVE', taskId: record.taskId, questionIds: [question.id] })
            }
          >
            Work through this one
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
