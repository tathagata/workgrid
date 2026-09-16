"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive, Check, ChevronDown, CirclePause, CirclePlay, Download, GripVertical,
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

type Focus = "primary" | "secondary" | "tertiary";
type TaskStatus = "active" | "hold" | "archived";
type Person = { id: string; name: string; role: string; color: string; sortOrder: number };
type Task = {
  id: string; title: string; description: string; category: string; color: string;
  status: TaskStatus; createdAt: string; updatedAt: string;
};
type Assignment = { id: string; taskId: string; personId: string; focus: Focus; createdAt: string };
type BoardState = { people: Person[]; tasks: Task[]; assignments: Assignment[]; savedAt: string };
type EditorState = { kind: "task"; id?: string } | { kind: "person"; id?: string } | null;
type DeleteState = { kind: "task" | "person"; id: string; name: string } | null;

const focusLevels: { id: Focus; label: string; helper: string }[] = [
  { id: "primary", label: "Primary", helper: "Accountable owner" },
  { id: "secondary", label: "Secondary", helper: "Active contributor" },
  { id: "tertiary", label: "Tertiary", helper: "Consulted or backup" },
];
const palette = ["#2f6f65", "#5b67a5", "#8b5d33", "#96585b", "#6d6a55", "#695488"];

async function requestState(action?: string, payload?: Record<string, unknown>) {
  const response = await fetch("/api/board", {
    method: action ? "POST" : "GET",
    headers: action ? { "content-type": "application/json" } : undefined,
    body: action ? JSON.stringify({ action, payload }) : undefined,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "The local data service did not respond.");
  return body as BoardState;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function TaskMenu({ task, onEdit, onStatus, onDelete }: {
  task: Task; onEdit: () => void; onStatus: (status: TaskStatus) => void; onDelete: () => void;
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
        <DropdownMenuItem onSelect={onEdit}><Pencil /> Edit</DropdownMenuItem>
        {task.status === "hold" ? (
          <DropdownMenuItem onSelect={() => onStatus("active")}><CirclePlay /> Resume</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onStatus("hold")} disabled={task.status === "archived"}>
            <CirclePause /> Put on hold
          </DropdownMenuItem>
        )}
        {task.status === "archived" ? (
          <DropdownMenuItem onSelect={() => onStatus("active")}><CirclePlay /> Restore</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onStatus("archived")}><Archive /> Archive</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 /> Delete permanently</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskCard({ task, selected, muted, assignment, people, onSelect, onEdit, onStatus, onDelete, onDragStart }: {
  task: Task; selected: boolean; muted: boolean; assignment?: Assignment; people: Person[];
  onSelect: () => void; onEdit: () => void; onStatus: (status: TaskStatus) => void;
  onDelete: () => void; onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const assigneeCount = people.length;
  return (
    <div
      className={`task-card ${assignment ? "task-card--compact" : ""} ${selected ? "is-selected" : ""} ${muted ? "is-muted" : ""} ${task.status === "hold" ? "is-hold" : ""}`}
      style={{ "--task-color": task.color } as React.CSSProperties}
      role="button" tabIndex={0} aria-pressed={selected} draggable={task.status !== "archived"}
      onDragStart={onDragStart}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); }
      }}
    >
      <span className="task-accent" aria-hidden="true" />
      <div className="task-card-content">
        <div className="task-card-topline">
          <span className="task-category">{task.category}</span>
          {task.status === "hold" && <span className="status-chip">On hold</span>}
        </div>
        <div className="task-title-row"><GripVertical className="drag-handle" aria-hidden="true" /><strong>{task.title}</strong></div>
        {!assignment && task.description && <p>{task.description}</p>}
        {!assignment && (
          <div className="task-card-footer">
            <span>{assigneeCount ? `${assigneeCount} ${assigneeCount === 1 ? "person" : "people"}` : "Unassigned"}</span>
            <TaskMenu task={task} onEdit={onEdit} onStatus={onStatus} onDelete={onDelete} />
          </div>
        )}
      </div>
      {assignment && <TaskMenu task={task} onEdit={onEdit} onStatus={onStatus} onDelete={onDelete} />}
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
  const [color, setColor] = useState(task?.color || person?.color || (isTask ? palette[1] : palette[0]));
  const [submitting, setSubmitting] = useState(false);
  const editing = Boolean(editor.id);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={async (event) => {
          event.preventDefault(); if (!title.trim()) return; setSubmitting(true);
          try {
            await onSubmit(`${editing ? "update" : "add"}${isTask ? "Task" : "Person"}`,
              isTask ? { id: editor.id, title, description, category: secondary, color }
                : { id: editor.id, name: title, role: secondary, color });
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
                {palette.map((option) => (
                  <button type="button" key={option} className={`color-option ${color === option ? "is-selected" : ""}`}
                    style={{ background: option }} aria-label={`Choose color ${option}`} aria-pressed={color === option}
                    onClick={() => setColor(option)}>{color === option && <Check />}</button>
                ))}
              </div>
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
    ["H", "Hold or resume selected task"], ["A", "Archive selected task"], ["Esc", "Clear selection"], ["?", "Show this guide"]];
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
  const [statusFilter, setStatusFilter] = useState<TaskStatus>("active");
  const [search, setSearch] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteState, setDeleteState] = useState<DeleteState>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dragging, setDragging] = useState<{ taskId: string; personId?: string } | null>(null);
  const [dropTarget, setDropTarget] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { requestState().then(setBoard).catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load the board.")); }, []);
  const tasks = useMemo(() => board?.tasks || [], [board]);
  const people = useMemo(() => board?.people || [], [board]);
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
  const setTaskStatus = useCallback(async (task: Task, status: TaskStatus) => {
    await runAction("setTaskStatus", { id: task.id, status }, status === "hold" ? "Task put on hold" : status === "archived" ? "Task archived" : "Task restored");
    if (status === "archived") setSelectedTaskId(null);
  }, [runAction]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) { if (event.key === "Escape") target.blur(); return; }
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      else if (event.key.toLowerCase() === "n") { event.preventDefault(); setEditor(event.shiftKey ? { kind: "person" } : { kind: "task" }); }
      else if (event.key === "?") { event.preventDefault(); setShortcutsOpen(true); }
      else if (event.key === "Escape") setSelectedTaskId(null);
      else if (event.key.toLowerCase() === "h" && selectedTask) void setTaskStatus(selectedTask, selectedTask.status === "hold" ? "active" : "hold");
      else if (event.key.toLowerCase() === "a" && selectedTask) void setTaskStatus(selectedTask, "archived");
    };
    window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener);
  }, [selectedTask, setTaskStatus]);

  const visibleTasks = tasks.filter((task) => {
    const query = search.trim().toLowerCase();
    return task.status === statusFilter && (!query || `${task.title} ${task.category} ${task.description}`.toLowerCase().includes(query));
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
            <Tabs value={statusFilter} onValueChange={(value) => setStatusFilter(value as TaskStatus)}><TabsList className="status-tabs">
              <TabsTrigger value="active">Active <span>{tasks.filter((task) => task.status === "active").length}</span></TabsTrigger>
              <TabsTrigger value="hold">Hold <span>{tasks.filter((task) => task.status === "hold").length}</span></TabsTrigger>
              <TabsTrigger value="archived">Archive <span>{tasks.filter((task) => task.status === "archived").length}</span></TabsTrigger>
            </TabsList></Tabs>
            <div className={`task-list ${dragging?.personId ? "is-drop-ready" : ""}`}
              onDragOver={(event) => { if (!dragging?.personId) return; event.preventDefault(); setDropTarget("task-pool"); }} onDragLeave={() => setDropTarget("")}
              onDrop={async (event) => { event.preventDefault(); const data = JSON.parse(event.dataTransfer.getData("application/json") || "{}") as { taskId?: string; personId?: string };
                setDropTarget(""); setDragging(null); if (data.taskId && data.personId) await runAction("unassign", { taskId: data.taskId, personId: data.personId }, "Assignment removed"); }}>
              {dragging?.personId && dropTarget === "task-pool" && <div className="pool-drop-message">Drop to remove this assignment</div>}
              {visibleTasks.map((task) => <TaskCard key={task.id} task={task} people={assignmentPeople(task.id)} selected={selectedTaskId === task.id}
                muted={Boolean(selectedTaskId && selectedTaskId !== task.id)} onSelect={() => setSelectedTaskId((current) => current === task.id ? null : task.id)}
                onEdit={() => setEditor({ kind: "task", id: task.id })} onStatus={(status) => void setTaskStatus(task, status)}
                onDelete={() => setDeleteState({ kind: "task", id: task.id, name: task.title })} onDragStart={startDrag(task.id)} />)}
              {!visibleTasks.length && <div className="empty-list"><span>{search ? "No match" : statusFilter === "active" ? "No active tasks" : "Nothing here"}</span><p>{search ? "Try a different task or workstream." : "Your tasks will appear here."}</p></div>}
            </div>
            <div className="rail-footer"><div><span className="storage-dot" /> Local workspace storage</div><span>This device</span></div>
          </aside>

          <section className="board-area">
            <div className="board-toolbar"><div><span className="eyebrow">Allocation board</span><h2>Team focus</h2></div>
              <div className="board-actions"><div className="team-count"><Users /> {people.length} people</div><Button variant="outline" onClick={() => setEditor({ kind: "person" })}><UserPlus /> Add person</Button></div>
            </div>
            {selectedTask ? (
              <div className="selection-summary" style={{ "--task-color": selectedTask.color } as React.CSSProperties}><span className="selection-swatch" />
                <div><span>Showing distribution for</span><strong>{selectedTask.title}</strong></div>
                <div className="selection-facts"><span><b>{selectedPrimary?.name || "No owner"}</b> primary</span><span><b>{selectedContributors}</b> {selectedContributors === 1 ? "contributor" : "contributors"}</span></div>
                <Button variant="ghost" size="icon-sm" onClick={() => setSelectedTaskId(null)} aria-label="Clear task selection"><X /></Button></div>
            ) : <div className="board-hint"><span>Drag a task into the grid, or select one and click a focus cell.</span><button type="button" onClick={() => setShortcutsOpen(true)}>View shortcuts</button></div>}

            <div className="grid-scroll"><div className="focus-grid">
              <div className="grid-corner">Team member</div>
              {focusLevels.map((focus) => <div className={`grid-column-heading focus-${focus.id}`} key={focus.id}><span>{focus.label}</span><small>{focus.helper}</small></div>)}
              {people.map((person) => <div className="grid-row" key={person.id}>
                <div className="person-cell"><div className="avatar" style={{ background: person.color }}>{initials(person.name)}</div>
                  <div className="person-copy"><strong>{person.name}</strong><span>{person.role || "Team member"}</span></div>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" aria-label={`Actions for ${person.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setEditor({ kind: "person", id: person.id })}><Pencil /> Edit</DropdownMenuItem><DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteState({ kind: "person", id: person.id, name: person.name })}><Trash2 /> Remove</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {focusLevels.map((focus) => {
                  const cellAssignments = assignments.filter((item) => item.personId === person.id && item.focus === focus.id);
                  const targetKey = `${person.id}:${focus.id}`;
                  return <div className={`focus-cell focus-${focus.id} ${dropTarget === targetKey ? "is-over" : ""} ${selectedTask ? "has-selected-task" : ""}`} key={focus.id}
                    onClick={() => selectedTask && selectedTask.status !== "archived" && void assign(selectedTask.id, person.id, focus.id)}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(targetKey); }}
                    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(""); }}
                    onDrop={async (event) => { event.preventDefault(); const data = JSON.parse(event.dataTransfer.getData("application/json") || "{}") as { taskId?: string };
                      setDropTarget(""); setDragging(null); if (data.taskId) await assign(data.taskId, person.id, focus.id); }}>
                    <div className="cell-stack">{cellAssignments.map((assignment) => {
                      const task = taskById.get(assignment.taskId); if (!task || task.status === "archived") return null;
                      return <TaskCard key={assignment.id} task={task} assignment={assignment} people={assignmentPeople(task.id)} selected={selectedTaskId === task.id}
                        muted={Boolean(selectedTaskId && selectedTaskId !== task.id)} onSelect={() => setSelectedTaskId((current) => current === task.id ? null : task.id)}
                        onEdit={() => setEditor({ kind: "task", id: task.id })} onStatus={(status) => void setTaskStatus(task, status)}
                        onDelete={() => setDeleteState({ kind: "task", id: task.id, name: task.title })} onDragStart={startDrag(task.id, person.id)} />;
                    })}</div>
                    {!cellAssignments.some((item) => taskById.get(item.taskId)?.status !== "archived") && <div className="empty-cell"><Plus /><span>{selectedTask ? `Assign ${selectedTask.title}` : "Drop task"}</span></div>}
                  </div>;
                })}
              </div>)}
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
