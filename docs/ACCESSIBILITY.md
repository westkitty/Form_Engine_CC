## Accessibility Audit: FORM//ENGINE redesigned studio UI
**Standard:** WCAG 2.1 AA | **Date:** 2026-10-22 | **Method:** automated in-browser scan at 1232×770 with coarse-pointer emulation (Galaxy Tab S9 Ultra class), keyboard checks, and code review of `Shell.ts` / `dom.ts`. Not yet tested with a real screen reader (TalkBack / VoiceOver).

### Summary
**Issues found:** 4 | **Critical:** 0 | **Major:** 1 (fixed) | **Minor:** 3 (2 fixed, 1 open)

### Findings

#### Perceivable
| # | Issue | WCAG | Severity | Status |
|---|---|---|---|---|
| 1 | The sculpting canvas is visual-only. Geometry facts are exposed as text in the Object panel (triangles, size, mesh check), but sculpting itself cannot be done without sight | 1.1.1 | 🟢 Minor (inherent) | Documented; the canvas has `role="img"` and a label |

#### Operable
| # | Issue | WCAG | Severity | Status |
|---|---|---|---|---|
| 2 | On touch screens, chips, dropdowns, the project name field and range inputs were 34–42 px tall | 2.5.5 | 🟡 Major | **Fixed**: 44 px minimum on coarse pointers |
| 3 | Panel tabs had no arrow-key navigation | 2.1.1 | 🟢 Minor | **Fixed**: roving tabindex plus ←/→ |

#### Understandable
| # | Issue | WCAG | Severity | Status |
|---|---|---|---|---|
| — | Errors state the cause and the next step (import, autosave, providers) | 3.3.1 | — | Pass |

#### Robust
| # | Issue | WCAG | Severity | Status |
|---|---|---|---|---|
| 4 | Tabs were missing a `tabpanel` relationship | 4.1.2 | 🟢 Minor | **Fixed**: `role="tabpanel"`, `aria-controls` and `aria-labelledby` |

### Color Contrast Check (measured)
| Element | Ratio | Required | Pass? |
|---|---|---|---|
| Body text `--text` on panel | 14.14:1 | 4.5:1 | ✅ |
| Secondary `--text-2` on panel | 7.92:1 | 4.5:1 | ✅ |
| Hints `--text-3` on panel | 5.86:1 | 4.5:1 | ✅ (was ≈4.0:1 before the redesign) |
| Button text on brass | 7.53:1 | 4.5:1 | ✅ |
| Success / warning / error text | 9.73 / 11.26 / 6.66:1 | 4.5:1 | ✅ |

### Keyboard Navigation
| Element | Tab | Enter/Space | Escape | Arrows |
|---|---|---|---|---|
| Size / Strength sliders | focusable | — | — | ↑/↓ step 1/40, PgUp/PgDn 1/5; value bubble shown on focus |
| Popovers (menu, view, brush) | focus moves into the popover | activates | closes and returns focus to its button | — |
| Panel tabs | the selected tab | switches | closes the panel | ←/→ |
| Dialogs | native `<dialog>` focus trap | — | closes | — |

### Screen Reader (by markup)
| Element | Announced as |
|---|---|
| Size slider | "Size, slider, 0.25 m" (`aria-valuetext`) |
| Brush buttons | "Draw, toggle button, pressed" (`aria-pressed`) |
| Save dot | status with "Saved on this device …" |
| Toasts / job progress | polite live region; job state changes go to an assertive announcer |

### Priority Fixes
1. **Done:** 44 px touch targets everywhere on touch devices.
2. **Done:** tab semantics and arrow keys.
3. **Open:** verify with TalkBack on the Tab S9 Ultra and VoiceOver on iPad.
