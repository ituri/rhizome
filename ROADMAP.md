# Rhizome Roadmap 🌱

> **Pflege-Regel:** Diese Datei wird bei **jeder** Feature-Änderung aktualisiert —
> wenn ein Feature umgesetzt wird (→ Status auf ✅, Datum ergänzen) **oder**
> wenn entschieden wird, es *nicht* zu bauen (→ nach „Bewusst nicht geplant"
> verschieben, mit kurzer Begründung).

Diese Roadmap listet Features, die Roam Research bietet und Rhizome noch nicht —
priorisiert nach *Community-Nachfrage × Passung zu Rhizomes Philosophie*
(zero runtime deps, ein Prozess, eine SQLite-Datei, single-owner).

Der vollständige Ist-Stand steht in [docs/FEATURES.md](docs/FEATURES.md).

Status: ⬜ geplant · 🚧 in Arbeit · ✅ umgesetzt · ❌ verworfen

---

## Phase 1 — Roam-Killerfeatures, die sauber ins Modell passen

| Status | Feature | Kern | Notiz |
|---|---|---|---|
| ⬜ | **Spaced Repetition / Flashcards** | `{{card}}`-Marker, SM-2-Intervalle als Block-Attribute, Review-Ansicht (`#/review`) | Höchster Hebel: meistgefeiertes Roam-Feature, fehlt komplett, 100 % lokal/zero-dep |
| ⬜ | **Query Builder mit Ergebnis-Views** | Visuelles Query-Bauen + Tabellen-/Kanban-/Kalender-Rendering der Treffer | Baut auf vorhandener `{{query}}`-Engine auf |
| ✅ | **Live Hover-Preview** | Editierbare Vorschau über `[[links]]` / `((refs))` beim Hover | Umgesetzt 2026-07-21 (`public/preview.js`): editierbare Transklusion des Ziels, synct über den Op-Pfad; nur bei echtem Pointer (hover), abschaltbar |
| ⬜ | **Globale Command Palette** | Fuzzy-Zugriff auf alle Aktionen (Ctrl+P) | Ergänzt Slash-Menü + Ctrl+K |

## Phase 2 — Zeit & Struktur

| Status | Feature | Kern | Notiz |
|---|---|---|---|
| ⬜ | **Reminders / recurring / Uhrzeiten** | Uhrzeit- & Wiederholungs-Erweiterung der Datums-Pills; Zustellung über SSE-Hub + Web-Push | Löst zwei `❌` aus FEATURES.md, ohne SMTP |
| ⬜ | **Version History browsen** | „Verlauf ansehen/wiederherstellen" pro Block aus dem Op-Log-Journal | Journal existiert schon fürs Undo |
| ⬜ | **SmartBlocks-light** | Templates mit Variablen (`<%DATE%>`, `<%CURSOR%>`, Prompts) | Zero-dep, großer Workflow-Gewinn |

## Phase 3 — Visualisierung & Medien

| Status | Feature | Kern | Notiz |
|---|---|---|---|
| ⬜ | **Graph-View** | Zero-dep SVG/Canvas-Force-Layout aus dem Backlink-Graphen | Roams ikonisches Feature, hoher „Wow"-Wert |
| ⬜ | **PDF-Highlights → Blocks** | PDF-Viewer, Markierungen werden zu verlinkten Blocks | Researcher-Workflow, client-seitig aufwändig |
| ⬜ | **Web-Clipper** | Browser-Extension, die in die Capture-API schreibt | Ergänzt vorhandene Capture-API |
| ⬜ | **LaTeX / Math-Rendering** | `$$…$$` rendern | Nur wenn eine gekapselte Client-Lib akzeptiert wird (Bruch mit zero-dep → bewusste Entscheidung) |
| ⬜ | **Mermaid / Diagramme** | Diagramm-Blocks | Wie LaTeX: Dependency-Abwägung nötig |

---

## Bewusst nicht geplant

Diese Roam-Features kollidieren fundamental mit Rhizomes Kern und bleiben Nicht-Ziele.
Rhizome adressiert die Nische stattdessen über **MCP + REST-API**.

| Feature | Warum nicht |
|---|---|
| **Plugin-/roam-js-Ökosystem** | Widerspricht „zero runtime deps, ein Prozess" |
| **Multiplayer / Echtzeit-Kollaboration** | Single-owner-Modell by design; Rhizome nutzt Last-writer-wins + additives Merging |
| **Editierbare Tabellen / Attribut-Tabellen** | Sizable Feature, Workflowy-Parität — vorerst außerhalb des Fokus |
| **Audio-Aufnahme (+ Transkript)** | Passt schlecht zu zero-dep; niedrige Nachfrage |
