/**
 * Interrupted Goode Homolosine (+proj=igh) for proj4js, which does not ship it.
 * Needed for SoilGrids (EPSG:152160). Spherical formulas matching PROJ's igh:
 * sinusoidal below 40°44'11.8" latitude, Mollweide (y-shifted for continuity)
 * above, in six interrupted lobes, each plotted about its central meridian.
 *
 * Importing this module registers the projection; verified against pyproj/PROJ
 * reference coordinates in test/proj-igh.test.ts.
 */
import proj4 from 'proj4';

const D2R = Math.PI / 180;
/** Latitude where sinusoidal meets Mollweide: 40°44'11.8". */
const PHI_THRESH = (40 + 44 / 60 + 11.8 / 3600) * D2R;
/** Mollweide x scale: 2*sqrt(2)/pi. */
const MOLL_K = (2 * Math.SQRT2) / Math.PI;

function thetaOf(phi: number): number {
  let theta = phi;
  for (let i = 0; i < 15; i++) {
    const delta =
      (2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(phi)) / (2 + 2 * Math.cos(2 * theta));
    theta -= delta;
    if (Math.abs(delta) < 1e-12) break;
  }
  return theta;
}

/** Mollweide y at the threshold minus sinusoidal y there — subtracted for continuity. */
const Y_CORR = Math.SQRT2 * Math.sin(thetaOf(PHI_THRESH)) - PHI_THRESH;

/** Central meridian (radians) of the lobe containing this lon/lat (radians). */
function centralMeridian(lam: number, phi: number): number {
  if (phi >= 0) {
    return lam < -40 * D2R ? -100 * D2R : 30 * D2R;
  }
  if (lam < -100 * D2R) return -160 * D2R;
  if (lam < -20 * D2R) return -60 * D2R;
  if (lam < 80 * D2R) return 20 * D2R;
  return 140 * D2R;
}

interface ProjectionThis {
  a: number;
}

interface Point {
  x: number;
  y: number;
}

const ighProjection = {
  names: ['igh', 'goode_homolosine', 'interrupted_goode_homolosine'],
  init(this: ProjectionThis): void {
    // Spherical projection on the semimajor axis, matching PROJ's behaviour.
  },
  forward(this: ProjectionThis, p: Point): Point {
    const lam = p.x;
    const phi = p.y;
    const lam0 = centralMeridian(lam, phi);
    const dl = lam - lam0;
    let x: number;
    let y: number;
    if (Math.abs(phi) <= PHI_THRESH) {
      x = lam0 + dl * Math.cos(phi);
      y = phi;
    } else {
      const theta = thetaOf(phi);
      x = lam0 + MOLL_K * dl * Math.cos(theta);
      y = Math.SQRT2 * Math.sin(theta) - Math.sign(phi) * Y_CORR;
    }
    p.x = x * this.a;
    p.y = y * this.a;
    return p;
  },
  inverse(this: ProjectionThis, p: Point): Point {
    const x = p.x / this.a;
    const y = p.y / this.a;
    const lam0 = centralMeridian(x, y); // lobe boundaries are meridians, so x works here
    let phi: number;
    let lam: number;
    if (Math.abs(y) <= PHI_THRESH) {
      phi = y;
      lam = lam0 + (x - lam0) / Math.cos(phi);
    } else {
      const theta = Math.sign(y) * Math.asin((Math.abs(y) + Y_CORR) / Math.SQRT2);
      phi = Math.asin((2 * theta + Math.sin(2 * theta)) / Math.PI);
      lam = lam0 + (x - lam0) / (MOLL_K * Math.cos(theta));
    }
    p.x = lam;
    p.y = phi;
    return p;
  },
};

// Registration is idempotent; importing this module is enough.
(proj4 as unknown as { Proj: { projections: { add(p: unknown): void } } }).Proj.projections.add(
  ighProjection,
);
