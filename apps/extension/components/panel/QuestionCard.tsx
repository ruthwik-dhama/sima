import { useState } from 'react';
import { ChevronRight, CircleCheck, CircleX, ImageOff, TriangleAlert } from 'lucide-react';
import { autoFillHold } from '@sima/action-planner';
import {
  optionLetter,
  type ActionRecord,
  type AnswerField,
  type FieldOption,
  type PlanBlocker,
  type QuestionRecord,
} from '@sima/shared-types';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

/** Shows the same letter the model uses, so "the answer is: b" can be matched to a choice. */
function optionText(option: FieldOption, index: number, count: number): string {
  const letter = optionLetter(index, count);
  const text = option.label || option.id;
  return letter ? `${letter}. ${text}` : text;
}

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
        {field.options.map((option, index) => (
          <label key={option.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={values.includes(option.id)}
              onCheckedChange={(checked) =>
                void edit(
                  checked === true ? [...values, option.id] : values.filter((v) => v !== option.id),
                )
              }
            />
            {optionText(option, index, field.options.length)}
          </label>
        ))}
      </div>
    );
  }
  if (field.options.length > 0) {
    return (
      <Select value={values[0] ?? ''} onValueChange={(value) => void edit([value])}>
        <SelectTrigger className="w-full rounded-xl text-sm" data-testid={testId}>
          <SelectValue placeholder="Choose an option" />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((option, index) => (
            <SelectItem key={option.id} value={option.id}>
              {optionText(option, index, field.options.length)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const Control = field.kind === 'text' ? Input : Textarea;
  return (
    <Control
      className="rounded-xl text-sm"
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
  confidence,
}: {
  record: QuestionRecord;
  field: AnswerField;
  actions: ActionRecord[];
  blockers: PlanBlocker[];
  /** Shown on one field only, since it describes the whole question. */
  confidence: number | null;
}) {
  const run = useTaskStore((s) => s.run);
  const latest = actions
    .filter((a) => a.action.fieldKey === field.key && a.action.questionId === record.question.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const blocker = blockers.find(
    (b) => b.fieldKey === field.key && b.questionId === record.question.id,
  );
  const entered = field.currentValues.length > 0;
  const label = field.label || (record.question.fields.length > 1 ? field.key : '');
  const stateId = `field-state-${field.key}`;
  return (
    <div className="flex flex-col gap-1.5" data-testid={`field-${field.key}`}>
      {label && <Label className="text-xs text-muted-foreground">{label}</Label>}
      <FieldEditor record={record} field={field} />
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {confidence !== null && (
          <>
            <span data-testid={`confidence-${record.question.id}`}>{confidence}% confident</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span title={field.mappingReason}>match {Math.round(field.mappingConfidence * 100)}%</span>
        {latest?.status === 'failed' ? (
          <span className="ml-auto font-medium text-destructive" data-testid={stateId}>
            Not entered
          </span>
        ) : entered && latest?.status === 'verified' ? (
          <span
            className="ml-auto flex items-center gap-1 font-medium text-success"
            data-testid={stateId}
          >
            <CircleCheck className="size-3" /> Entered
          </span>
        ) : entered ? (
          <span className="ml-auto" data-testid={stateId}>
            Has a value
          </span>
        ) : null}
      </div>
      {latest?.status === 'failed' && (
        <p className="text-xs text-destructive">{latest.result?.detail}</p>
      )}
      {blocker?.code === 'low_mapping_confidence' && (
        <div
          className="flex items-center justify-between gap-2 rounded-lg bg-warning-surface p-2 text-xs text-warning"
          data-testid={`confirm-${field.key}`}
        >
          <span>Sima can't read these choices. Check the page before confirming.</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
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
          className="flex items-center justify-between gap-2 rounded-lg bg-warning-surface p-2 text-xs text-warning"
          data-testid={`overwrite-${field.key}`}
        >
          <span>This field holds "{field.currentValues.join(', ').slice(0, 60)}".</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
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

/** The number has its own badge and images their own line, so neither repeats in the text. */
function promptText(prompt: string, number: string): string {
  return prompt
    .replace(new RegExp(`^\\s*Q?${number}[.):]\\s*`, 'i'), '')
    .replace(/\s*\[image:[^\]]*\]/g, '')
    .trim();
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
  const ignored = question.suspiciousText[0];

  return (
    <Card
      className="sima-card gap-0 rounded-2xl border-0 py-4 ring-0"
      data-testid={`question-${question.id}`}
    >
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start gap-2.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
            {question.number}
          </span>
          <p className="min-w-0 pt-0.5 font-medium" data-testid={`prompt-${question.id}`}>
            {promptText(question.prompt, question.number)}
          </p>
        </div>
        {question.tables.map((table, t) => (
          <table key={t} className="w-full border-collapse overflow-hidden rounded-lg text-xs">
            <tbody>
              {table.map((row, r) => (
                <tr key={r} className="odd:bg-muted">
                  {row.map((cell, c) => (
                    <td key={c} className="px-2 py-1">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {question.images.map((image, i) => (
          <p key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ImageOff className="size-3 shrink-0" /> Image, not sent to the model:{' '}
            {image.alt || 'no description'}
          </p>
        ))}
        {record.solveError && (
          <Alert variant="destructive" data-testid={`solve-error-${question.id}`}>
            <AlertDescription>{record.solveError}</AlertDescription>
          </Alert>
        )}

        {(solution || Object.keys(record.responses).length > 0) &&
          question.fields.map((field, index) => (
            <FieldRow
              key={field.key}
              record={record}
              field={field}
              actions={actions}
              blockers={blockers}
              confidence={index === 0 ? confidence : null}
            />
          ))}
        {solution && !record.approved && autoFillHold(record) && (
          <p className="text-xs text-warning" data-testid={`held-${question.id}`}>
            {autoFillHold(record)}. Type an answer above, then click Fill answers.
          </p>
        )}

        {solution && (
          <details className="group -mb-1 text-xs" data-testid={`explanation-${question.id}`}>
            <summary
              className="flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
              data-testid={`explanation-toggle-${question.id}`}
            >
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              Explanation
              {ignored && (
                <TriangleAlert
                  className="ml-1 size-3 text-warning"
                  aria-label="Sima ignored a line aimed at AI tools"
                  data-testid={`injection-marker-${question.id}`}
                />
              )}
            </summary>
            <div className="mt-2 flex flex-col gap-2 rounded-xl bg-muted p-3">
              {ignored && (
                <p className="text-warning" data-testid={`injection-${question.id}`}>
                  Sima ignored this line, which is aimed at AI tools: "{ignored}" Instructors
                  sometimes add lines like this to spot AI use.
                </p>
              )}
              <p>{solution.explanation}</p>
              {solution.steps.length > 0 && (
                <ol className="flex list-decimal flex-col gap-0.5 pl-4">
                  {solution.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
              {solution.checks.length > 0 && (
                <ul className="flex flex-col gap-0.5" data-testid={`checks-${question.id}`}>
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
              {record.followUps.map((item) => (
                <div key={item.at} data-testid="follow-up-entry">
                  <p className="font-medium">{item.question}</p>
                  <p>{item.answer}</p>
                </div>
              ))}
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
                  className="h-8 bg-card text-xs"
                  placeholder="Ask about this question"
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                />
                <Button type="submit" size="sm" variant="outline" className="h-8 bg-card">
                  Ask
                </Button>
              </form>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
