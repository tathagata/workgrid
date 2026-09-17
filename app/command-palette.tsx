"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import {
  COMMAND_REGISTRY, effectiveBindings, eventBinding, exportBindings, isTypingTarget, loadBindings,
  parseBindingConfiguration, saveBindings, type BindingMap, type CommandContext, type CommandDefinition,
} from "@/lib/commands";

const SEQUENCE_TIMEOUT_MS = 900;
const MODIFIER_LABELS: Record<string, string> = { mod: isMac() ? "⌘" : "Ctrl", alt: isMac() ? "⌥" : "Alt", shift: "Shift" };
const KEY_LABELS: Record<string, string> = { arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", escape: "Esc", backspace: "⌫" };

function isMac() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function formatBindingSteps(binding: string): string[][] {
  return binding.split(" ").map((step) => step.split("+").map((part) => MODIFIER_LABELS[part] ?? KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))));
}

function BindingKeys({ binding }: { binding: string }) {
  const steps = formatBindingSteps(binding);
  // One chip per chord (e.g. "⌘⌥↑" or "Ctrl+Alt+Up"), not one chip per key — three bordered boxes for a
  // single shortcut reads as three separate shortcuts and makes a list of ~25 of them look far busier than it is.
  // A genuine multi-key sequence (press "g", then "u") still gets a separate chip per step, joined by "then".
  const chordSeparator = isMac() ? "" : "+";
  return (
    <KbdGroup>
      {steps.map((step, stepIndex) => (
        <span key={stepIndex} className="binding-step">
          {stepIndex > 0 && <span className="binding-then" aria-hidden="true">then</span>}
          <Kbd>{step.join(chordSeparator)}</Kbd>
        </span>
      ))}
    </KbdGroup>
  );
}

function groupCommands(commands: readonly CommandDefinition[]) {
  const byGroup = new Map<string, CommandDefinition[]>();
  for (const command of commands) {
    if (!byGroup.has(command.group)) byGroup.set(command.group, []);
    byGroup.get(command.group)!.push(command);
  }
  return [...byGroup];
}

/** Loads/persists bindings per browser only; never sent to the application service. */
export function useCommandBindings() {
  const [bindings, setBindings] = useState<BindingMap>(() => loadBindings());
  const updateBindings = (next: BindingMap) => { setBindings(next); saveBindings(next); };
  return { bindings, updateBindings, resetBindings: () => updateBindings({}) };
}

/** Dispatches registry commands from real key events. Never runs while typing, composing, or using assistive controls. Supports two-key sequences (e.g. "g u") with a short cancelable timeout. */
export function useCommandDispatch(context: CommandContext, bindings: BindingMap, run: (command: CommandDefinition) => void) {
  const pendingRef = useRef<{ prefix: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  useEffect(() => {
    const clearPending = () => { if (pendingRef.current) { clearTimeout(pendingRef.current.timer); pendingRef.current = null; } };
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (isTypingTarget(target)) { if (event.key === "Escape") target?.blur(); return; }
      const key = eventBinding(event);
      const pending = pendingRef.current;
      const candidate = pending ? `${pending.prefix} ${key}` : key;
      const match = COMMAND_REGISTRY.find((command) => effectiveBindings(bindings, command).includes(candidate));
      if (match) {
        clearPending();
        event.preventDefault();
        const availability = match.available(context);
        if (availability.enabled) run(match);
        else if (availability.reason) toast.info(availability.reason);
        return;
      }
      if (pending) { clearPending(); return; }
      const startsSequence = COMMAND_REGISTRY.some((command) => effectiveBindings(bindings, command).some((binding) => binding.startsWith(`${key} `)));
      if (startsSequence) { event.preventDefault(); pendingRef.current = { prefix: key, timer: setTimeout(clearPending, SEQUENCE_TIMEOUT_MS) }; }
    };
    window.addEventListener("keydown", listener);
    return () => { window.removeEventListener("keydown", listener); clearPending(); };
  }, [context, bindings, run]);
}

export function CommandPalette({ open, onOpenChange, context, bindings, onRun }: {
  open: boolean; onOpenChange: (open: boolean) => void; context: CommandContext; bindings: BindingMap; onRun: (command: CommandDefinition) => void;
}) {
  const groups = useMemo(() => groupCommands(COMMAND_REGISTRY.filter((command) => command.id !== "palette.open")), []);
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Search commands by name or action.">
      <CommandInput placeholder="Type a command…" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {groups.map(([group, commands]) => (
          <CommandGroup key={group} heading={group}>
            {commands.map((command) => {
              const availability = command.available(context);
              const [primaryBinding] = effectiveBindings(bindings, command);
              return (
                <CommandItem key={command.id} value={`${command.label} ${command.help} ${command.id}`} disabled={!availability.enabled}
                  onSelect={() => { if (!availability.enabled) return; onOpenChange(false); onRun(command); }}>
                  <div className="palette-item-copy">
                    <span>{command.label}</span>
                    {!availability.enabled && availability.reason && <small>{availability.reason}</small>}
                  </div>
                  {primaryBinding && <CommandShortcut><BindingKeys binding={primaryBinding} /></CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}

export function ShortcutsDialog({ open, onOpenChange, bindings, onResetBindings, onImportBindings }: {
  open: boolean; onOpenChange: (open: boolean) => void; bindings: BindingMap;
  onResetBindings: () => void; onImportBindings: (bindings: BindingMap) => void;
}) {
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const groups = useMemo(() => groupCommands(COMMAND_REGISTRY), []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="shortcut-dialog">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Generated from the live command registry, so this list cannot drift from what a shortcut actually does. Shortcuts stay out of the way while typing in a field.
            macOS shows ⌘/⌥; Windows and Linux show Ctrl/Alt. On some browsers, Ctrl+1–3 and Ctrl+0 may be intercepted for tab switching — use the command palette as a reliable alternative.
          </DialogDescription>
        </DialogHeader>
        <div className="shortcut-groups">
          {groups.map(([group, commands]) => {
            const bound = commands.filter((command) => effectiveBindings(bindings, command).length);
            if (!bound.length) return null;
            return (
              <section key={group}>
                <h3>{group}</h3>
                <div className="shortcut-list">
                  {bound.map((command) => (
                    <div key={command.id}>
                      <span>{command.label}</span>
                      <KbdGroup>{effectiveBindings(bindings, command).map((binding) => <BindingKeys key={binding} binding={binding} />)}</KbdGroup>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <details className="binding-settings">
          <summary>Customize bindings</summary>
          <p className="form-help">Export, edit, and re-import bindings as JSON. Import validates every command ID and rejects unknown IDs, conflicts, and malformed configuration; bindings are stored only in this browser.</p>
          <div className="binding-settings-actions">
            <Button type="button" variant="outline" size="sm" onClick={() => { setImportText(exportBindings(bindings)); setImportError(""); }}>Export current bindings</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => { onResetBindings(); setImportText(""); setImportError(""); }}>Reset to defaults</Button>
          </div>
          <Textarea value={importText} onChange={(event) => { setImportText(event.target.value); setImportError(""); }} placeholder='{"task.create": ["n"]}' rows={6} aria-label="Keyboard binding configuration (JSON)" />
          <div className="binding-settings-actions">
            <Button type="button" size="sm" onClick={() => {
              try {
                const parsed = parseBindingConfiguration(importText.trim() ? JSON.parse(importText) : {});
                onImportBindings(parsed);
                setImportError("");
              } catch (cause) { setImportError(cause instanceof Error ? cause.message : "Invalid binding configuration."); }
            }}>Apply bindings</Button>
          </div>
          {importError && <p className="form-error" role="alert">{importError}</p>}
        </details>
      </DialogContent>
    </Dialog>
  );
}
