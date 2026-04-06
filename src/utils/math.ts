export type Vec3 = [number, number, number];

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < 1e-10) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Normalize with a custom fallback direction for degenerate (zero-length) vectors. */
export function vec3NormalizeSafe(v: Vec3, fallback: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < 1e-10) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function vec3Lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3Length(vec3Sub(a, b));
}

/**
 * Rotate vector `v` around axis `axis` by `angle` radians (Rodrigues' formula).
 */
export function vec3RotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = vec3Dot(v, axis);
  const cross = vec3Cross(axis, v);
  return [
    v[0] * cos + cross[0] * sin + axis[0] * dot * (1 - cos),
    v[1] * cos + cross[1] * sin + axis[1] * dot * (1 - cos),
    v[2] * cos + cross[2] * sin + axis[2] * dot * (1 - cos),
  ];
}

export function degToRad(degrees: number): number {
  return degrees * (Math.PI / 180);
}

export function radToDeg(radians: number): number {
  return radians * (180 / Math.PI);
}

/**
 * Project vector onto a plane defined by its normal.
 */
export function vec3ProjectOntoPlane(v: Vec3, planeNormal: Vec3): Vec3 {
  const d = vec3Dot(v, planeNormal);
  return vec3Sub(v, vec3Scale(planeNormal, d));
}

/**
 * Angle (radians) between two vectors.
 */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = vec3Length(a);
  const lb = vec3Length(b);
  if (la < 1e-10 || lb < 1e-10) return 0;
  const d = vec3Dot(a, b) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/**
 * Closest point on line segment AB to point P.
 */
export function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = vec3Sub(b, a);
  const len2 = vec3Dot(ab, ab);
  if (len2 < 1e-12) return a;
  const t = Math.max(0, Math.min(1, vec3Dot(vec3Sub(p, a), ab) / len2));
  return vec3Add(a, vec3Scale(ab, t));
}
