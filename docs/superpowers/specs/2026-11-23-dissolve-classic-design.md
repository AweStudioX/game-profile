# Dissolve-inspired Classic theme

Keep the `classic` theme ID, existing theme preferences, cover-first catalog and all data states. Adapt the visual language of [Dissolve](https://dissolve.rselmi.com/) using the existing HTML, CSS and JavaScript; do not add React, runtime dependencies or a build step.

- Use neutral surfaces, fine separators and rounded controls. Reserve color for artwork and meaningful status. Pixel and Neon City retain their current styling and interactions.
- Adapt SegmentedControl to the existing provider filter buttons. The selected pill slides on the same row and fades when wrapping. Preserve keyboard focus and `aria-pressed`.
- Adapt NumberTicker to known playtime and game count. Display the formatted value as accessible text; keep the unknown placeholder, partial-data label and unit intact.
- Adapt GlossyButton to the existing pagination button using an inset highlight and press feedback. Do not change pagination or its focus behavior.
- Disable decorative movement for reduced motion. Verify the demo dashboard at desktop and phone widths, including a filter change and switching themes.

Classic follows the system color scheme live. Light mode uses white, mist-gray surfaces and an ink primary button; dark mode uses black, graphite surfaces and a light primary button.
