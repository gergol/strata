/** Pure terrain-analysis kernels. Kept independent of GeoTIFF I/O for deterministic tests. */

export interface ViewshedGrid {
  values: ArrayLike<number>;
  width: number;
  height: number;
  observerCol: number;
  observerRow: number;
  cellWidthM: number;
  cellHeightM: number;
  radiusM: number;
  observerHeightM: number;
  nodata?: number;
}

export interface ViewshedMask {
  visible: Uint8Array;
  consideredCells: number;
  visibleCells: number;
}

function missing(value: number, nodata: number | undefined): boolean {
  return !Number.isFinite(value) || (nodata !== undefined && value === nodata);
}

/**
 * Exact grid line-of-sight at the selected analysis resolution. Each target
 * cell is visible when no intermediate surface sample has a greater elevation
 * angle from the observer. The short urban windows used by Strata do not need
 * an earth-curvature correction.
 */
export function computeViewshedMask(grid: ViewshedGrid): ViewshedMask {
  const {
    values,
    width,
    height,
    observerCol,
    observerRow,
    cellWidthM,
    cellHeightM,
    radiusM,
    observerHeightM,
    nodata,
  } = grid;
  const visible = new Uint8Array(width * height);
  const observerSurface = Number(values[observerRow * width + observerCol]);
  if (missing(observerSurface, nodata)) return { visible, consideredCells: 0, visibleCells: 0 };
  const observerElevation = observerSurface + observerHeightM;
  let consideredCells = 0;
  let visibleCells = 0;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const dx = col - observerCol;
      const dy = row - observerRow;
      const distance = Math.hypot(dx * cellWidthM, dy * cellHeightM);
      if (distance > radiusM) continue;
      const targetElevation = Number(values[row * width + col]);
      if (missing(targetElevation, nodata)) continue;
      consideredCells++;

      let isVisible = true;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps > 1) {
        const targetSlope = (targetElevation - observerElevation) / distance;
        for (let step = 1; step < steps; step++) {
          const fraction = step / steps;
          const sampleCol = Math.round(observerCol + dx * fraction);
          const sampleRow = Math.round(observerRow + dy * fraction);
          const sampleElevation = Number(values[sampleRow * width + sampleCol]);
          if (missing(sampleElevation, nodata)) {
            isVisible = false;
            break;
          }
          const sampleDistance = Math.hypot(
            (sampleCol - observerCol) * cellWidthM,
            (sampleRow - observerRow) * cellHeightM,
          );
          if (sampleDistance > 0 && (sampleElevation - observerElevation) / sampleDistance > targetSlope + 1e-9) {
            isVisible = false;
            break;
          }
        }
      }
      if (isVisible) {
        visible[row * width + col] = 1;
        visibleCells++;
      }
    }
  }

  return { visible, consideredCells, visibleCells };
}
