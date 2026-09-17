export const PEOPLE_PALETTE_VERSION = 1 as const;

/**
 * Ordered, versioned palette used by every client. All foreground/background
 * pairs meet WCAG AA contrast for normal text (4.5:1 or greater).
 */
export const PEOPLE_PALETTE = [
  { id: "pine", value: "#2F6F65", label: "Pine", foreground: "#FFFFFF" },
  { id: "denim", value: "#5B67A5", label: "Denim", foreground: "#FFFFFF" },
  { id: "walnut", value: "#8B5D33", label: "Walnut", foreground: "#FFFFFF" },
  { id: "rosewood", value: "#96585B", label: "Rosewood", foreground: "#FFFFFF" },
  { id: "olive", value: "#6D6A55", label: "Olive", foreground: "#FFFFFF" },
  { id: "plum", value: "#695488", label: "Plum", foreground: "#FFFFFF" },
  { id: "navy", value: "#1E3A8A", label: "Navy", foreground: "#FFFFFF" },
  { id: "iris", value: "#5B21B6", label: "Iris", foreground: "#FFFFFF" },
  { id: "mulberry", value: "#9D174D", label: "Mulberry", foreground: "#FFFFFF" },
  { id: "cedar", value: "#9A3412", label: "Cedar", foreground: "#FFFFFF" },
  { id: "fern", value: "#3F6212", label: "Fern", foreground: "#FFFFFF" },
  { id: "harbor", value: "#155E75", label: "Harbor", foreground: "#FFFFFF" },
] as const;

export type PeoplePaletteId = (typeof PEOPLE_PALETTE)[number]["id"];
export type PersonColor = { colorId: PeoplePaletteId | null; color: string };

const byId = new Map<string, (typeof PEOPLE_PALETTE)[number]>(PEOPLE_PALETTE.map((item) => [item.id, item]));
const byValue = new Map<string, (typeof PEOPLE_PALETTE)[number]>(PEOPLE_PALETTE.map((item) => [item.value.toLowerCase(), item]));

export function peoplePaletteEntry(id: string) { return byId.get(id); }

/** Existing custom hex values remain custom; known values acquire a stable ID. */
export function resolveStoredPersonColor(color: string, colorId?: string | null): PersonColor {
  const entry = colorId ? byId.get(colorId) : byValue.get(color.toLowerCase());
  return entry ? { colorId: entry.id, color: entry.value } : { colorId: null, color };
}

/** Ties follow the published palette order, making allocation deterministic. */
export function allocatePersonColor(people: Array<{ color: string; colorId?: string | null }>): PersonColor {
  const counts = new Map<PeoplePaletteId, number>(PEOPLE_PALETTE.map((item) => [item.id, 0]));
  for (const person of people) {
    const resolved = resolveStoredPersonColor(person.color, person.colorId);
    if (resolved.colorId) counts.set(resolved.colorId, (counts.get(resolved.colorId) ?? 0) + 1);
  }
  const selected = PEOPLE_PALETTE.reduce((best, item) =>
    (counts.get(item.id) ?? 0) < (counts.get(best.id) ?? 0) ? item : best);
  return { colorId: selected.id, color: selected.value };
}

export function peopleAppearance() {
  return { peoplePalette: PEOPLE_PALETTE.map((item) => ({ ...item })), paletteVersion: PEOPLE_PALETTE_VERSION };
}
