UI font (Inter)
===============

The whole interface uses Inter, wired through the --sans variable in app.css.
ATLAS never loads anything from a CDN, so Inter is picked up from the machine
when it is installed; otherwise the stack falls back to the system UI font
(Segoe UI Variable Text on Windows, system-ui elsewhere).

To guarantee Inter on every machine, drop the font file in here:

  static/fonts/Inter.woff2

and uncomment the @font-face line at the top of app.css.

Where to get it (open source, SIL Open Font Licence):
  https://github.com/rsms/inter/releases   (or fonts.google.com/specimen/Inter)

Use the variable version if you can, so every weight comes from one file.


Handwriting font for notes / the board (Excalidraw style)
========================================================

By default, notes use the system handwriting font:
  - Windows 10/11:  Ink Free   (very close to Excalidraw)
  - macOS:          Bradley Hand
  - fallback:       cursive

If you want it to look EXACTLY the same on any machine (and in the exported
PDF/image), drop the Excalidraw font file in here under this name:

  static/fonts/Virgil.woff2

Where to get it (it is open source, MIT licence):
  https://github.com/excalidraw/excalidraw/blob/master/public/Virgil.woff2

As soon as the file exists, ATLAS uses it automatically (the @font-face rule is
already set up in app.css). Nothing else needs touching.

Open source handwriting alternatives that also look good:
  Caveat, Shantell Sans, Comic Neue  (download them as .woff2 and rename them to
  Virgil.woff2, or change the name in the @font-face rule in app.css).
