#version 300 es
precision highp float;
precision highp sampler2DShadow;

#include "common.glsl"

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUV;
in vec4 vShadowCoord;
in float vFogDepth;
in float vWindWeight;

// Camera
uniform vec3 uCameraPos;

// Material
uniform vec3 uColor;

// Textures
uniform sampler2D uDiffuseMap;
uniform sampler2D uNormalMap;
uniform int uHasDiffuse;
uniform int uHasNormal;
uniform float uNormalScale;

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

// SSS
uniform vec3 uSubsurfaceColor;
uniform float uSubsurfaceStrength;

out vec4 fragColor;

void main() {
  // Flip V so leaf base (uv.y=0) maps to bottom of texture
  vec2 uv = vec2(vUV.x, 1.0 - vUV.y);

  // Alpha
  vec4 texColor = vec4(1.0);
  if (uHasDiffuse > 0) {
    texColor = texture(uDiffuseMap, uv);
  }

  // Dithered alpha discard (matches Three.js alphaToCoverage behavior)
  float noise = interleavedGradientNoise(gl_FragCoord.xy);
  if (texColor.a < noise) discard;

  // Normal (double-sided)
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;

  if (uHasNormal > 0) {
    // Leaves don't have tangent, derive TBN from UV derivatives
    vec3 dPdx = dFdx(vWorldPos);
    vec3 dPdy = dFdy(vWorldPos);
    vec2 dUVdx = dFdx(uv);
    vec2 dUVdy = dFdy(uv);
    vec3 T = normalize(dPdx * dUVdy.y - dPdy * dUVdx.y);
    vec3 B = normalize(dPdy * dUVdx.x - dPdx * dUVdy.x);
    vec3 mapN = texture(uNormalMap, uv).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    N = normalize(mat3(T, B, N) * mapN);
  }

  vec3 V = normalize(uCameraPos - vWorldPos);

  // Albedo
  vec3 albedo = uColor;
  if (uHasDiffuse > 0) {
    albedo *= texColor.rgb; // sRGB → linear via SRGB8_ALPHA8 texture format
  }

  float roughness = 0.65;

  // ── Lighting ──
  vec3 Lo = vec3(0.0);

  // Sun with shadow
  float shadow = 1.0;
  if (uShadowsEnabled > 0) {
    shadow = sampleShadowPCF(uShadowMap, vShadowCoord, uShadowBias, uShadowMapSize, uShadowSoftness);
  }
  Lo += evalDirLight(uSunDir, uSunColor, uSunIntensity, N, V, albedo, roughness) * shadow;


  // Hemisphere ambient
  float hemiW = dot(N, vec3(0.0, 1.0, 0.0)) * 0.5 + 0.5;
  vec3 ambient = mix(uGroundColor, uSkyColor, hemiW) * uAmbientIntensity * albedo * RECIPROCAL_PI;
  Lo += ambient;

  // Subsurface scattering — light-dependent, not flat
  // Estimate how much light passes through from behind
  float throughLight = max(dot(-N, uSunDir), 0.0) * uSunIntensity * shadow;
  vec3 sss = uSubsurfaceColor * uSubsurfaceStrength * throughLight * 0.15;
  Lo += sss;

  // Fog
  float fogFactor = linearFog(vFogDepth, uFogNear, uFogFar);
  Lo = mix(uFogColor, Lo, fogFactor);

  // Exposure + tone mapping
  vec3 color = ACESFilmic(Lo * uExposure);
  color = linearToSRGB(color);

  fragColor = vec4(color, texColor.a);
}
