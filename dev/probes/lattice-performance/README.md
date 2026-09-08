# Lattice title performance probe

Open `/dev-probe.html?probe=latticePerformance` using the existing dev server.
The probe mounts the production `Lattice`, `PosterWall`, and `LatticePoster`, with a
local deterministic queue and no playing song or cover downloads. One card expands
during warmup. It uses the same StrictMode gallery as other probes.

## Comparisons

- **Original CSS**: the current 0.95 expanded leading, padding, and CSS line clamp,
  with title fitting disabled (no title observers or measurements).
- **Current DOM**: the production 200 ms settled fitter, with measurement counters.

## Workloads

- **Scale**: continuous local `scale` on real cards; changes visual size without
  changing layout width. This supplements the existing Framer Motion transform.
- **Reflow**: continuously resize the wall viewport and title copy widths; select
  another real card every 1.2 seconds to exercise expansion and block rearrangement.
  The copy-width sweep is deliberate stress, not a claim that production uses it.
- **Pan**: synthetic wheel events through the real camera handler, following a
  time-based ±5000 px / ±3500 px trajectory. Real bounds publication, virtualized
  mounting/unmounting, and visibility observers remain active.

Each trial gets its own title-fit cache instead of the process-wide one, so a warm cache from an
earlier trial cannot make a later one look free. Each trial remounts the wall and its title caches, warms up for 2.2 s, runs the chosen
motion duration, and measures another 1.4 s after motion stops. All six combinations
run sequentially, and repeats rotate strategy order to blunt warm-cache and thermal
ordering bias. Use the same queue size, viewport, duration, browser, and device.
Test results from headless Linux are not a substitute for measurements on the
affected iPad.

## Results

The table separates motion and settle phases. It shows mean/P95/max RAF intervals,
intervals >33.3 ms, fitting calls (cache misses), DOM height reads, fitting time,
and peak mounted cards. RAF intervals include
all browser work and are not GPU timings or an exact dropped-frame count. DOM read
counts cover only the fitter's height checks, not the wall's other layout work;
fitting time excludes React commits. The sampling/trajectory driver also has cost,
identical across strategies. Queue length differs from mounted card count because
the real wall is virtualized.

Export JSON retains each run, counts, browser user agent and viewport/DPR. Compare
multiple repeats within each workload and include the settle tail; reporting only
motion would hide the work intentionally deferred by the current implementation.
Stopping, switching tabs, or unmounting cancels the active round without appending an
incomplete result. Earlier results remain available for export.
