"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

const DRAFT_STORAGE_KEY = "workgrid.bulkCaptureDraft.v1";
const PARSE_DEBOUNCE_MS = 300;
const EXAMPLE_TEXT = "- Investigate API latency #performance @primary:ada !focused color:forest\n- Prepare release notes #release\n- Replace deprecated runner";

type BulkIssue = { code: string; message: string };
type BulkParsedItem = {
  clientId: string; sourceLine: number; raw: string; title: string; category?: string;
  workflowIntent: "unfocused" | "focused"; primaryPersonId?: string; colorId?: string;
  warnings: BulkIssue[]; errors: BulkIssue[];
};
type BulkParseResult = { syntaxVersion: string; items: BulkParsedItem[]; summary: { total: number; valid: number; withWarnings: number; withErrors: number } };
type BulkPerson = { id: string; name: string };

function loadDraft(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(DRAFT_STORAGE_KEY) ?? ""; } catch { return ""; }
}
function saveDraft(text: string) {
  if (typeof window === "undefined") return;
  try { if (text) window.localStorage.setItem(DRAFT_STORAGE_KEY, text); else window.localStorage.removeItem(DRAFT_STORAGE_KEY); } catch { /* storage may be unavailable */ }
}

async function requestBulk(action: "tasks.parseBulk" | "tasks.createBulk", payload: Record<string, unknown>) {
  const response = await fetch("/api/board", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, payload }) });
  const body = await response.json() as { error?: { message?: string } | string };
  if (!response.ok) {
    const error = body.error;
    throw new Error(typeof error === "string" ? error : error?.message || "The request could not be completed.");
  }
  return body;
}

/** Mounted only while open (see page.tsx), so every field below starts fresh on each open — no reset-on-open effect needed. */
export function BulkCaptureDialog({ people, revision, onClose, onCreated }: {
  people: BulkPerson[]; revision: string; onClose: () => void; onCreated: (count: number) => void;
}) {
  const [text, setText] = useState(() => loadDraft());
  const [step, setStep] = useState<"edit" | "preview">("edit");
  const [parseResult, setParseResult] = useState<BulkParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [showExample, setShowExample] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const peopleById = new Map(people.map((person) => [person.id, person.name]));

  useEffect(() => { const timer = setTimeout(() => textareaRef.current?.focus(), 0); return () => clearTimeout(timer); }, []);
  useEffect(() => { saveDraft(text); }, [text]);

  useEffect(() => {
    if (step !== "edit" || !text.trim()) return;
    const timer = setTimeout(() => {
      setParsing(true);
      requestBulk("tasks.parseBulk", { text })
        .then((result) => {
          const parsed = result as unknown as BulkParseResult;
          setParseResult(parsed);
          setAnnouncement(`${parsed.summary.total} ${parsed.summary.total === 1 ? "task" : "tasks"} recognized${parsed.summary.withErrors ? `, ${parsed.summary.withErrors} need attention` : ""}${parsed.summary.withWarnings ? `, ${parsed.summary.withWarnings} with warnings` : ""}.`);
        })
        .catch((cause) => toast.error(cause instanceof Error ? cause.message : "Could not parse the draft."))
        .finally(() => setParsing(false));
    }, PARSE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, step]);

  function updateText(value: string) {
    setText(value);
    if (!value.trim()) setParseResult(null);
  }

  const discard = () => { setText(""); saveDraft(""); setParseResult(null); setAnnouncement("Draft discarded."); textareaRef.current?.focus(); };

  const includableItems = parseResult?.items.filter((item) => item.errors.length === 0) ?? [];
  const selectedItems = includableItems.filter((item) => !excludedIds.has(item.clientId));

  async function handleCreate() {
    if (!parseResult || !selectedItems.length) { toast.error("Select at least one task to create."); return; }
    setSubmitting(true);
    try {
      const result = await requestBulk("tasks.createBulk", {
        syntaxVersion: parseResult.syntaxVersion, mode: "atomic", idempotencyKey, expectedRevision: revision,
        items: selectedItems.map((item) => ({ clientId: item.clientId, title: item.title, category: item.category, primaryPersonId: item.primaryPersonId, colorId: item.colorId })),
      }) as { created: unknown[] };
      saveDraft("");
      toast.success(`Created ${result.created.length} ${result.created.length === 1 ? "task" : "tasks"}.`);
      onCreated(result.created.length);
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not create these tasks.");
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="bulk-capture-dialog" aria-describedby="bulk-capture-description">
        <DialogHeader>
          <DialogTitle>Bulk capture</DialogTitle>
          <DialogDescription id="bulk-capture-description">
            {step === "edit" ? "Paste or type one task per line. Your draft is saved automatically and survives an accidental close." : "Review what will be created. Lines that need attention are excluded until fixed."}
          </DialogDescription>
        </DialogHeader>
        <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>

        {step === "edit" ? (
          <div className="bulk-capture-edit">
            {showExample && (
              <div className="bulk-example" role="note">
                <div>
                  <p>One task per line. Optional tags anywhere on the line:</p>
                  <pre>{EXAMPLE_TEXT}</pre>
                  <p className="form-help"><code>#category</code> · <code>@primary:name-or-id</code> · <code>!focused</code> · <code>color:paletteId</code>. Start a word with <code>\</code> to keep it literal.</p>
                </div>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => setShowExample(false)} aria-label="Dismiss example"><X /></Button>
              </div>
            )}
            <Textarea ref={textareaRef} value={text} onChange={(event) => updateText(event.target.value)} placeholder="- Investigate API latency #performance" rows={10} className="bulk-capture-textarea" aria-label="Bulk task capture text" />
            <div className="bulk-capture-summary">
              {parsing ? <span>Parsing…</span> : parseResult ? (
                <span>{parseResult.summary.total} recognized · {parseResult.summary.valid} ready · {parseResult.summary.withWarnings} with warnings · {parseResult.summary.withErrors} need attention</span>
              ) : <span>Start typing to see a live summary.</span>}
            </div>
          </div>
        ) : (
          <div className="bulk-capture-preview">
            <ul className="bulk-preview-list">
              {parseResult?.items.map((item) => {
                const blocked = item.errors.length > 0;
                const checked = !blocked && !excludedIds.has(item.clientId);
                return (
                  <li key={item.clientId} className={`bulk-preview-item ${blocked ? "is-blocked" : ""}`}>
                    <Checkbox checked={checked} disabled={blocked} onCheckedChange={(value) => setExcludedIds((current) => {
                      const next = new Set(current);
                      if (value) next.delete(item.clientId); else next.add(item.clientId);
                      return next;
                    })} aria-label={`Include "${item.title || item.raw}"`} />
                    <div className="bulk-preview-copy">
                      <div className="bulk-preview-title">
                        <strong>{item.title || <em>(no title)</em>}</strong>
                        {item.category && <span className="bulk-preview-chip">#{item.category}</span>}
                        {item.workflowIntent === "focused" && <span className="bulk-preview-chip">→ {peopleById.get(item.primaryPersonId ?? "") ?? "primary owner"}</span>}
                      </div>
                      <span className="bulk-preview-source">Line {item.sourceLine}: {item.raw}</span>
                      {item.errors.map((issue, index) => <p key={index} className="form-error" role="alert">{issue.message}</p>)}
                      {item.warnings.map((issue, index) => <p key={index} className="bulk-preview-warning">{issue.message}</p>)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <DialogFooter>
          {step === "edit" ? (
            <>
              <Button type="button" variant="ghost" onClick={discard} disabled={!text}>Discard draft</Button>
              <Button type="button" onClick={() => setStep("preview")} disabled={!parseResult || parseResult.summary.total === 0 || parsing}>
                Preview {parseResult ? `(${parseResult.summary.total})` : ""}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("edit")}>Back to edit</Button>
              <Button type="button" onClick={handleCreate} disabled={submitting || !selectedItems.length}>
                {submitting ? "Creating…" : `Create ${selectedItems.length} ${selectedItems.length === 1 ? "task" : "tasks"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
