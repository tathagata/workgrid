"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowDown, ArrowUp, Check, ChevronDown, CirclePlay, Download, GripVertical,
  Keyboard, MoreHorizontal, Pencil, Plus, Search, Trash2, UserPlus, Users, X,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TASK_PALETTE } from "@/lib/task-colors";
import { PEOPLE_PALETTE } from "@/lib/people-colors";

type Focus = "primary" | "secondary" | "tertiary";
type WorkflowState = "unfocused" | "focused" | "archived";
type TerminalOutcome = "completed" | "cancelled" | "superseded";
type LoadState = "low" | "balanced" | "overloaded";
type PersonLoad = { calculationVersion: number; score: number; state: LoadState; activeAssignmentCount: number; counts: Record<Focus, number> };
type Person = { id: string; name: string; role: string; color: string; colorId: string | null; sortOrder: number; load: PersonLoad };
type Task = {
  id: string; title: string; description: string; category: string; color: string; colorId: string | null;
  workflow: { state: WorkflowState; outcome?: TerminalOutcome; changedAt: string };
  revision: number; sortOrder: number; createdAt: string; updatedAt: string;
};
type Assignment = { id: string; taskId: string; personId: string; focus: Focus; createdAt: string };
type BoardState = { apiVersion: 1; people: Person[]; tasks: Task[]; assignments: Assignment[]; revision: string; savedAt: string; appearance: { paletteVersion: number };
  workload: { calculationVersion: number; weights: Record<Focus, number>; thresholds: { balancedMinimum: number; overloadedAbove: number } } };
type EditorState = { kind: "task"; id?: string } | { kind: "person"; id?: string } | null;
type DeleteState = { kind: "task" | "person"; id: string; name: string } | null;

const focusLevels: { id: Focus; label: string; helper: string }[] = [
  { id: "primary", label: "Primary", helper: "Accountable owner" },
  { id: "secondary", label: "Secondary", helper: "Active contributor" },
  { id: "tertiary", label: "Tertiary", helper: "Consulted or backup" },
];

async function requestState(action?: string, payload?: Record<string, unknown>) {
  const response = await fetch("/api/board", {
    method: action ? "POST" : "GET",
    headers: action ? { "content-type": "application/json" } : undefined,
    body: action ? JSON.stringify({ action, payload }) : undefined,
  });
  const body = await response.json() as { error?: { message?: string } | string; board?: BoardState } | BoardState;
  if (!response.ok) {
    const error = "error" in body ? body.error : undefined;
    throw new Error(typeof error === "string" ? error : error?.message || "The local data service did not respond.");
  }
  return (action && "board" in body ? body.board : body) as BoardState;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function TaskMenu({ task, onEdit, onArchive, onRestore, onDelete, onMoveUp, onMoveDown, onMoveFirst, onMoveLast }: {
  task: Task; onEdit: () => void; onArchive: (outcome?: TerminalOutcome) => void; onRestore: () => void; onDelete: () => void;
  onMoveUp?: () => void; onMoveDown?: () => void; onMoveFirst?: () => void; onMoveLast?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" className="task-menu-button"
          aria-label={`Actions for ${task.title}`} onClick={(event) => event.stopPropagation()}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuLabel>Task actions</DropdownMenuLabel>
        {(onMoveUp || onMoveDown || onMoveFirst || onMoveLast) && <><DropdownMenuItem disabled={!onMoveUp} onSelect={onMoveUp}><ArrowUp /> Move up</DropdownMenuItem>
          <DropdownMenuItem disabled={!onMoveDown} onSelect={onMoveDown}> <ArrowDown /> Move down</DropdownMenuItem>
          <DropdownMenuItem disabled={!onMoveFirst} onSelect={onMoveFirst}>Move to top</DropdownMenuItem>
          <DropdownMenuItem disabled={!onMoveLast} onSelect={onMoveLast}>Move to bottom</DropdownMenuItem><DropdownMenuSeparator /></>}
        <DropdownMenuItem onSelect={onEdit}><Pencil /> Edit</DropdownMenuItem>
        {task.workflow.state === "archived" ? (
          <DropdownMenuItem onSelect={onRestore}><CirclePlay /> Restore to active work</DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem onSelect={() => onArchive("completed")}><Check /> Mark completed</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onArchive()}><Archive /> Archive</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onArchive("cancelled")}><Archive /> Archive as cancelled</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onArchive("superseded")}><Archive /> Archive as superseded</DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 /> Delete permanently</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskCard({ task, selected, muted, assignment, people, onSelect, onEdit, onArchive, onRestore, onDelete, onDragStart, onDragOver, onDrop, reorder, isOrderTarget }: {
  task: Task; selected: boolean; muted: boolean; assignment?: Assignment; people: Person[];
  onSelect: () => void; onEdit: () => void; onArchive: (outcome?: TerminalOutcome) => void; onRestore: () => void;
  onDelete: () => void; onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void; onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  reorder?: { up?: () => void; down?: () => void; first?: () => void; last?: () => void };
  isOrderTarget?: boolean;
}) {
  const assigneeCount = people.length;
  return (
    <div
      className={`task-card ${assignment ? "task-card--compact" : ""} ${selected ? "is-selected" : ""} ${muted ? "is-muted" : ""} ${isOrderTarget ? "is-order-target" : ""}`}
      style={{ "--task-color": task.color } as React.CSSProperties}
      role="button" tabIndex={0} aria-pressed={selected} draggable={Boolean(reorder) || task.workflow.state !== "archived"}
      onDragStart={onDragStart}
      onDragOver={onDragOver} onDrop={onDrop}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
      onKeyDown={(event) => {
        if (event.altKey && event.key === "ArrowUp" && reorder?.up) { event.preventDefault(); reorder.up(); }
        else if (event.altKey && event.key === "ArrowDown" && reorder?.down) { event.preventDefault(); reorder.down(); }
        else if (event.altKey && event.key === "Home" && reorder?.first) { event.preventDefault(); reorder.first(); }
        else if (event.altKey && event.key === "End" && reorder?.last) { event.preventDefault(); reorder.last(); }
        else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); }
      }}
    >
      <span className="task-accent" aria-hidden="true" />
      <div className="task-card-content">
        <div className="task-card-topline">
          <span className="task-category">{task.category}</span>
          {task.workflow.state === "archived" && <span className="status-chip">{task.workflow.outcome ? task.workflow.outcome[0].toUpperCase() + task.workflow.outcome.slice(1) : "Archived"}</span>}
        </div>
        <div className="task-title-row"><GripVertical className="drag-handle" aria-hidden="true" /><strong>{task.title}</strong></div>
        {!assignment && task.description && <p>{task.description}</p>}
        {!assignment && (
          <div className="task-card-footer">
            <span>{assigneeCount ? `${assigneeCount} ${assigneeCount === 1 ? "person" : "people"}` : "Unassigned"}</span>
            <TaskMenu task={task} onEdit={onEdit} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete}
              onMoveUp={reorder?.up} onMoveDown={reorder?.down} onMoveFirst={reorder?.first} onMoveLast={reorder?.last} />
          </div>
        )}
      </div>
      {assignment && <TaskMenu task={task} onEdit={onEdit} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />}
    </div>
  );
}

function EditorDialog({ editor, tasks, people, onClose, onSubmit }: {
  editor: Exclude<EditorState, null>; tasks: Task[]; people: Person[]; onClose: () => void;
  onSubmit: (action: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const existing = editor?.kind === "task" ? tasks.find((item) => item.id === editor.id) : people.find((item) => item.id === editor?.id);
  const isTask = editor.kind === "task";
  const task = isTask ? existing as Task | undefined : undefined;
  const person = !isTask ? existing as Person | undefined : undefined;
  const [title, setTitle] = useState(task?.title || person?.name || "");
  const [description, setDescription] = useState(task?.description || "");
  const [secondary, setSecondary] = useState(task?.category || person?.role || "");
  // Empty on create delegates deterministic automatic selection to BoardService.
  const [color, setColor] = useState(task?.color || person?.color || "");
  const [colorId, setColorId] = useState(task?.colorId || person?.colorId || "");
  const [submitting, setSubmitting] = useState(false);
  const editing = Boolean(editor.id);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={async (event) => {
          event.preventDefault(); if (!title.trim()) return; setSubmitting(true);
          try {
            await onSubmit(`${editing ? "update" : "add"}${isTask ? "Task" : "Person"}`,
              isTask ? { id: editor.id, title, description, category: secondary, ...(color ? { color, colorId: colorId || undefined } : {}) }
                : { id: editor.id, name: title, role: secondary, ...(color ? { color, colorId: colorId || undefined } : {}) });
            onClose();
          } finally { setSubmitting(false); }
        }}>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit" : "Add"} {isTask ? "task" : "person"}</DialogTitle>
            <DialogDescription>{isTask ? "Keep the task recognizable at a glance on the board." : "Add the person as a row in the focus grid."}</DialogDescription>
          </DialogHeader>
          <div className="form-grid">
            <div className="form-field">
              <Label htmlFor="editor-title">{isTask ? "Task title" : "Name"}</Label>
              <Input id="editor-title" value={title} onChange={(event) => setTitle(event.target.value)} autoFocus required />
            </div>
            <div className="form-field">
              <Label htmlFor="editor-secondary">{isTask ? "Workstream" : "Role or specialty"}</Label>
              <Input id="editor-secondary" value={secondary} onChange={(event) => setSecondary(event.target.value)}
                placeholder={isTask ? "Reliability" : "Platform engineering"} />
            </div>
            {isTask && (
              <div className="form-field">
                <Label htmlFor="editor-description">Notes</Label>
                <Textarea id="editor-description" value={description} onChange={(event) => setDescription(event.target.value)}
                  placeholder="What outcome should this work produce?" />
              </div>
            )}
            <fieldset className="form-field color-field">
              <legend>Color</legend>
              <div className="color-options">
                {(isTask ? TASK_PALETTE : PEOPLE_PALETTE).map((option) => (
                  <button type="button" key={option.id} className={`color-option ${color === option.value ? "is-selected" : ""}`}
                    style={{ background: option.value, color: option.foreground }} aria-label={`Choose ${option.label}`} title={option.label} aria-pressed={color === option.value}
                    onClick={() => { setColor(option.value); setColorId(option.id); }}>{color === option.value && <Check />}</button>
                ))}
              </div>
              {!editing && !color && <p className="form-help">A distinct accessible color will be assigned automatically.</p>}
            </fieldset>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!title.trim() || submitting}>
              {submitting ? "Saving…" : editing ? "Save changes" : `Add ${isTask ? "task" : "person"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const shortcuts = [["N", "New task"], ["Shift + N", "Add a person"], ["/", "Search tasks"],
    ["A", "Archive selected task"], ["C", "Complete selected task"], ["R", "Restore selected task"], ["Esc", "Clear selection"], ["?", "Show this guide"]];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="shortcut-dialog">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle><DialogDescription>Shortcuts stay out of the way while you are typing in a field.</DialogDescription></DialogHeader>
        <div className="shortcut-list">{shortcuts.map(([keys, label]) => <div key={keys}><span>{label}</span><kbd>{keys}</kbd></div>)}</div>
      </DialogContent>
    </Dialog>
  );
}

export default function Home() {
  const [board, setBoard] = useState<BoardState | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<WorkflowState>("unfocused");
  const [search, setSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteState, setDeleteState] = useState<DeleteState>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dragging, setDragging] = useState<{ taskId: string; personId?: string } | null>(null);
  const [dropTarget, setDropTarget] = useState("");
  const [draggingPersonId, setDraggingPersonId] = useState<string | null>(null);
  const [draggingTaskOrderId, setDraggingTaskOrderId] = useState<string | null>(null);
  const [taskOrderDropId, setTaskOrderDropId] = useState<string | null>(null);
  const [personDropTarget, setPersonDropTarget] = useState<{ personId: string; edge: "before" | "after" } | null>(null);
  const [orderAnnouncement, setOrderAnnouncement] = useState("");
  const [loadFilter, setLoadFilter] = useState<"all" | LoadState>("all");
  const [loadSort, setLoadSort] = useState<"canonical" | "highest" | "lowest">("canonical");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { requestState().then(setBoard).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load the board.")); }, []);
  const tasks = useMemo(() => board?.tasks || [], [board]);
  const people = useMemo(() => board?.people || [], [board]);
  const displayedPeople = useMemo(() => {
    const filtered = loadFilter === "all" ? people : people.filter((person) => person.load.state === loadFilter);
    if (loadSort === "canonical") return filtered;
    return [...filtered].sort((left, right) => loadSort === "highest" ? right.load.score - left.load.score : left.load.score - right.load.score);
  }, [people, loadFilter, loadSort]);
  const assignments = useMemo(() => board?.assignments || [], [board]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const selectedTask = selectedTaskId ? taskById.get(selectedTaskId) : undefined;

  const runAction = useCallback(async (action: string, payload: Record<string, unknown>, successMessage?: string) => {
    setSaving(true);
    try {
      const next = await requestState(action, payload); setBoard(next);
      if (successMessage) toast.success(successMessage);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "That change could not be saved."); throw cause;
    } finally { setSaving(false); }
  }, []);
  const archiveTask = useCallback(async (task: Task, outcome?: TerminalOutcome) => {
    await runAction("archiveTask", { id: task.id, outcome, expectedRevision: task.revision }, outcome === "completed" ? "Task completed" : "Task archived");
    setSelectedTaskId(null);
  }, [runAction]);
  const restoreTask = useCallback(async (task: Task) => {
    await runAction("restoreTask", { id: task.id, expectedRevision: task.revision }, "Task restored");
  }, [runAction]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) { if (event.key === "Escape") target.blur(); return; }
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      else if (event.key.toLowerCase() === "n") { event.preventDefault(); setEditor(event.shiftKey ? { kind: "person" } : { kind: "task" }); }
      else if (event.key === "?") { event.preventDefault(); setShortcutsOpen(true); }
      else if (event.key === "Escape") setSelectedTaskId(null);
      else if (event.key.toLowerCase() === "a" && selectedTask && selectedTask.workflow.state !== "archived") void archiveTask(selectedTask);
      else if (event.key.toLowerCase() === "c" && selectedTask && selectedTask.workflow.state !== "archived") void archiveTask(selectedTask, "completed");
      else if (event.key.toLowerCase() === "r" && selectedTask && selectedTask.workflow.state === "archived") void restoreTask(selectedTask);
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [selectedTask, archiveTask, restoreTask]);

  const visibleTasks = tasks.filter((task) => {
    const query = search.trim().toLowerCase();
    return task.workflow.state === statusFilter && (!query || `${task.title} ${task.category} ${task.description}`.toLowerCase().includes(query));
  });
  const assignmentPeople = (taskId: string) => {
    const ids = assignments.filter((item) => item.taskId === taskId).map((item) => item.personId);
    return people.filter((person) => ids.includes(person.id));
  };
  const selectedAssignments = selectedTaskId ? assignments.filter((item) => item.taskId === selectedTaskId) : [];
  const selectedPrimary = people.find((person) => selectedAssignments.some((item) => item.personId === person.id && item.focus === "primary"));
  const selectedContributors = selectedAssignments.filter((item) => item.focus !== "primary").length;
  const startDrag = (taskId: string, personId?: string) => (event: React.DragEvent<HTMLDivElement>) => {
    const data = { taskId, personId }; setDragging(data); event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/json", JSON.stringify(data)); event.dataTransfer.setData("text/plain", taskId);
  };
  const assign = async (taskId: string, personId: string, focus: Focus) => {
    const prior = assignments.find((item) => item.taskId === taskId && item.personId === personId);
    await runAction("assign", { taskId, personId, focus }, prior ? `Moved to ${focus} focus` : `Added as ${focus} focus`);
  };
  const reorderPerson = async (person: Person, target: { beforePersonId?: string; afterPersonId?: string; position?: "first" | "last" }) => {
    await runAction("reorderPeople", { personId: person.id, ...target, expectedRevision: board?.revision });
    const nextPeople = target.position === "first" ? [person, ...people.filter((item) => item.id !== person.id)]
      : target.position === "last" ? [...people.filter((item) => item.id !== person.id), person]
      : people;
    const position = target.position ? nextPeople.findIndex((item) => item.id === person.id) + 1
      : target.beforePersonId ? people.filter((item) => item.id !== person.id).findIndex((item) => item.id === target.beforePersonId) + 1
      : people.filter((item) => item.id !== person.id).findIndex((item) => item.id === target.afterPersonId) + 2;
    setOrderAnnouncement(`${person.name} moved to position ${position} of ${people.length}.`);
  };
  const reorderTask = async (task: Task, target: { beforeTaskId?: string; afterTaskId?: string; position?: "first" | "last" }) => {
    if (search.trim()) { toast.info("Clear search before reordering tasks."); return; }
    await runAction("reorderTasks", { taskId: task.id, state: task.workflow.state, ...target, expectedRevision: board?.revision });
    const stateTasks = tasks.filter((item) => item.workflow.state === task.workflow.state);
    const remaining = stateTasks.filter((item) => item.id !== task.id);
    const position = target.position === "first" ? 1 : target.position === "last" ? stateTasks.length
      : target.beforeTaskId ? remaining.findIndex((item) => item.id === target.beforeTaskId) + 1
      : remaining.findIndex((item) => item.id === target.afterTaskId) + 2;
    setOrderAnnouncement(`${task.title} moved to position ${position} of ${stateTasks.length} in ${task.workflow.state}.`);
  };

  if (error) return (
    <main className="connection-screen"><div className="connection-card"><span className="connection-mark">WG</span>
      <h1>Local storage is unavailable</h1><p>The board could not connect to its local database. Try again in a moment.</p>
      <Button onClick={() => window.location.reload()}>Try again</Button></div></main>
  );
  if (!board) return <main className="loading-screen"><div className="loading-mark">WG</div><p>Opening your work grid…</p></main>;

  return (
    <TooltipProvider>
      <main className="app-shell">
        <header className="topbar">
          <div className="brand-lockup"><div className="brand-mark">WG</div><div><h1>Work distribution</h1><p>Current team focus</p></div></div>
          <div className="topbar-actions">
            <div className="save-state" aria-live="polite"><span className={saving ? "is-saving" : ""} />{saving ? "Saving…" : "Saved locally"}</div>
            <Tooltip><TooltipTrigger asChild><Button variant="outline" size="icon" onClick={() => setShortcutsOpen(true)} aria-label="Keyboard shortcuts"><Keyboard /></Button></TooltipTrigger><TooltipContent>Keyboard shortcuts</TooltipContent></Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline">Board <ChevronDown /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuLabel>Board tools</DropdownMenuLabel>
                <DropdownMenuItem asChild><a href="/api/board?export=1" download><Download /> Export JSON</a></DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}><Keyboard /> Keyboard shortcuts <DropdownMenuShortcut>?</DropdownMenuShortcut></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <section className="workspace">
          <aside className="task-rail">
            <div className="rail-heading"><div><span className="eyebrow">Work inventory</span><h2>Tasks</h2></div>
              <Tooltip><TooltipTrigger asChild><Button size="icon-sm" onClick={() => setEditor({ kind: "task" })} aria-label="Add task"><Plus /></Button></TooltipTrigger><TooltipContent>Add task · N</TooltipContent></Tooltip>
            </div>
            <div className="search-box"><Search /><Input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
              {search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X /></button>}<kbd>/</kbd></div>
            <Tabs value={statusFilter} onValueChange={(value) => setStatusFilter(value as WorkflowState)}><TabsList className="status-tabs">
              <TabsTrigger value="unfocused">Unfocused <span>{tasks.filter((task) => task.workflow.state === "unfocused").length}</span></TabsTrigger>
              <TabsTrigger value="focused">Focused <span>{tasks.filter((task) => task.workflow.state === "focused").length}</span></TabsTrigger>
              <TabsTrigger value="archived">Archived <span>{tasks.filter((task) => task.workflow.state === "archived").length}</span></TabsTrigger>
            </TabsList></Tabs>
            <div className={`task-list ${dragging?.personId ? "is-drop-ready" : ""}`}
              onDragOver={(event) => { if (!dragging?.personId) return; event.preventDefault(); setDropTarget("task-pool"); }} onDragLeave={() => setDropTarget("")}
              onDrop={async (event) => { event.preventDefault(); const data = JSON.parse(event.dataTransfer.getData("application/json") || "{}") as { taskId?: string; personId?: string };
                setDropTarget(""); setDragging(null); if (data.taskId && data.personId) await runAction("unassign", { taskId: data.taskId, personId: data.personId }, "Assignment removed"); }}>
              {dragging?.personId && dropTarget === "task-pool" && <div className="pool-drop-message">Drop to remove this assignment</div>}
              {visibleTasks.map((task, taskIndex) => <TaskCard key={task.id} task={task} people={assignmentPeople(task.id)} selected={selectedTaskId === task.id}
                muted={Boolean(selectedTaskId && selectedTaskId !== task.id)} onSelect={() => setSelectedTaskId((current) => current === task.id ? null : task.id)}
                onEdit={() => setEditor({ kind: "task", id: task.id })} onArchive={(outcome) => void archiveTask(task, outcome)} onRestore={() => void restoreTask(task)}
                onDelete={() => setDeleteState({ kind: "task", id: task.id, name: task.title })}
                onDragStart={(event) => { if (search.trim()) { event.preventDefault(); return; } setDraggingTaskOrderId(task.id); setDragging({ taskId: task.id }); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-workgrid-task-order", task.id); event.dataTransfer.setData("application/json", JSON.stringify({ taskId: task.id })); }}
                isOrderTarget={taskOrderDropId === task.id}
                onDragOver={(event) => { if (!draggingTaskOrderId || draggingTaskOrderId === task.id) return; event.preventDefault(); setTaskOrderDropId(task.id); }}
                onDrop={(event) => { if (!draggingTaskOrderId || draggingTaskOrderId === task.id) return; event.preventDefault(); const moving = tasks.find((item) => item.id === draggingTaskOrderId); setDraggingTaskOrderId(null); setTaskOrderDropId(null); if (moving) void reorderTask(moving, { beforeTaskId: task.id }); }}
                reorder={search.trim() ? undefined : {
                  up: taskIndex > 0 ? () => void reorderTask(task, { beforeTaskId: visibleTasks[taskIndex - 1].id }) : undefined,
                  down: taskIndex < visibleTasks.length - 1 ? () => void reorderTask(task, { afterTaskId: visibleTasks[taskIndex + 1].id }) : undefined,
                  first: taskIndex > 0 ? () => void reorderTask(task, { position: "first" }) : undefined,
                  last: taskIndex < visibleTasks.length - 1 ? () => void reorderTask(task, { position: "last" }) : undefined,
                }} />)}
              {!visibleTasks.length && <div className="empty-list"><span>{search ? "No match" : `No ${statusFilter} tasks`}</span><p>{search ? "Try a different task or workstream." : statusFilter === "archived" ? "Completed and archived work remains searchable here." : "Tasks move here automatically when their primary owner changes."}</p></div>}
            </div>
            <div className="rail-footer"><div><span className="storage-dot" /> Local workspace storage</div><span>This device</span></div>
          </aside>

          <section className="board-area">
            <div className="board-toolbar"><div><span className="eyebrow">Allocation board</span><h2>Team focus</h2></div>
              <div className="board-actions"><div className="team-count"><Users /> {displayedPeople.length}{displayedPeople.length !== people.length ? ` of ${people.length}` : ""} people</div>
                <Label className="sr-only" htmlFor="load-filter">Filter people by load</Label><select id="load-filter" className="load-view-select" value={loadFilter} onChange={(event) => setLoadFilter(event.target.value as "all" | LoadState)}>
                  <option value="all">All loads</option><option value="low">Low load</option><option value="balanced">Balanced</option><option value="overloaded">Overloaded</option>
                </select>
                <Label className="sr-only" htmlFor="load-sort">Sort people by load</Label><select id="load-sort" className="load-view-select" value={loadSort} onChange={(event) => setLoadSort(event.target.value as "canonical" | "highest" | "lowest")}>
                  <option value="canonical">Team order</option><option value="highest">Highest load</option><option value="lowest">Lowest load</option>
                </select><Button variant="outline" onClick={() => setEditor({ kind: "person" })}><UserPlus /> Add person</Button></div>
            </div>
            {selectedTask ? (
              <div className="selection-summary" style={{ "--task-color": selectedTask.color } as React.CSSProperties}><span className="selection-swatch" />
                <div><span>Showing distribution for</span><strong>{selectedTask.title}</strong></div>
                <div className="selection-facts"><span><b>{selectedPrimary?.name || "No owner"}</b> primary</span><span><b>{selectedContributors}</b> {selectedContributors === 1 ? "contributor" : "contributors"}</span></div>
                <Button variant="ghost" size="icon-sm" onClick={() => setSelectedTaskId(null)} aria-label="Clear task selection"><X /></Button></div>
            ) : <div className="board-hint"><span>Drag a task into the grid, or select one and click a focus cell.</span><button type="button" onClick={() => setShortcutsOpen(true)}>View shortcuts</button></div>}

            <div className="grid-scroll"><div className="focus-grid">
              <p className="sr-only" aria-live="polite" aria-atomic="true">{orderAnnouncement}</p>
              <div className="grid-corner">Team member</div>
              {focusLevels.map((focus) => <div className={`grid-column-heading focus-${focus.id}`} key={focus.id}><span>{focus.label}</span><small>{focus.helper}</small></div>)}
              {displayedPeople.map((person) => { const personIndex = people.findIndex((item) => item.id === person.id); return <div className={`grid-row load-${person.load.state} ${personDropTarget?.personId === person.id ? `person-drop-${personDropTarget.edge}` : ""}`} key={person.id}
                onDragOver={(event) => { if (!draggingPersonId || draggingPersonId === person.id) return; event.preventDefault(); event.dataTransfer.dropEffect = "move";
                  const bounds = event.currentTarget.getBoundingClientRect(); setPersonDropTarget({ personId: person.id, edge: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" }); }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPersonDropTarget(null); }}
                onDrop={(event) => { if (!draggingPersonId || !personDropTarget) return; event.preventDefault(); const moving = people.find((item) => item.id === draggingPersonId);
                  setDraggingPersonId(null); setPersonDropTarget(null); if (moving) void reorderPerson(moving, personDropTarget.edge === "before" ? { beforePersonId: person.id } : { afterPersonId: person.id }); }}>
                <div className="person-cell">
                  <button type="button" className="person-drag-handle" draggable aria-label={`Reorder ${person.name}. Use Alt plus arrow keys, Home, or End.`}
                    onDragStart={(event) => { event.stopPropagation(); setDraggingPersonId(person.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", person.id); }}
                    onDragEnd={() => { setDraggingPersonId(null); setPersonDropTarget(null); }}
                    onKeyDown={(event) => { if (!event.altKey) return; const key = event.key;
                      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(key)) return; event.preventDefault();
                      if (key === "Home" && personIndex > 0) void reorderPerson(person, { position: "first" });
                      else if (key === "End" && personIndex < people.length - 1) void reorderPerson(person, { position: "last" });
                      else if (key === "ArrowUp" && personIndex > 0) void reorderPerson(person, { beforePersonId: people[personIndex - 1].id });
                      else if (key === "ArrowDown" && personIndex < people.length - 1) void reorderPerson(person, { afterPersonId: people[personIndex + 1].id }); }}>
                    <GripVertical aria-hidden="true" />
                  </button>
                  <div className="avatar" style={{ background: person.color }}>{initials(person.name)}</div>
                  <div className="person-copy"><strong>{person.name}</strong><span>{person.role || "Team member"}</span>
                    <span className={`load-indicator load-indicator--${person.load.state}`} title={`${person.load.counts.primary} primary, ${person.load.counts.secondary} secondary, ${person.load.counts.tertiary} tertiary`}>
                      <i aria-hidden="true" />{person.load.state === "low" ? "Low load" : person.load.state === "overloaded" ? "Overloaded" : "Balanced"} · {person.load.score}
                    </span></div>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Actions for ${person.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end"><DropdownMenuItem disabled={personIndex === 0} onSelect={() => void reorderPerson(person, { beforePersonId: people[personIndex - 1].id })}><ArrowUp /> Move up</DropdownMenuItem>
                      <DropdownMenuItem disabled={personIndex === people.length - 1} onSelect={() => void reorderPerson(person, { afterPersonId: people[personIndex + 1].id })}><ArrowDown /> Move down</DropdownMenuItem>
                      <DropdownMenuItem disabled={personIndex === 0} onSelect={() => void reorderPerson(person, { position: "first" })}>Move to top</DropdownMenuItem>
                      <DropdownMenuItem disabled={personIndex === people.length - 1} onSelect={() => void reorderPerson(person, { position: "last" })}>Move to bottom</DropdownMenuItem>
                      <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setEditor({ kind: "person", id: person.id })}><Pencil /> Edit</DropdownMenuItem><DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteState({ kind: "person", id: person.id, name: person.name })}><Trash2 /> Remove</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {focusLevels.map((focus) => {
                  const cellAssignments = assignments.filter((item) => item.personId === person.id && item.focus === focus.id);
                  const targetKey = `${person.id}:${focus.id}`;
                  return <div className={`focus-cell focus-${focus.id} ${dropTarget === targetKey ? "is-over" : ""} ${selectedTask ? "has-selected-task" : ""}`} key={focus.id}
                    onClick={() => selectedTask && selectedTask.workflow.state !== "archived" && void assign(selectedTask.id, person.id, focus.id)}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(targetKey); }}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(""); }}
                    onDrop={async (event) => { event.preventDefault(); const data = JSON.parse(event.dataTransfer.getData("application/json") || "{}") as { taskId?: string };
                      setDropTarget(""); setDragging(null); if (data.taskId) await assign(data.taskId, person.id, focus.id); }}>
                    <div className="cell-stack">{cellAssignments.map((assignment) => {
                      const task = taskById.get(assignment.taskId); if (!task || task.workflow.state === "archived") return null;
                      return <TaskCard key={assignment.id} task={task} assignment={assignment} people={assignmentPeople(task.id)} selected={selectedTaskId === task.id}
                        muted={Boolean(selectedTaskId && selectedTaskId !== task.id)} onSelect={() => setSelectedTaskId((current) => current === task.id ? null : task.id)}
                        onEdit={() => setEditor({ kind: "task", id: task.id })} onArchive={(outcome) => void archiveTask(task, outcome)} onRestore={() => void restoreTask(task)}
                        onDelete={() => setDeleteState({ kind: "task", id: task.id, name: task.title })} onDragStart={startDrag(task.id, person.id)} />;
                    })}</div>
                    {!cellAssignments.some((item) => taskById.get(item.taskId)?.workflow.state !== "archived") && <div className="empty-cell"><Plus /><span>{selectedTask ? `Assign ${selectedTask.title}` : "Drop task"}</span></div>}
                  </div>;
                })}
              </div>})}
            </div></div>
            {!people.length && <div className="empty-board"><div><Users /></div><h3>Add your first team member</h3><p>Each person becomes a row for primary, secondary, and tertiary work.</p><Button onClick={() => setEditor({ kind: "person" })}><UserPlus /> Add person</Button></div>}
            <footer className="board-footer"><span>One primary owner per task. Secondary and tertiary contributors are unlimited.</span><span>Tip: click any task to reveal its distribution.</span></footer>
          </section>
        </section>

        {editor && <EditorDialog key={`${editor.kind}:${editor.id || "new"}`} editor={editor} tasks={tasks} people={people} onClose={() => setEditor(null)} onSubmit={runAction} />}
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <AlertDialog open={Boolean(deleteState)} onOpenChange={(open) => !open && setDeleteState(null)}><AlertDialogContent><AlertDialogHeader>
          <AlertDialogTitle>Delete {deleteState?.name}?</AlertDialogTitle><AlertDialogDescription>{deleteState?.kind === "person" ? "This removes the person and all of their assignments. Tasks remain available." : "This permanently removes the task and every assignment. Consider archiving it instead."}</AlertDialogDescription>
        </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={async () => {
          if (!deleteState) return; await runAction(deleteState.kind === "task" ? "deleteTask" : "deletePerson", { id: deleteState.id }, `${deleteState.kind === "task" ? "Task" : "Person"} deleted`);
          if (deleteState.id === selectedTaskId) setSelectedTaskId(null); setDeleteState(null);
        }}>Delete permanently</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        <Toaster position="bottom-right" richColors />
      </main>
    </TooltipProvider>
  );
}
