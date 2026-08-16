/** Pure terrain-analysis kernels. Kept independent of GeoTIFF I/O for deterministic tests. */

import { getPosition } from 'suncalc';

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

export interface ShadowGrid {
  values: ArrayLike<number>;
  width: number;
  height: number;
  observerCol: number;
  observerRow: number;
  cellWidthM: number;
  cellHeightM: number;
  radiusM: number;
  castDistanceM: number;
  sunAltitudeDegrees: number;
  /** Degrees clockwise from north. */
  sunAzimuthDegrees: number;
  nodata?: number;
}

export interface ShadowMask {
  shadow: Uint8Array;
  consideredCells: number;
  shadowCells: number;
}

export interface SolarPosition {
  altitudeDegrees: number;
  /** Degrees clockwise from north. */
  azimuthDegrees: number;
}

/** Maintained astronomical implementation; this wrapper pins Strata's angle convention. */
export function solarPosition(at: Date, location: readonly [number, number]): SolarPosition {
  const position = getPosition(at, location[1], location[0]);
  return {
    altitudeDegrees: position.altitude,
    azimuthDegrees: position.azimuth,
  };
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

/**
 * Casts one bounded ray from each output cell toward the sun. A cell is in
 * shadow when a sampled surface point rises above that ray. Missing samples
 * make the target unknown rather than silently claiming sun or shadow.
 */
export function computeShadowMask(grid: ShadowGrid): ShadowMask {
  const {
    values,
    width,
    height,
    observerCol,
    observerRow,
    cellWidthM,
    cellHeightM,
    radiusM,
    castDistanceM,
    sunAltitudeDegrees,
    sunAzimuthDegrees,
    nodata,
  } = grid;
  const shadow = new Uint8Array(width * height);
  const altitudeRadians = (sunAltitudeDegrees * Math.PI) / 180;
  const azimuthRadians = (sunAzimuthDegrees * Math.PI) / 180;
  const east = Math.sin(azimuthRadians);
  const north = Math.cos(azimuthRadians);
  const raySlope = Math.tan(altitudeRadians);
  const stepM = Math.min(cellWidthM, cellHeightM);
  let consideredCells = 0;
  let shadowCells = 0;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const targetDistance = Math.hypot(
        (col - observerCol) * cellWidthM,
        (row - observerRow) * cellHeightM,
      );
      if (targetDistance > radiusM) continue;
      const targetElevation = Number(values[row * width + col]);
      if (missing(targetElevation, nodata)) continue;

      if (sunAltitudeDegrees <= 0) {
        consideredCells++;
        shadow[row * width + col] = 1;
        shadowCells++;
        continue;
      }

      let isShadow = false;
      let known = true;
      let previousIndex = -1;
      for (let distance = stepM; distance <= castDistanceM + 1e-9; distance += stepM) {
        const sampleCol = Math.round(col + (east * distance) / cellWidthM);
        const sampleRow = Math.round(row - (north * distance) / cellHeightM);
        if (sampleCol < 0 || sampleCol >= width || sampleRow < 0 || sampleRow >= height) break;
        const sampleIndex = sampleRow * width + sampleCol;
        if (sampleIndex === previousIndex || sampleIndex === row * width + col) continue;
        previousIndex = sampleIndex;
        const sampleElevation = Number(values[sampleIndex]);
        if (missing(sampleElevation, nodata)) {
          known = false;
          break;
        }
        if (sampleElevation > targetElevation + raySlope * distance + 1e-6) {
          isShadow = true;
          break;
        }
      }
      if (!known) continue;
      consideredCells++;
      if (isShadow) {
        shadow[row * width + col] = 1;
        shadowCells++;
      }
    }
  }

  return { shadow, consideredCells, shadowCells };
}
