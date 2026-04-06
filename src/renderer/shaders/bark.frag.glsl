#version 300 es
precision highp float;
precision highp sampler2DShadow;

#include "common.glsl"

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vTangent;
in vec3 vBitangent;
in vec2 vUV;
in vec4 vShadowCoord;
in float vFogDepth;

// Camera
uniform vec3 uCameraPos;

// Material
uniform vec3 uColor;
uniform float uRoughness;

// Textures
uniform sampler2D uDiffuseMap;
uniform sampler2D uNormalMap;
uniform sampler2D uAOMap;
uniform sampler2D uGlossMap;
uniform int uHasDiffuse;
uniform int uHasNormal;
uniform int uHasAO;
uniform int uHasGloss;
uniform float uNormalScale;

// Displacement / Parallax
uniform sampler2D uDisplacementMap;
uniform int uHasDisplacement;
uniform int uParallaxEnabled;
uniform float uParallaxScale;
uniform float uParallaxSteps;
uniform float uParallaxFadeNear;
uniform float uParallaxFadeFar;

// Sun
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;

// Hemisphere ambient
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbientIntensity;


// Shadow
uniform sampler2DShadow uShadowMap;
uniform float uShadowBias;
uniform float uShadowMapSize;
uniform float uShadowSoftness;
uniform int uShadowsEnabled;

// Fog
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;

// Tone mapping
uniform float uExposure;

// Debug
uniform int uDebugMode;

out vec4 fragColor;

// ── Parallax Occlusion Mapping ──
// Height map convention: 1.0 = ridge (high), 0.0 = crack (low).
// Convert to depth for ray marching: depth = 1.0 - height.
// Sample with +1.0 LOD bias to read from slightly blurred mip, reducing noise.
float sampleDepth(vec2 uv) {
  return 1.0 - textureLod(uDisplacementMap, uv, 1.0).r;
}

vec2 parallaxOcclusionMap(vec2 uv, vec3 viewDirTS, float scale, float numSteps) {
  // More layers at grazing angles for quality
  float layers = mix(numSteps * 0.5, numSteps, abs(viewDirTS.z));
  layers = max(8.0, layers);

  float layerDepth = 1.0 / layers;
  float currentDepth = 0.0;

  // UV shift per layer — clamp z to avoid explosion at grazing angles
  vec2 deltaUV = viewDirTS.xy * scale / (max(abs(viewDirTS.z), 0.25) * layers);

  vec2 currentUV = uv;
  float currentSurfaceDepth = sampleDepth(currentUV);

  // Previous step values for interpolation
  float prevSurfaceDepth = currentSurfaceDepth;
  vec2 prevUV = currentUV;

  // Steep parallax: march until ray depth exceeds surface depth
  for (float i = 0.0; i < 64.0; i += 1.0) {
    if (i >= layers || currentDepth >= currentSurfaceDepth) break;
    prevSurfaceDepth = currentSurfaceDepth;
    prevUV = currentUV;
    currentUV -= deltaUV;
    currentSurfaceDepth = sampleDepth(currentUV);
    currentDepth += layerDepth;
  }

  // Linear interpolation between the two layers bracketing the intersection
  // for smooth sub-layer precision
  float afterDepth = currentSurfaceDepth - currentDepth;
  float beforeDepth = prevSurfaceDepth - (currentDepth - layerDepth);
  float t = afterDepth / (afterDepth - beforeDepth);
  return mix(currentUV, prevUV, t);
}

void main() {
  // Build TBN matrix (needed for both normal mapping and POM)
  vec3 T = normalize(vTangent);
  vec3 B = normalize(vBitangent);
  vec3 N_geom = normalize(vNormal);
  mat3 TBN = mat3(T, B, N_geom);

  vec3 V = normalize(uCameraPos - vWorldPos);

  // Start with interpolated UVs
  vec2 uv = vUV;

  // Parallax occlusion mapping (UV offset)
  if (uParallaxEnabled > 0 && uHasDisplacement > 0) {
    float dist = length(uCameraPos - vWorldPos);
    float pomFade = 1.0 - smoothstep(uParallaxFadeNear, uParallaxFadeFar, dist);

    if (pomFade > 0.001) {
      // Transform view direction to tangent space
      vec3 viewDirTS = normalize(transpose(TBN) * V);
      float effectiveScale = uParallaxScale * pomFade;
      uv = parallaxOcclusionMap(vUV, viewDirTS, effectiveScale, uParallaxSteps);
    }
  }

  // Normal mapping (using parallax-shifted UV)
  vec3 N = N_geom;
  if (uHasNormal > 0) {
    vec3 mapN = texture(uNormalMap, uv).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    N = normalize(TBN * mapN);
  }

  // Albedo (using parallax-shifted UV)
  vec3 albedo = uColor;
  if (uHasDiffuse > 0) {
    // sRGB texture sampled via SRGB8_ALPHA8 -> linear automatically
    albedo *= texture(uDiffuseMap, uv).rgb;
  }

  // Roughness (using parallax-shifted UV)
  float roughness = uRoughness;
  if (uHasGloss > 0) {
    roughness *= (1.0 - texture(uGlossMap, uv).g);
  }
  roughness = clamp(roughness, 0.04, 1.0);

  // AO (using parallax-shifted UV)
  float ao = 1.0;
  if (uHasAO > 0) {
    ao = texture(uAOMap, uv).r;
  }

  // ── Lighting ──
  vec3 Lo = vec3(0.0);

  // Sun (with shadow)
  float shadow = 1.0;
  if (uShadowsEnabled > 0) {
    shadow = sampleShadowPCF(uShadowMap, vShadowCoord, uShadowBias, uShadowMapSize, uShadowSoftness);
  }
  Lo += evalDirLight(uSunDir, uSunColor, uSunIntensity, N, V, albedo, roughness) * shadow;


  // Hemisphere ambient
  float hemiW = dot(N, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemiW) * uAmbientIntensity * albedo * RECIPROCAL_PI;
  Lo += ambient * ao;

  // Fog (linear space)
  float fogFactor = linearFog(vFogDepth, uFogNear, uFogFar);
  Lo = mix(uFogColor, Lo, fogFactor);

  // Exposure + tone mapping
  vec3 color = ACESFilmic(Lo * uExposure);

  // Gamma
  color = linearToSRGB(color);

  // Debug views
  if (uDebugMode == 1) {
    color = vec3(fract(uv.x), fract(uv.y), 0.0);
  } else if (uDebugMode == 2) {
    color = N * 0.5 + 0.5;
  } else if (uDebugMode == 3) {
    color = normalize(vTangent) * 0.5 + 0.5;
  } else if (uDebugMode == 4) {
    color = uHasNormal > 0 ? texture(uNormalMap, uv).xyz : vec3(0.5, 0.5, 1.0);
  } else if (uDebugMode == 5) {
    color = vec3(uHasDisplacement > 0 ? texture(uDisplacementMap, vUV).r : 0.5);
  }

  fragColor = vec4(color, 1.0);
}
