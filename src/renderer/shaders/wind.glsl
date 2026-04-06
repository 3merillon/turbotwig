// Wind displacement — shared between bark, leaf, and depth passes.
// Expects these uniforms to be declared by the including shader:
//   float uTime, uWindSpeed, uGustStrength, uWindBias, uWindVertDamp
//   vec3  uWindDir
//   float uTrunkStiffness, uBranchFlex, uMaxSway
// Leaf-specific (unused uniforms are optimized away by the GLSL compiler):
uniform float uLeafVertDamp;
uniform float uLeafPush;

// --- Procedural noise for organic gust patterns ---
// Integer hash — avoids sin() GPU precision issues that cause visible seams.
float _whash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 32768);
  uint h = q.x * 1597334677u ^ q.y * 3812015801u;
  h *= 2654435769u;
  h ^= h >> 16u;
  return float(h) * (1.0 / 4294967296.0);
}

float _wnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic C2 interpolant
  return mix(mix(_whash(i),               _whash(i + vec2(1.0, 0.0)), f.x),
             mix(_whash(i + vec2(0.0, 1.0)), _whash(i + vec2(1.0, 1.0)), f.x), f.y);
}

float _wfbm(vec2 p) {
  return _wnoise(p) * 0.50 + _wnoise(p * 2.13 + vec2(5.3, 1.7)) * 0.30
       + _wnoise(p * 4.37 + vec2(13.1, 7.3)) * 0.20;
}

/** Returns trunk sway + branch oscillation (NO gust, NO clamp). */
vec3 computeWindBase(vec3 pos, float weight1, float weight2) {
  vec3 windHoriz = vec3(uWindDir.x, 0.0, uWindDir.z);
  float horizStrength = length(windHoriz);
  vec3 windHorizN = horizStrength > 0.001 ? windHoriz / horizStrength : vec3(1.0, 0.0, 0.0);
  float vertComponent = uWindDir.y;

  float windWeight = pow(max(weight1, 0.0), uTrunkStiffness);

  // Trunk sway
  float trunkPhase = uTime * 1.2;
  float sway = sin(trunkPhase + pos.y * 0.15);
  sway = sway * (1.0 - uWindBias) + uWindBias;
  vec3 trunkOffset = windHorizN * sway * windWeight * uWindSpeed * horizStrength * 0.04;
  trunkOffset.y += vertComponent * sway * windWeight * uWindSpeed * 0.015 * (1.0 - uWindVertDamp);

  // Branch oscillation — perturbed spatial phase breaks linear wavefront
  float depthScale = 1.0 + weight2 * uBranchFlex * 5.0;
  float distFromAxis = length(pos.xz);
  float spatialPhase = pos.x * 0.8 + pos.z * 0.6 + pos.y * 0.3
                     + (_wnoise(pos.xz * 1.2) - 0.5) * 2.0;
  float bp1 = uTime * 2.8 + spatialPhase;
  float bp2 = uTime * 1.7 + spatialPhase * 0.7;
  float branchAmp = min(distFromAxis * 0.15, 1.0) * windWeight * depthScale;
  vec3 branchOffset = vec3(
    sin(bp1) * cos(bp2) * branchAmp * uWindSpeed * 0.02,
    sin(bp1 * 0.5) * branchAmp * uWindSpeed * 0.005,
    cos(bp1) * sin(bp2) * branchAmp * uWindSpeed * 0.02
  );

  return trunkOffset + branchOffset;
}

/** Gust multiplier (0-based, add 1 before applying).
    Uses 2D noise scrolling along wind direction for organic, non-linear gusts. */
float computeGust(vec3 pos) {
  // Build wind-aligned 2D coordinate frame
  vec3 windH = vec3(uWindDir.x, 0.0, uWindDir.z);
  float hLen = length(windH);
  vec3 wN = hLen > 0.001 ? windH / hLen : vec3(1.0, 0.0, 0.0);
  vec3 wP = vec3(-wN.z, 0.0, wN.x);

  float along  = dot(pos, wN);
  float across = dot(pos, wP);

  // Noise UV: very low spatial frequency so the entire tree sits inside a
  // single smooth gust gradient — no lattice boundaries cross the canopy.
  // Scrolls along wind direction for organic temporal variation.
  vec2 gustUV = vec2(along * 0.008 - uTime * 0.18,
                     across * 0.006 + uTime * 0.04)
              + pos.y * 0.003;

  float gust = _wfbm(gustUV);
  return gust * uWindSpeed * uGustStrength;
}

/** Full wind for bark: base + gust, clamped. */
vec3 computeWind(vec3 pos, float weight1, float weight2) {
  vec3 base = computeWindBase(pos, weight1, weight2);
  vec3 total = base * (1.0 + computeGust(pos));
  float len = length(total);
  if (len > uMaxSway) total *= uMaxSway / len;
  return total;
}

/** Leaf flutter + push offset. Requires uLeafVertDamp, uLeafPush uniforms. */
vec3 computeLeafFlutter(vec3 pos, vec3 normal, float leafT, float leafPhase) {
  float lp = uTime * 7.0 + leafPhase * 6.283;
  vec3 flutter = normal * sin(lp) * cos(lp * 1.3) * uWindSpeed * 0.012 * leafT;

  vec3 windHoriz = vec3(uWindDir.x, 0.0, uWindDir.z);
  float horizStrength = length(windHoriz);
  vec3 windHorizN = horizStrength > 0.001 ? windHoriz / horizStrength : vec3(1.0, 0.0, 0.0);
  vec3 leafWindDir = windHorizN * horizStrength;
  leafWindDir.y += uWindDir.y * (1.0 - uLeafVertDamp);
  float leafPushAmt = sin(lp * 0.7 + 1.5);
  leafPushAmt = leafPushAmt * (1.0 - uWindBias) + uWindBias;
  flutter += leafWindDir * leafPushAmt * uWindSpeed * 0.02 * uLeafPush * leafT;

  return flutter;
}

/** Full wind for leaves: base + flutter + gust, clamped. */
vec3 computeLeafWind(vec3 pos, float weight1, float weight2, vec3 normal, float leafT, float leafPhase) {
  vec3 base = computeWindBase(pos, weight1, weight2);
  vec3 flutter = computeLeafFlutter(pos, normal, leafT, leafPhase);
  vec3 total = (base + flutter) * (1.0 + computeGust(pos));
  float len = length(total);
  if (len > uMaxSway) total *= uMaxSway / len;
  return total;
}
