# docs/

Long-form documentation for `job_ops-mcp`.

## Files

- `user-guide.tex` — comprehensive end-to-end user guide.
- `user-guide.pdf` — compiled artifact (committed so the repo's docs link works without a TeX install).

## Rebuilding the PDF

The guide is written in plain LaTeX. It compiles with `pdflatex` from any reasonable TeX
distribution. The actual toolchain it was authored on:

| Component       | What was used                                            |
|-----------------|----------------------------------------------------------|
| Engine          | `pdflatex` (TeX Live 2026)                               |
| Body font       | Charter (`\usepackage{charter}`)                         |
| Headings font   | Helvetica clone (`\usepackage[scaled=0.92]{helvet}`)     |
| Code            | `listings` (no minted — listings has no pygments dep)    |
| Diagrams        | TikZ — architecture, ER, state machine, all native       |
| Callouts        | `tcolorbox` (skins, breakable, listings libraries)       |
| Icons           | text labels (no `fontawesome` dependency)                |
| Hyperlinks      | `hyperref` with `colorlinks=true`, accent #145374        |

### Required packages

All in any complete TeX Live install. On a *basic* TeX Live (like the one the guide was
written on), these may need adding via `tlmgr --usermode install <pkg>`:

```
tikzfill        # tcolorbox skins library needs this
pdfcol          # also a tcolorbox dependency
charter         # Bitstream Charter font (T1-encoded metrics)
helvetic        # Adobe Helvetica clone (URW Nimbus Sans)
```

If you're on a full TeX Live (`tlmgr install scheme-full`) everything is preinstalled.

### Build

```bash
cd docs
pdflatex user-guide.tex
pdflatex user-guide.tex     # second pass — TOC + cross-refs + bookmarks
```

The PDF lands at `docs/user-guide.pdf`. The build takes ~3 seconds end-to-end.

### Build with a script

```bash
# Equivalent one-liner — both passes, error-loud.
pdflatex -interaction=nonstopmode -halt-on-error user-guide.tex \
  && pdflatex -interaction=nonstopmode -halt-on-error user-guide.tex
```

## Editing notes

- **Adding a section?** Update the TOC link target by re-running `pdflatex` twice.
- **Adding a callout?** The three styles are `tipbox` (blue), `warnbox` (orange), `examplebox` (gray). All are `breakable` so they can span pages.
- **Adding a diagram?** TikZ libraries already loaded: `shapes.geometric`, `shapes.misc`, `arrows.meta`, `positioning`, `fit`, `backgrounds`, `calc`, `decorations.pathreplacing`.
- **Adding code?** `\lstset{style=plain}` is the default; languages defined inline are `json`, `yaml`, `bashplus`.
- **The accent colour** is `#145374` (deep teal). Defined as `\definecolor{accent}{HTML}{145374}`. Change once at the top of `user-guide.tex` to retheme.

## What lives in the repo

`user-guide.pdf` is committed so:

1. The README's link to it works on GitHub immediately.
2. Users without a TeX install can read the guide.
3. CI doesn't need a TeX install to verify docs render.

If you change `user-guide.tex`, rebuild the PDF and commit both.
