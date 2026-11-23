# Dissolve-inspired Classic theme

Keep the `classic` theme ID, existing theme preferences, cover-first catalog and all data states. Adapt the visual language of [Dissolve](https://dissolve.rselmi.com/) using the existing HTML, CSS and JavaScript; do not add React, runtime dependencies or a build step.

- Use neutral surfaces, fine separators and rounded controls. Reserve color for artwork and meaningful status. Pixel and Neon City retain their current styling and interactions.
- Use one selection pill per segmented control. The provider pill slides within a row and snaps across rows; the sort pill switches with its label contrast in the same frame. Replace the filtered library without fading it. Preserve keyboard focus and `aria-pressed`.
- Adapt NumberTicker to known playtime and game count. Display the formatted value as accessible text; keep the unknown placeholder, partial-data label and unit intact.
- Adapt GlossyButton to the existing pagination button using an inset highlight and press feedback. Do not change pagination or its focus behavior.
- While fetching, show a soft diagonal wave across cover, metadata and achievement placeholders. Resolve activity and library independently. On the first library render, uncover visible covers in staggered grains; never replay the handoff for a sort or filter. Keep errors, empty states and missing artwork distinct from loading. Reduced motion uses static placeholders and immediate content.
- Reserve the toolbar's actual wrapping layout and use the same source-row tracks before and after loading. The achievement dialog and backdrop ease in and out together. When results arrive or the selected platform changes, transition the section from its current height without delaying access to the new content or trapping focus on close.
- Disable decorative movement for reduced motion. Verify the demo dashboard at desktop and phone widths, including a filter change and switching themes.

Classic follows the system color scheme live. Light mode uses white, mist-gray surfaces and an ink primary button; dark mode uses black, graphite surfaces and a light primary button.
