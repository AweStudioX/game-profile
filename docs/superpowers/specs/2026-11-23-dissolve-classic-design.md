# Dissolve-inspired Classic theme

Keep the `classic` theme ID, existing theme preferences, cover-first catalog and all data states. Adapt the visual language of [Dissolve](https://dissolve.rselmi.com/) using the existing HTML, CSS and JavaScript; do not add React, runtime dependencies or a build step.

- Use neutral surfaces, fine separators and rounded controls. Reserve color for artwork and meaningful status. Pixel and Neon City retain their current styling and interactions.
- Both provider filters and sorting adapt the upstream SegmentedControl grain mechanics: round overlapping grains, leading-edge stagger, scattered arcs, a 90 ms outgoing capsule fade, and a destination capsule fading in at 280 ms. The 420 ms flight can retarget from current particle positions. Pointer dragging preserves the selected control's keyboard focus; vertical touch scrolling is not treated as selection. Reduced motion uses a 260 ms slide.
- Adapt NumberTicker to known playtime and game count. Display the formatted value as accessible text; keep the unknown placeholder, partial-data label and unit intact.
- Adapt GlossyButton to the existing pagination button using an inset highlight and press feedback. Do not change pagination or its focus behavior.
- While fetching, show a soft diagonal wave across cover, metadata and achievement placeholders. Resolve activity and library independently. On the first library render, uncover visible covers in staggered grains; never replay the handoff for a sort or filter. Keep errors, empty states and missing artwork distinct from loading. Reduced motion uses static placeholders and immediate content.
- Reserve the toolbar's actual wrapping layout and use the same source-row tracks before and after loading. The achievement dialog and backdrop ease in and out together. When results arrive or the selected platform changes, transition the section from its current height without delaying access to the new content or trapping focus on close.
- Disable decorative movement for reduced motion. Verify the demo dashboard at desktop and phone widths, including a filter change and switching themes.
- The main heading uses sampled glyph points, not a CSS mask. Adapt the upstream footer's cursor repulsion, click scattering, and damped springs. Keep the accessible English title `Game Log.` and the demo-data notice; omit the redundant eyebrow and explanatory sentence. Stop drawing when settled, offscreen, or hidden; reduced motion uses stationary dots, and forced colors restores solid text.
- Use a rounded SVG theme chevron, optically centered in a 20 px box, with a 220 ms rotation on expansion. The rounded theme panel transitions both in and out, with a trailing SVG check for the active theme. Closing makes the panel inert immediately; reduced motion cancels transitions. Keep keyboard dismissal and theme persistence.
- Upstream adaptations live in `public/dashboard/dissolve.mjs`; preserve `dissolve-LICENSE.txt` and serve both assets in the local preview.
- Show synchronization timestamps directly on all viewport sizes instead of duplicating them in mobile disclosure widgets.
- Suppress native tap highlighting and text selection on interactive cards, segmented controls, and the theme picker only. Limit hover feedback to fine pointers; retain keyboard focus outlines and persistent selection indicators.
- Keep public platform identities as a compact, unboxed avatar/name strip without a visible heading or disclosure caption. Visibility remains owner-controlled server-side.
- Use one home navigation action: sign in for visitors, platform management for verified owners. Keep deployment/privacy documentation in the connection page, not the public footer.
- End the catalog with a restrained D-pad mark, `KEEP PLAYING.` wordmark, and a keyboard-accessible back-to-top link. Use theme tokens, wrapping layout, and reduced-motion-safe hover feedback.

Classic follows the system color scheme live. Light mode uses white, mist-gray surfaces and an ink primary button; dark mode uses black, graphite surfaces and a light primary button.
