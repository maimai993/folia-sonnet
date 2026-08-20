# Patches applied to bundled third-party programs

## windowtolayer (popup/menu resilience fix)

**Program**: windowtolayer — a GPL-3.0 program bundled with the Folia Linux package to
implement desktop wallpaper mode (`wlr-layer-shell` bottom layer).
**Upstream**: https://gitlab.freedesktop.org/mstoeckl/windowtolayer
**Base revision**: `618a482d791e90f4977d643c206417f6aee73936`
**License**: GPL-3.0 (the program's `COPYING` is shipped as `resources/windowtolayer-COPYING`)

Upstream treats any request-handling error as fatal, so unsupported requests (e.g. popups,
context menus) make windowtolayer exit and break the wrapped client's Wayland connection.
The patch logs and skips such messages instead of exiting.

Applied by `packaging/linux/build-windowtolayer.mjs`: it clones the pinned revision and
`git apply`s this patch. To refresh after an upstream rework, bump `PINNED_REV` in that file,
re-apply the fix by hand, regenerate with `git diff`, and update the base revision here.

### License / source compliance

The distributed binary is built from the upstream source at the base revision plus this
patch. Together they are the "complete corresponding source" required by GPL-3.0; the
upstream URL, base revision, and patch logic are all published here.
