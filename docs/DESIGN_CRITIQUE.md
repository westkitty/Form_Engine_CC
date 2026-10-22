## Design Critique: FORM//ENGINE workbench (v0.1, pre-redesign)

Reviewed on 2026-10-22 against screenshots at 1440×900, 1024×768 and 390×844, plus the Image Lab. Primary target: Samsung Galaxy Tab S9 Ultra with S Pen.

### Overall impression
The clay object reads well and the dark, brass-accented palette suits a sculpting tool. But the clay competes with about 60 visible controls. A desktop-DCC layout is spread across five zones (top bar, tool rail, view bar, inspector, status bar). On a pen tablet that means constant reaching to the far edge, and the sculpture loses roughly 35% of the screen.

### Usability
| Finding | Severity | Recommendation |
|---|---|---|
| The two most-used controls while sculpting (brush size, strength) are small sliders deep in the right panel, far from the off-hand | 🔴 Critical | Put them on large vertical sliders on the screen edge (the Procreate pattern), reachable by the off-hand thumb |
| There is no gesture undo. Undo is a 30 px button at the top centre | 🔴 Critical | Two-finger tap = undo, three-finger tap = redo, plus a large floating undo/redo pair near the off-hand |
| Nine brushes plus Mask appear at once as equal-weight cards | 🟡 Moderate | Keep five primary brushes in the dock (Draw, Clay, Smooth, Grab, Mask) and put the rest behind "More" |
| Advanced parameters (falloff, spacing, pressure, boundary protection) sit permanently in the main flow | 🟡 Moderate | Move them to a brush-settings popover |
| The view bar (10 controls) floats over the canvas, and 6 controls in the top bar duplicate menu items | 🟡 Moderate | Use one "View" popover and one main menu |
| The status bar shows diagnostics (fps, p95, history bytes, WebGL) that users don't act on | 🟢 Minor | Hide it by default; diagnostics stay available from the menu |
| No S Pen affordances: no hover preview cue, side button unused, no palm rejection | 🔴 Critical | Pen hover shows the brush ring; the side button inverts; once a pen is seen, touch only navigates |
| Install/full-screen do not work on Android: the manifest has only an SVG icon, so Chrome won't offer install | 🔴 Critical | Add PNG 192/512 and maskable icons, `display: fullscreen` with fallbacks, an in-app Install button and a full-screen toggle |
| The Image Lab shows five modes and dense paragraphs at once | 🟡 Moderate | Lead with one action, "Make 3D from photo"; put the other modes under "More ways" |

### Visual hierarchy
- **What draws the eye first:** the orange "Image → 3D" button and the inspector's brush grid, not the sculpture. It should be the sculpture.
- **Reading flow:** the eye bounces between the top bar, inspector and view bar. There is no single focal path.
- **Emphasis:** secondary information (triangle counts, units, lock icons) gets the same weight as primary actions.

### Consistency
| Element | Issue | Recommendation |
|---|---|---|
| Buttons | Four sizes (tap, small, tiny, icon) used without clear roles | Two sizes: the 48 px tool size and a compact size for menus |
| Panels | Inspector sections, viewbar pills and dialogs each use different surface treatments | One floating-panel style: blurred glass over the canvas, 14 px radius |
| Labels | Mix of "Refs", "Inspect", "Move" | Verb-free nouns on tools; actions in menus |

### Accessibility
- **Colour contrast:** primary text passes (≈13:1). `--text-3` (#7c7973) on #181b20 is ≈4.0:1, which fails AA for the 11 px hint text it is used on. Raise it to ≈#9a968f.
- **Touch targets:** desktop controls are 26–30 px, below the 44–48 px tablet guideline. A coarse pointer bumps them to 42 px, still dense.
- **Text readability:** many 10.5–11 px labels. On a tablet the minimum should be 13 px.

### What works well
- The clay material, lighting and dark-graphite palette give the sculpture the right focal quality.
- Honest status messaging (provenance, consent, "Provider not connected") builds trust.
- Keyboard map and command palette are good power-user paths. Keep them.

### Priority recommendations
1. **Canvas-first layout.** Remove the permanent inspector, view bar and status bar. Use a slim top bar (undo/redo, project, menu, full screen), a left brush dock, a right size/strength rail, and panels that open on demand.
2. **Pen-first input.** Add S Pen hover, side-button invert, palm rejection, a pressure curve, and two/three-finger tap for undo/redo.
3. **A real installable app.** PNG/maskable icons, a fullscreen display mode, an install button, and a full-screen toggle, so it opens like a native app on the Tab S9 Ultra.
