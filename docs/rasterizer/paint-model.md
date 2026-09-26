# Design-file paint model

How `frameToSvg` draws a `.fig` node, and the file-format facts it rests on.
Each fact was measured against Figma's own exact-node PNG and SVG exports of
real component libraries (267 states, 24 families); the method is beside it.

## Measured file-format facts

| Fact | Method |
|---|---|
| `strokeGeometry` is the outline of a stroke centred on the path: for `INSIDE` and `OUTSIDE` it is twice the weight wide (the box reaches `−w … size+w`). Alignment is applied by clipping to the fill geometry (`INSIDE`) or cutting the fill geometry out (`OUTSIDE`). | Bounding boxes of `strokeGeometry` against `size` and `strokeWeight` over every stroked node of 40 sources. |
| `windingRule` of fill geometry is `NONZERO` or `ODD` (not `EVENODD`). `ODD` is SVG `evenodd`. | Outlined icons (bank, profile) render filled with `nonzero`, exact with `evenodd`. |
| Siblings stack by `parentIndex.position` compared as strings, bottom first; the record order of `nodeChanges` is not the drawing order. Auto layout with `stackReverseZIndex` stacks them in reverse. | A logo drawn under its own background; overlapping bank badges. |
| `frameMaskDisabled === false` clips children to the frame's shape (corner radii included) inside components and fill-less frames alike. | Switch, badge and icon families: clipping restores 40+ states. |
| A shape clipped by an equal clip keeps its own edge coverage in Figma; an antialiased SVG clip multiplies the two. `frameToSvgWithReport(…, { crispClips: true })` draws clips without antialiasing for a caller that supersamples. | Switch tracks inside a same-radius clipping component. |
| A linear or radial gradient is defined in paint space (linear from `(0, ½)` to `(1, ½)`, radial centred at `(½, ½)` with radius `½`); `paint.transform` maps the node's unit box into paint space. | Gradient centres match Figma's own SVG export to 0.01 px. |
| A corner radius shrinks by the tighter of its two sides (a side fits when its two radii sum to at most its length). | Independent radii 50/0.5/15/50 on a 43×17 badge give Figma's 8.5/0.43/9.92/8.5. |
| A paint bound to a colour variable (`colorVar`) is drawn with the variable's value in the mode in force: the nearest `variableModeBySetMap` up the drawn tree (an instance's over its component's), else the set's default — the mode whose values the file's own cached colours carry outside every explicit mode. A solid caches the variable's alpha as its opacity. The colour stored beside an override's binding can be stale. | Watermelon and chevron overrides cached white, drawn black/grey by Figma. |
| A text baseline's distance from the top of its line is a whole export pixel; the text box keeps its position. | Sub-pixel vertical shift of 0.3–0.45 px on eight text families disappears. |
| A truncated text ends with a glyph without `firstCharacter`: the ellipsis. | Truncated list rows. |
| A cached library master may have no geometry of its own; an instance's `derivedSymbolData` carries it in instance coordinates. | Badge "plus" glyph. |

## Drawing

- Every geometry is drawn once per visible paint, bottom to top, with the
  paint's opacity and blend mode (`mix-blend-mode`). Solid, linear and radial
  paints are SVG fills; angular (fine wedges), diamond (one exact linear
  gradient per quadrant) and image paints (`FILL`, `FIT`, `TILE`, `STRETCH`
  with its crop transform, 90° rotations) are drawn in the node box and
  clipped by the geometry.
- Rectangle-like nodes and whole ellipses are drawn from size and radii (an
  override that resizes them or changes a radius leaves the stored geometry
  stale); stored geometry is used for corner smoothing, arcs, vectors and
  booleans.
- Effects are one filter in the node's coordinates: drop shadows under the
  layer (knocked out beneath it unless `showShadowBehindNode`), spread by
  morphology, inner shadows over it, a layer blur over the result; the blur
  radius is twice the Gaussian sigma.
- Masks: `ALPHA` (and an absent `maskType`) by rendered alpha, `OUTLINE` by
  geometry whatever the paints, `LUMINANCE` by brightness. `mask-type` is an
  attribute: resvg ignores it in `style`.

## Not drawn (reported by `frameToSvgWithReport`)

Background blur, noise/texture effects, `LINEAR_BURN`/`LINEAR_DODGE` blend
modes, image filters (exposure, contrast…), text strokes, `SMALL_CAPS`/`TITLE`
text case, variable-font axes, unknown node types, and a colour variable that
is not in the file. Each appears as `nodeId property=value`, so a caller can
tell a complete render from a partial one.
